import fs from "node:fs/promises"
import path from "node:path"

import {
  AuthType,
  buildCompatUserIdHeaders,
  buildCookieHeader,
  CheckinResultStatus,
  describeError,
  fetchNewApiSelf,
  isAnyrouterSiteType,
  joinUrl,
  normalizeBaseUrl,
  normalizeCookieHeaderValue,
  resolveCheckInPath,
  resolvePayloadMessage,
  resolveRewardFromData,
  type CheckinAccountResult,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"
import { chromium, type BrowserContext, type Page } from "playwright"

import type { ServerConfig } from "../config.js"
import { sanitizeFileName } from "../utils/text.js"
import { solveCloudflareChallenge } from "./flareSolverrClient.js"
import { generateGitHubTotp } from "./githubTotp.js"
import {
  matchOrDefaultSiteLoginProfile,
  type SiteLoginProfile,
} from "./siteLoginProfiles.js"

const LINUXDO_GITHUB_SELECTORS = [
  "a[href*='github']",
  "button[data-provider='github']",
  "button[title*='GitHub']",
  "a.btn-social.github",
  "button:has-text('GitHub')",
]

const LINUXDO_AUTHORIZE_SELECTORS = [
  "a:has-text('允许')",
  "button:has-text('允许')",
  "a:has-text('Allow')",
  "button:has-text('Allow')",
  "button:has-text('Authorize')",
]

const GITHUB_LOGIN_FIELD_SELECTORS = ["#login_field", "input[name='login']"]
const GITHUB_PASSWORD_SELECTORS = ["#password", "input[name='password']"]
const GITHUB_TOTP_SELECTORS = [
  "input[name='app_otp']",
  "input[autocomplete='one-time-code']",
  "#app_otp",
]
const GITHUB_SUBMIT_SELECTORS = [
  "input[name='commit']",
  "button[type='submit']",
  "input[type='submit']",
]
const GITHUB_AUTHORIZE_SELECTORS = [
  "button[name='authorize']",
  "input[name='authorize']",
  "button:has-text('Authorize')",
  "button:has-text('Allow')",
  "button:has-text('授权')",
  "input[type='submit'][value*='Authorize']",
  "input[type='submit'][value*='Allow']",
]
const AUTH_SELF_VALIDATION_ATTEMPTS = 5
const AUTH_SELF_VALIDATION_RETRY_DELAY_MS = 1_000
const RUN_ANYTIME_LINUXDO_CALLBACK_WAIT_MS = 60_000
const LINUXDO_SSO_DEADLINE_EXTENSION_MS = 120_000
const LINUXDO_CALLBACK_WAIT_MS = 20_000
const MAX_LINUXDO_SSO_RESTARTS = 1
const COOKIE_ONLY_REFRESH_HOSTS = new Set([
  "api.ouu.ch",
  "kfc-api.sxxe.net",
  "runanytime.hxi.me",
])
const OUU_SIGNATURE_ATTEMPTS = 5
const OUU_SIGNATURE_RETRY_DELAY_MS = 1_000

type TokenStorageKind = "localStorage" | "sessionStorage"

interface TokenStorageDiagnosticEntry {
  storage: TokenStorageKind
  key: string
  status: string
}

interface AccessTokenDiagnostics {
  currentUrl: string
  localStorageKeys: string[]
  sessionStorageKeys: string[]
  configuredKeyEntries: TokenStorageDiagnosticEntry[]
  tokenLikeEntries: TokenStorageDiagnosticEntry[]
  globalHints: string[]
}

export type SessionRefreshStatus =
  | "refreshed"
  | "manual_action_required"
  | "unsupported_auto_reauth"
  | "failed"

export interface SessionRefreshResult {
  status: SessionRefreshStatus
  message: string
  account?: SiteAccount
  diagnosticPath?: string
}

export interface SessionRefreshOptions {
  onProgress?: (message: string) => Promise<void> | void
}

export interface SiteSessionRefresher {
  refreshSiteSession(
    account: SiteAccount,
    options?: SessionRefreshOptions,
  ): Promise<SessionRefreshResult>
  checkInWithBrowserSession?(
    account: SiteAccount,
    options?: SessionRefreshOptions,
  ): Promise<CheckinAccountResult | null>
}

export class PlaywrightSiteSessionService implements SiteSessionRefresher {
  constructor(
    private readonly repository: StorageRepository,
    private readonly config: ServerConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async refreshSiteSession(
    account: SiteAccount,
    options: SessionRefreshOptions = {},
  ): Promise<SessionRefreshResult> {
    const profile = matchOrDefaultSiteLoginProfile(
      account.site_url,
      this.config.siteLoginProfiles,
      account.site_type,
    )
    if (!profile) {
      return {
        status: "unsupported_auto_reauth",
        message: `站点 ${new URL(account.site_url).hostname} 未配置云端自动登录 profile`,
      }
    }

    await this.reportProgress(
      options,
      `匹配到登录 profile：${new URL(account.site_url).hostname}${profile.loginPath}`,
    )

    await fs.mkdir(this.config.sharedSsoProfileDirectory, { recursive: true })
    await fs.mkdir(this.config.diagnosticsDirectory, { recursive: true })
    await this.cleanupStaleProfileLocks(this.config.sharedSsoProfileDirectory)
    await this.reportProgress(options, "已准备浏览器数据目录并清理残留锁文件")

    let context: BrowserContext | null = null
    let page: Page | null = null

    try {
      await this.reportProgress(options, "启动 Chromium 持久化上下文")
      context = await chromium.launchPersistentContext(
        this.config.sharedSsoProfileDirectory,
        {
          executablePath: this.config.chromiumExecutablePath,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          viewport: { width: 1400, height: 960 },
        },
      )
      page = context.pages()[0] ?? (await context.newPage())
      await this.reportProgress(options, "浏览器上下文已启动")

      await this.reportProgress(
        options,
        `打开站点登录页：${joinUrl(account.site_url, profile.loginPath)}`,
      )
      await page.goto(joinUrl(account.site_url, profile.loginPath), {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      })

      const flowResult = await this.completeLoginFlow(
        context,
        page,
        account,
        profile,
        options,
      )
      if (flowResult.status !== "ready") {
        const diagnosticPath = await this.captureDiagnostic(page, account)
        if (diagnosticPath) {
          await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
        }
        return {
          status:
            flowResult.status === "unsupported_auto_reauth"
              ? "unsupported_auto_reauth"
              : "manual_action_required",
          message: flowResult.message,
          diagnosticPath,
        }
      }

      await this.reportProgress(options, "目标站点已登录，开始提取会话信息")
      const refreshedAccount = await this.captureAuthenticatedAccount(
        flowResult.page,
        context,
        account,
        profile,
        options,
      )

      if (!refreshedAccount) {
        const diagnosticPath = await this.captureDiagnostic(page, account)
        if (diagnosticPath) {
          await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
        }
        return {
          status: "failed",
          message: "登录成功后未通过 /api/user/self 验证",
          diagnosticPath,
        }
      }

      await this.repository.saveAccount(refreshedAccount)
      await this.reportProgress(options, "已保存刷新后的账号认证信息")
      return {
        status: "refreshed",
        message: "站点会话已刷新",
        account: refreshedAccount,
      }
    } catch (error) {
      const diagnosticPath = page
        ? await this.captureDiagnostic(page, account)
        : undefined
      await this.reportProgress(
        options,
        `刷新流程异常：${error instanceof Error ? error.message : String(error)}`,
      )
      if (diagnosticPath) {
        await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
      }
      return {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        diagnosticPath,
      }
    } finally {
      await context?.close()
    }
  }

  async checkInWithBrowserSession(
    account: SiteAccount,
    options: SessionRefreshOptions = {},
  ): Promise<CheckinAccountResult | null> {
    const profile = matchOrDefaultSiteLoginProfile(
      account.site_url,
      this.config.siteLoginProfiles,
      account.site_type,
    )
    if (!profile) {
      return null
    }

    await this.reportProgress(options, "尝试使用浏览器会话执行签到补救")
    await fs.mkdir(this.config.sharedSsoProfileDirectory, { recursive: true })
    await fs.mkdir(this.config.diagnosticsDirectory, { recursive: true })
    await this.cleanupStaleProfileLocks(this.config.sharedSsoProfileDirectory)

    let context: BrowserContext | null = null
    let page: Page | null = null

    try {
      context = await chromium.launchPersistentContext(
        this.config.sharedSsoProfileDirectory,
        {
          executablePath: this.config.chromiumExecutablePath,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          viewport: { width: 1400, height: 960 },
        },
      )
      page = context.pages()[0] ?? (await context.newPage())

      if (this.isRunAnytimeSite(account)) {
        const injectedCookieCount = await this.seedBrowserContextWithAccountCookies(
          context,
          account,
          options,
        )
        if (injectedCookieCount > 0) {
          await this.reportProgress(
            options,
            `RunAnytime 先复用账号已有站点会话 cookie（${injectedCookieCount} 个）`,
          )
          await page.goto(joinUrl(account.site_url, resolveCheckInPath(account.site_type)), {
            waitUntil: "domcontentloaded",
            timeout: 90_000,
          })
          const capturedAccount = await this.captureAuthenticatedAccount(
            page,
            context,
            account,
            profile,
            options,
          )
          if (capturedAccount) {
            await this.repository.saveAccount(capturedAccount)
            await this.reportProgress(
              options,
              "RunAnytime 站点会话校验成功，切换为页面按钮签到流",
            )
            return await this.performBrowserSessionCheckin(
              page,
              capturedAccount,
              profile,
              options,
            )
          }

          await this.reportProgress(
            options,
            "RunAnytime 站点会话直连未通过 /api/user/self 校验，继续尝试完整 SSO",
          )
        }
      }

      await page.goto(joinUrl(account.site_url, profile.loginPath), {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      })

      const flowResult = await this.completeLoginFlow(
        context,
        page,
        account,
        profile,
        options,
      )
      if (flowResult.status !== "ready") {
        const now = Date.now()
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status:
            flowResult.status === "manual_action_required"
              ? CheckinResultStatus.ManualActionRequired
              : CheckinResultStatus.Failed,
          code: flowResult.status,
          message: flowResult.message,
          startedAt: now,
          completedAt: now,
          checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
        }
      }

      let effectiveAccount = account
      if (this.isRunAnytimeSite(account)) {
        const capturedAccount = await this.captureAuthenticatedAccount(
          flowResult.page,
          context,
          account,
          profile,
          options,
        )
        if (capturedAccount) {
          effectiveAccount = capturedAccount
          await this.repository.saveAccount(capturedAccount)
          await this.reportProgress(
            options,
            "RunAnytime 完整 SSO 后已同步站点会话，切换为页面按钮签到流",
          )
        }
      }

      return await this.performBrowserSessionCheckin(
        flowResult.page,
        effectiveAccount,
        profile,
        options,
      )
    } catch (error) {
      const now = Date.now()
      const message = describeError(error)
      if (page) {
        const diagnosticPath = await this.captureDiagnostic(page, account)
        if (diagnosticPath) {
          await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
        }
      }
      return {
        accountId: account.id,
        siteName: account.site_name,
        siteUrl: account.site_url,
        siteType: account.site_type,
        status: CheckinResultStatus.Failed,
        code: "browser_session_checkin_failed",
        message: message || "浏览器会话补签失败",
        rawMessage: message || undefined,
        startedAt: now,
        completedAt: now,
        checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
      }
    } finally {
      await context?.close()
    }
  }

  private async seedBrowserContextWithAccountCookies(
    context: BrowserContext,
    account: SiteAccount,
    options: SessionRefreshOptions,
  ): Promise<number> {
    const cookieHeader = normalizeCookieHeaderValue(
      account.cookieAuth?.sessionCookie || "",
    )
    if (!cookieHeader) {
      return 0
    }

    const targetUrl = normalizeBaseUrl(account.site_url)
    const secure = targetUrl.startsWith("https://")
    const cookies = cookieHeader
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf("=")
        if (separatorIndex <= 0) {
          return null
        }

        const name = entry.slice(0, separatorIndex).trim()
        const value = entry.slice(separatorIndex + 1).trim()
        if (!name || !value) {
          return null
        }

        return {
          name,
          value,
          url: targetUrl,
          secure,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    if (cookies.length === 0) {
      return 0
    }

    await this.reportProgress(options, `注入 ${cookies.length} 个账号会话 cookie`)
    await context.addCookies(cookies)
    return cookies.length
  }

  private async completeLoginFlow(
    context: BrowserContext,
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<
    | { status: "ready"; page: Page }
    | { status: "manual_action_required"; message: string }
    | { status: "unsupported_auto_reauth"; message: string }
  > {
    const targetHost = new URL(account.site_url).hostname.toLowerCase()
    const linuxdoHost = new URL(this.config.github.linuxdoBaseUrl).hostname.toLowerCase()
    let deadline = Date.now() + 120_000
    const visitedUrls = new Set<string>()
    const loggedSelectorDiagnostics = new Set<string>()
    const actionCooldowns = new Map<string, number>()
    const callbackWaits = new Set<string>()
    let linuxdoSsoRestartAttempts = 0
    let flareSolverrAttempts = 0
    const MAX_FLARESOLVERR_ATTEMPTS = 8

    while (Date.now() < deadline) {
      const successPage = await this.findTargetPage(context, targetHost, profile)
      if (successPage) {
        await this.reportProgress(options, `检测到目标站点已回到 ${targetHost}`)
        return { status: "ready", page: successPage }
      }

      const flowPage =
        this.pickFlowPage(context, targetHost, linuxdoHost) ?? page
      const currentUrl = flowPage.url()
      const currentHost = this.getUrlHostname(currentUrl)
      const currentTitle = await flowPage.title().catch(() => "")
      const currentPageLabel = `${currentUrl || "about:blank"}${
        currentTitle ? ` | 标题=${currentTitle}` : ""
      }`

      if (currentUrl && !visitedUrls.has(currentUrl)) {
        visitedUrls.add(currentUrl)
        await this.reportProgress(options, `当前流程页面：${currentPageLabel}`)
      }

      if (
        this.isSameOrSubdomain(currentHost, linuxdoHost) &&
        this.getUrlPathname(currentUrl).includes("/auth/failure")
      ) {
        if (currentUrl.toLowerCase().includes("message=access_denied")) {
          await this.reportProgress(
            options,
            "检测到 Linux.do 返回 access_denied，停止自动重试，避免授权页死循环",
          )
          return {
            status: "manual_action_required",
            message: "GitHub 授权被拒绝或授权页按钮未正确命中，请人工确认后重试",
          }
        }

        if (linuxdoSsoRestartAttempts >= MAX_LINUXDO_SSO_RESTARTS) {
          const failureReason =
            new URL(currentUrl).searchParams.get("message") || "unknown"
          await this.reportProgress(
            options,
            `Linux.do 认证失败已连续重试 ${linuxdoSsoRestartAttempts} 次，停止自动重试；原因=${failureReason}`,
          )
          return {
            status: "manual_action_required",
            message: `Linux.do 登录连续失败（${failureReason}），已停止自动重试`,
          }
        }

        linuxdoSsoRestartAttempts += 1
        await this.reportProgress(
          options,
          `检测到 Linux.do 认证失败页，返回站点登录页重新发起 SSO（第 ${linuxdoSsoRestartAttempts} 次）`,
        )
        deadline = Date.now() + 120_000
        visitedUrls.clear()
        loggedSelectorDiagnostics.clear()
        actionCooldowns.clear()
        callbackWaits.clear()
        flareSolverrAttempts = 0
        await flowPage.goto(joinUrl(account.site_url, profile.loginPath), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        })
        await flowPage.waitForTimeout(1_000)
        continue
      }

      if (
        this.isSameOrSubdomain(currentHost, linuxdoHost) &&
        this.getUrlPathname(currentUrl).includes("/auth/github/callback") &&
        !callbackWaits.has(currentUrl)
      ) {
        callbackWaits.add(currentUrl)
        await this.reportProgress(
          options,
          `检测到 Linux.do GitHub callback，先等待页面自行完成回跳（最多 ${RUN_ANYTIME_LINUXDO_CALLBACK_WAIT_MS / 1000} 秒）`,
        )
        await this.waitForFlowTransition(
          flowPage,
          currentUrl,
          RUN_ANYTIME_LINUXDO_CALLBACK_WAIT_MS,
        )
        continue
      }

      if (
        this.isSameOrSubdomain(currentHost, linuxdoHost) &&
        this.getUrlPathname(currentUrl).includes("/auth/github/callback") &&
        callbackWaits.has(currentUrl)
      ) {
        await this.reportProgress(
          options,
          "Linux.do GitHub callback 持续停留在质询页，停止自动重试，避免回调页循环",
        )
        return {
          status: "manual_action_required",
          message: "Linux.do GitHub callback 持续停留在质询页，已停止自动重试",
        }
      }

      if (await this.detectCloudflareChallenge(flowPage)) {
        if (flareSolverrAttempts < MAX_FLARESOLVERR_ATTEMPTS && this.config.flareSolverrUrl) {
          flareSolverrAttempts++
          if (await this.solveCloudflareWithFlareSolverr(context, flowPage, options)) {
            deadline = Math.max(
              deadline,
              Date.now() + LINUXDO_SSO_DEADLINE_EXTENSION_MS,
            )
            await this.reportProgress(
              options,
              `Cloudflare 自动破解成功，延长登录流程等待窗口 ${LINUXDO_SSO_DEADLINE_EXTENSION_MS / 1000} 秒`,
            )
            await flowPage.waitForTimeout(3_000)
            continue
          }
        }
        const cfMsg = "登录流程遇到 Cloudflare / Turnstile / CAPTCHA，需人工介入"
        await this.reportProgress(options, cfMsg)
        return { status: "manual_action_required", message: cfMsg }
      }

      if (currentHost === "github.com" && (await this.isGitHubOtpPage(flowPage))) {
        await this.reportProgress(options, "检测到 GitHub 二步验证页，提交 TOTP")
        await this.submitGitHubTotp(flowPage)
        continue
      }

      if (
        currentHost === "github.com" &&
        (await this.isGitHubLoginPage(flowPage))
      ) {
        await this.reportProgress(options, "检测到 GitHub 登录页，提交用户名和密码")
        await this.submitGitHubCredentials(flowPage)
        continue
      }

      if (currentHost === "github.com" && (await this.isGitHubTwoFactorChoicePage(flowPage))) {
        const pageElements = await this.describeVisibleActionTexts(flowPage)
        const pageInputs = await flowPage
          .locator("input")
          .evaluateAll((els) =>
            els
              .map((e) => {
                const input = e as HTMLInputElement
                return `${input.type}[name=${input.name}]`
              })
              .slice(0, 8)
              .join(", "),
          )
          .catch(() => "")
        await this.reportProgress(
          options,
          `GitHub 2FA 页面诊断；按钮=${pageElements}；输入框=${pageInputs || "无"}；URL=${this.getUrlPathname(flowPage.url())}`,
        )
        const clicked = await this.clickFirstVisible(flowPage, [
          "a[href*='two-factor/app']",
          "button:has-text('authenticator')",
          "a:has-text('authenticator')",
          "a:has-text('Use your authenticator app')",
        ])
        if (clicked) {
          await this.reportProgress(options, "已点击 Authenticator 入口")
          await flowPage.waitForLoadState("domcontentloaded").catch(() => undefined)
        } else {
          await this.reportProgress(options, "未找到 Authenticator 入口，等待 3 秒")
          await flowPage.waitForTimeout(3_000)
        }
        continue
      }

      if (
        currentHost === "github.com" &&
        (await this.clickFirstVisibleWithPopup(context, flowPage, GITHUB_AUTHORIZE_SELECTORS))
      ) {
        await this.reportProgress(options, "检测到 GitHub 授权确认页，提交授权")
        continue
      }

      const challengeMessage = await this.detectManualChallenge(flowPage)
      if (challengeMessage) {
        await this.reportProgress(options, challengeMessage)
        return {
          status: "manual_action_required",
          message: challengeMessage,
        }
      }

      if (this.isSameOrSubdomain(currentHost, linuxdoHost)) {
        await this.dismissCommonOverlays(flowPage)
        if (await this.clickFirstVisible(flowPage, LINUXDO_AUTHORIZE_SELECTORS)) {
          await this.reportProgress(options, "检测到 Linux.do Connect 授权页，点击允许")
          await flowPage.waitForLoadState("domcontentloaded").catch(() => undefined)
          continue
        }
        const linuxdoGitHubActionKey = `${currentUrl}::linuxdo-github`
        if (
          this.canAttemptFlowAction(actionCooldowns, linuxdoGitHubActionKey) &&
          await this.clickFirstVisibleWithPopup(
            context,
            flowPage,
            LINUXDO_GITHUB_SELECTORS,
          )
        ) {
          this.markFlowActionAttempt(
            actionCooldowns,
            linuxdoGitHubActionKey,
            8_000,
          )
          await this.reportProgress(options, "检测到 Linux.do 授权页，点击 GitHub 登录入口")
          await this.waitForFlowTransition(flowPage, currentUrl, 8_000)
          continue
        }

        if (!loggedSelectorDiagnostics.has(currentUrl)) {
          loggedSelectorDiagnostics.add(currentUrl)
          await this.reportProgress(
            options,
            `Linux.do 页面未命中 GitHub 入口；可见按钮=${await this.describeVisibleActionTexts(flowPage)}`,
          )
        }
        await flowPage.waitForTimeout(1_000)
        continue
      }

      if (currentHost === targetHost) {
        await this.dismissCommonOverlays(flowPage)
        if (this.isRunAnytimeSite(account) && this.getUrlPathname(currentUrl).includes("/login")) {
          const ready = await this.prepareRunAnytimeLoginPage(
            context,
            flowPage,
            options,
          )
          if (!ready) {
            return {
              status: "manual_action_required",
              message: "RunAnytime 登录页验证未完成，需人工介入",
            }
          }
        }
        if (
          await this.clickFirstVisibleWithPopup(
            context,
            flowPage,
            profile.loginButtonSelectors,
          )
        ) {
          await this.reportProgress(options, "已点击站点登录入口，等待 SSO 跳转")
          continue
        }

        if (!loggedSelectorDiagnostics.has(currentUrl)) {
          loggedSelectorDiagnostics.add(currentUrl)
          await this.reportProgress(
            options,
            `站点页面未命中登录入口；可见按钮=${await this.describeVisibleActionTexts(flowPage)}`,
          )
        }
      }

      await flowPage.waitForTimeout(1_000)
    }

    return {
      status: "manual_action_required",
      message: "登录流程超时，未能完成 Linux.do / GitHub SSO",
    }
  }

  private canAttemptFlowAction(
    actionCooldowns: Map<string, number>,
    actionKey: string,
  ): boolean {
    const notBefore = actionCooldowns.get(actionKey) ?? 0
    return Date.now() >= notBefore
  }

  private markFlowActionAttempt(
    actionCooldowns: Map<string, number>,
    actionKey: string,
    cooldownMs: number,
  ): void {
    actionCooldowns.set(actionKey, Date.now() + cooldownMs)
  }

  private async waitForFlowTransition(
    page: Page,
    currentUrl: string,
    timeoutMs: number,
  ): Promise<void> {
    await page
      .waitForURL((url) => url.toString() !== currentUrl, {
        timeout: timeoutMs,
        waitUntil: "domcontentloaded",
      })
      .catch(() => undefined)
  }

  private async captureAuthenticatedAccount(
    page: Page,
    context: BrowserContext,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<SiteAccount | null> {
    const targetBaseUrl = normalizeBaseUrl(account.site_url)
    const captureUrl = this.resolvePostLoginCaptureUrl(account)
    const currentUrl = page.url()
    const currentPath = this.getUrlPathname(currentUrl)
    if (
      this.getUrlHostname(currentUrl) !== new URL(targetBaseUrl).hostname ||
      currentPath.includes("/login") ||
      currentPath.includes("/auth")
    ) {
      await this.reportProgress(options, `返回目标站点页面：${captureUrl}`)
      await page.goto(captureUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
    }

    await this.ensureOuuWarnScriptSignature(page, account, options)
    await this.reportProgress(options, "提取 cookie 与 access token")
    await this.reportProgress(options, "调用 /api/user/self 校验登录状态")
    const synced = await this.validateAuthenticatedAccount(
      page,
      context,
      account,
      profile,
      options,
    )

    if (!synced?.account) {
      await this.reportProgress(options, "/api/user/self 校验失败")
      return null
    }

    await this.reportProgress(options, "/api/user/self 校验成功")
    const finalAccessToken =
      synced.snapshot.account_info.access_token ||
      synced.account.account_info.access_token ||
      ""
    const finalAuthType = finalAccessToken
      ? AuthType.AccessToken
      : synced.snapshot.cookieAuth?.sessionCookie
        ? AuthType.Cookie
        : synced.account.authType

    return {
      ...synced.account,
      updated_at: synced.snapshot.updated_at,
      last_sync_time: synced.snapshot.last_sync_time,
      authType: finalAuthType,
      account_info: {
        ...synced.account.account_info,
        access_token: finalAccessToken,
      },
      cookieAuth: synced.snapshot.cookieAuth,
    }
  }

  private async buildAuthenticatedAccountSnapshot(
    context: BrowserContext,
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
  ): Promise<SiteAccount> {
    const targetBaseUrl = normalizeBaseUrl(account.site_url)
    const cookieHeader = await this.buildMergedCookieHeader(
      context,
      page,
      targetBaseUrl,
    )
    const accessToken = await this.extractAccessToken(page, profile)
    const now = Date.now()

    return {
      ...account,
      updated_at: now,
      last_sync_time: now,
      authType: accessToken
        ? AuthType.AccessToken
        : cookieHeader
          ? AuthType.Cookie
          : account.authType,
      account_info: {
        ...account.account_info,
        access_token: accessToken,
      },
      cookieAuth: cookieHeader ? { sessionCookie: cookieHeader } : account.cookieAuth,
    }
  }

  private async buildMergedCookieHeader(
    context: BrowserContext,
    page: Page,
    targetBaseUrl: string,
  ): Promise<string> {
    const networkCookieHeader = buildCookieHeader(await context.cookies([targetBaseUrl]))
    const documentCookieHeader = await this.readDocumentCookieHeader(page)

    return this.mergeCookieHeaders(networkCookieHeader, documentCookieHeader)
  }

  private async readDocumentCookieHeader(page: Page): Promise<string> {
    return await page
      .evaluate(() => document.cookie || "")
      .then((value) => normalizeCookieHeaderValue(String(value)))
      .catch(() => "")
  }

  private mergeCookieHeaders(...headers: string[]): string {
    const cookieMap = new Map<string, string>()

    for (const header of headers) {
      const normalized = normalizeCookieHeaderValue(header)
      if (!normalized) {
        continue
      }

      for (const segment of normalized.split(";")) {
        const trimmed = segment.trim()
        if (!trimmed) {
          continue
        }

        const separatorIndex = trimmed.indexOf("=")
        if (separatorIndex <= 0) {
          continue
        }

        const key = trimmed.slice(0, separatorIndex).trim()
        const value = trimmed.slice(separatorIndex + 1).trim()
        if (!key || !value) {
          continue
        }

        cookieMap.set(key, value)
      }
    }

    return Array.from(cookieMap.entries())
      .map(([key, value]) => `${key}=${value}`)
      .join("; ")
  }

  private async validateAuthenticatedAccount(
    page: Page,
    context: BrowserContext,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<{ account: SiteAccount; snapshot: SiteAccount } | null> {
    let lastCookieOnlySession: { account: SiteAccount; snapshot: SiteAccount } | null = null
    const allowCookieOnlySession =
      isAnyrouterSiteType(account.site_type) || this.isCookieOnlyRefreshAllowed(account)

    for (let attempt = 1; attempt <= AUTH_SELF_VALIDATION_ATTEMPTS; attempt += 1) {
      const snapshot = await this.buildAuthenticatedAccountSnapshot(
        context,
        page,
        account,
        profile,
      )
      const synced = await fetchNewApiSelf({
        account: snapshot,
        fetchImpl: this.fetchImpl,
      })

      if (synced) {
        const token =
          snapshot.account_info.access_token.trim() ||
          synced.account_info.access_token.trim()
        if (token || allowCookieOnlySession) {
          return {
            account: synced,
            snapshot,
          }
        }

        lastCookieOnlySession = {
          account: synced,
          snapshot,
        }
      }

      if (attempt < AUTH_SELF_VALIDATION_ATTEMPTS) {
        await page.waitForTimeout(AUTH_SELF_VALIDATION_RETRY_DELAY_MS)
      }
    }

    if (lastCookieOnlySession) {
      await this.reportAccessTokenDiagnostics(page, profile, options)
      throw new Error("登录成功但未提取到 access token")
    }

    return null
  }

  private async ensureOuuWarnScriptSignature(
    page: Page,
    account: SiteAccount,
    options: SessionRefreshOptions,
  ): Promise<void> {
    if (!this.isOuuSite(account)) {
      return
    }

    const state = await page
      .evaluate(() => {
        const footerHtml = localStorage.getItem("footer_html") || ""
        const warnSvg = document.querySelector('svg[onload*="newapiwarn"]')
        const warnScript = document.querySelector(
          'script[src*="/newapiwarn/warnassets/script.js"]',
        )
        const hasSignatureCookie = document.cookie
          .split(";")
          .map((entry) => entry.trim())
          .some((entry) => entry.startsWith("signature="))

        return {
          footerHtml,
          hasWarnSvg: Boolean(warnSvg),
          hasWarnScriptTag: Boolean(warnScript),
          hasSignatureCookie,
        }
      })
      .catch(() => ({
        footerHtml: "",
        hasWarnSvg: false,
        hasWarnScriptTag: false,
        hasSignatureCookie: false,
      }))

    if (
      !state.footerHtml ||
      !state.hasWarnSvg ||
      state.hasWarnScriptTag ||
      state.hasSignatureCookie
    ) {
      return
    }

    await this.reportProgress(
      options,
      "检测到 Ouu newapiwarn SVG 已渲染但未触发，手工注入签名脚本",
    )

    await page
      .evaluate(async () => {
        const existing = document.querySelector('script[data-ouu-probe="warn-manual"]')
        if (existing) {
          return
        }

        await new Promise<void>((resolve) => {
          const script = document.createElement("script")
          script.src = "/newapiwarn/warnassets/script.js"
          script.setAttribute("data-ouu-probe", "warn-manual")
          script.onload = () => resolve()
          script.onerror = () => resolve()
          document.head.appendChild(script)
        })
      })
      .catch(() => undefined)

    await this.reportProgress(options, "已注入 Ouu newapiwarn 脚本，等待 signature cookie")

    for (let attempt = 1; attempt <= OUU_SIGNATURE_ATTEMPTS; attempt += 1) {
      const hasSignatureCookie = await page
        .evaluate(() =>
          document.cookie
            .split(";")
            .map((entry) => entry.trim())
            .some((entry) => entry.startsWith("signature=")),
        )
        .catch(() => false)

      if (hasSignatureCookie) {
        await this.reportProgress(options, "已观察到 Ouu signature cookie")
        return
      }

      if (attempt < OUU_SIGNATURE_ATTEMPTS) {
        await page.waitForTimeout(OUU_SIGNATURE_RETRY_DELAY_MS)
      }
    }

    await this.reportProgress(
      options,
      "仍未观察到 Ouu signature cookie，继续使用当前会话尝试后续校验",
    )
  }

  private isCookieOnlyRefreshAllowed(account: SiteAccount): boolean {
    try {
      return COOKIE_ONLY_REFRESH_HOSTS.has(
        new URL(account.site_url).hostname.toLowerCase(),
      )
    } catch {
      return false
    }
  }

  private isOuuSite(account: SiteAccount): boolean {
    try {
      return new URL(account.site_url).hostname.toLowerCase() === "api.ouu.ch"
    } catch {
      return false
    }
  }

  private async prepareRunAnytimeLoginPage(
    context: BrowserContext,
    page: Page,
    options: SessionRefreshOptions,
  ): Promise<boolean> {
    if (await this.isRunAnytimeLoginReady(page)) {
      await this.reportProgress(
        options,
        "RunAnytime 登录页验证已就绪，准备点击 Continue with LinuxDO",
      )
      return true
    }

    await this.reportProgress(
      options,
      "RunAnytime 登录页验证尚未就绪，尝试预热站点验证状态",
    )

    if (this.config.flareSolverrUrl) {
      const solved = await this.solveCloudflareWithFlareSolverr(
        context,
        page,
        options,
      )
      if (solved) {
        await page.waitForTimeout(5_000)
        if (await this.isRunAnytimeLoginReady(page)) {
          await this.reportProgress(
            options,
            "RunAnytime 登录页验证预热完成，准备点击 Continue with LinuxDO",
          )
          return true
        }
      }
    }

    await page.waitForTimeout(5_000)
    if (await this.isRunAnytimeLoginReady(page)) {
      await this.reportProgress(
        options,
        "RunAnytime 登录页验证延迟就绪，准备点击 Continue with LinuxDO",
      )
      return true
    }

    await this.reportProgress(
      options,
      "RunAnytime 登录页仍未完成站点验证，暂停自动登录",
    )
    return false
  }

  private async isRunAnytimeLoginReady(page: Page): Promise<boolean> {
    return await page
      .evaluate(() => {
        const turnstileField = document.querySelector(
          'input[name=\"cf-turnstile-response\"], textarea[name=\"cf-turnstile-response\"]',
        ) as HTMLInputElement | HTMLTextAreaElement | null
        const hasLinuxdoButton = Array.from(document.querySelectorAll("button"))
          .some((button) =>
            /continue with linuxdo/i.test(button.textContent || ""),
          )
        const hasTurnstileFrame = Array.from(document.querySelectorAll("iframe"))
          .some((frame) =>
            (frame.getAttribute("src") || "").includes("challenges.cloudflare.com"),
          )

        if (!hasLinuxdoButton) {
          return false
        }

        if (!hasTurnstileFrame) {
          return true
        }

        return Boolean(turnstileField?.value?.trim())
      })
      .catch(() => false)
  }

  private resolvePostLoginCaptureUrl(account: SiteAccount): string {
    if (this.isCookieOnlyRefreshAllowed(account)) {
      return joinUrl(account.site_url, resolveCheckInPath(account.site_type))
    }

    return normalizeBaseUrl(account.site_url)
  }

  private async performBrowserSessionCheckin(
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<CheckinAccountResult> {
    const startedAt = Date.now()
    const targetBaseUrl = normalizeBaseUrl(account.site_url)
    const checkInUrl = joinUrl(account.site_url, resolveCheckInPath(account.site_type))
    const apiUrl = joinUrl(targetBaseUrl, "/api/user/checkin")
    const currentUrl = page.url()
    const currentPath = this.getUrlPathname(currentUrl)
    if (
      this.getUrlHostname(currentUrl) !== new URL(targetBaseUrl).hostname ||
      currentPath.includes("/login") ||
      currentPath.includes("/auth")
    ) {
      await this.reportProgress(options, `返回目标站点主页：${targetBaseUrl}`)
      await page.goto(targetBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
    }
    if (page.url() !== checkInUrl) {
      await this.reportProgress(options, `打开签到页：${checkInUrl}`)
      await page.goto(checkInUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
    }

    if (this.isRunAnytimeSite(account)) {
      await this.reportProgress(
        options,
        "检测到 RunAnytime 已登录页面，直接执行页面内 PoW 签到流",
      )
      return await this.performRunAnytimePowCheckin(page, account, profile, options)
    }

    await this.reportProgress(options, "使用浏览器上下文点击签到按钮")

    try {
      let lastObservedUrl = page.url()
      const pageState = {
        pageClosed: false,
        pageCrashed: false,
        contextClosed: false,
      }
      const pageWithEvents = page as Page & {
        on?: (event: string, listener: (...args: unknown[]) => void) => unknown
      }
      const contextWithEvents = (typeof (page as Page & { context?: () => BrowserContext }).context === "function"
        ? (page as Page & { context: () => BrowserContext }).context()
        : null) as (BrowserContext & {
        on?: (event: string, listener: (...args: unknown[]) => void) => unknown
      }) | null

      pageWithEvents.on?.("close", () => {
        pageState.pageClosed = true
        void this.reportProgress(
          options,
          `诊断：页面已关闭；最后 URL=${lastObservedUrl}`,
        )
      })
      pageWithEvents.on?.("crash", () => {
        pageState.pageCrashed = true
        void this.reportProgress(
          options,
          `诊断：页面已崩溃；最后 URL=${lastObservedUrl}`,
        )
      })
      contextWithEvents?.on?.("close", () => {
        pageState.contextClosed = true
        void this.reportProgress(options, "诊断：浏览器上下文已关闭")
      })

      const shouldNormalizeHeaders = !this.isRunAnytimeSite(account)
      const routePattern = "**/api/user/checkin*"
      if (shouldNormalizeHeaders) {
        await page.route(routePattern, async (route, request) => {
          await route.continue({
            headers: this.buildBrowserSessionCheckinHeaders(request.headers()),
          })
        })
      }

      let browserResponse:
        | { statusCode: number; rawText: string; requestUrl?: string }
        | null = null
      try {
        lastObservedUrl = page.url()
        await this.reportProgress(
          options,
          `准备等待签到请求响应；当前 URL=${lastObservedUrl}`,
        )
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().startsWith(apiUrl) &&
            (!this.isRunAnytimeSite(account) ||
              !response.url().toLowerCase().includes("turnstile=")) &&
            response.request().method().toUpperCase() === "POST",
          { timeout: 15_000 },
        )
        const runAnytimeFollowupResponsePromise = this.isRunAnytimeSite(account)
          ? page
              .waitForResponse(
                (response) =>
                  response.url().startsWith(apiUrl) &&
                  response.url().toLowerCase().includes("turnstile=") &&
                  response.request().method().toUpperCase() === "POST",
                { timeout: 30_000 },
              )
              .catch(() => null)
          : null

        lastObservedUrl = page.url()
        await this.reportProgress(
          options,
          `准备点击签到按钮；当前 URL=${lastObservedUrl}`,
        )
        let clicked = false
        try {
          clicked = this.isRunAnytimeSite(account)
            ? await this.clickRunAnytimeCheckinButton(page, options)
            : await this.clickFirstVisible(page, [
                "button:has-text('Check in now')",
                "button:has-text('check in now')",
                "button:has-text('Check In Now')",
                "button:has-text('立即签到')",
              ])
        } catch (error) {
          await this.reportProgress(
            options,
            `点击签到按钮异常：${describeError(error)}；pageClosed=${pageState.pageClosed} pageCrashed=${pageState.pageCrashed} contextClosed=${pageState.contextClosed} 最后URL=${lastObservedUrl}`,
          )
          throw error
        }

        if (!clicked) {
          throw new Error("未找到签到按钮")
        }

        lastObservedUrl = page.url()
        await this.reportProgress(
          options,
          `签到按钮点击完成；当前 URL=${lastObservedUrl}`,
        )

        let response
        try {
          response = await responsePromise
        } catch (error) {
          lastObservedUrl = pageState.pageClosed || pageState.pageCrashed
            ? lastObservedUrl
            : page.url()
          await this.reportProgress(
            options,
            `等待首个签到响应异常：${describeError(error)}；pageClosed=${pageState.pageClosed} pageCrashed=${pageState.pageCrashed} contextClosed=${pageState.contextClosed} 当前URL=${lastObservedUrl}`,
          )
          throw error
        }
        browserResponse = {
          statusCode: response.status(),
          rawText: await response.text().catch(() => ""),
          requestUrl: response.url(),
        }
        await this.reportProgress(
          options,
          `已捕获首个签到响应：${browserResponse.requestUrl || "<unknown>"}；HTTP ${browserResponse.statusCode}`,
        )

        const firstPayload = this.tryParseJsonRecord(browserResponse.rawText)
        const firstMessage = resolvePayloadMessage(firstPayload, browserResponse.rawText)
        if (
          this.isRunAnytimeSite(account) &&
          firstMessage.includes("Turnstile token 为空") &&
          runAnytimeFollowupResponsePromise
        ) {
          await this.reportProgress(
            options,
            "检测到首次签到响应要求 Turnstile，等待浏览器完成后续验证",
          )
          const pageContext =
            typeof (page as Page & { context?: () => BrowserContext }).context ===
            "function"
              ? (page as Page & { context: () => BrowserContext }).context()
              : null

          if (pageContext && this.config.flareSolverrUrl) {
            await this.reportProgress(
              options,
              "RunAnytime 个人页正在尝试预热 Turnstile 验证状态",
            )
            const solved = await this.solveCloudflareWithFlareSolverr(
              pageContext,
              page,
              options,
            )
            if (solved) {
              await page.waitForTimeout(5_000).catch(() => undefined)
            }
          }

          let followupResponse = await runAnytimeFollowupResponsePromise
          if (!followupResponse) {
            await this.reportProgress(
              options,
              "未捕获到 Turnstile 后续请求，尝试再次点击签到按钮",
            )
            const retryResponsePromise = page
              .waitForResponse(
                (response) =>
                  response.url().startsWith(apiUrl) &&
                  response.url().toLowerCase().includes("turnstile=") &&
                  response.request().method().toUpperCase() === "POST",
                { timeout: 30_000 },
              )
              .catch(() => null)

            const retryClicked = this.isRunAnytimeSite(account)
              ? await this.clickRunAnytimeCheckinButton(page, options)
              : await this.clickFirstVisible(page, [
                  "button:has-text('Check in now')",
                  "button:has-text('check in now')",
                  "button:has-text('Check In Now')",
                  "button:has-text('立即签到')",
                ])
            if (retryClicked) {
              followupResponse = await retryResponsePromise
            }
          }

          if (!followupResponse && browserResponse.requestUrl) {
            await this.reportProgress(
              options,
              "尝试从页面中提取 Turnstile token 并手动补发第二次签到请求",
            )
            const manualFollowup = await this.performRunAnytimeTurnstileFollowup(
              page,
              account,
              browserResponse.requestUrl,
            )
            if (manualFollowup) {
              browserResponse = manualFollowup
            }
          }

          if (followupResponse) {
            browserResponse = {
              statusCode: followupResponse.status(),
              rawText: await followupResponse.text().catch(() => ""),
              requestUrl: followupResponse.url(),
            }
          } else {
            await this.reportProgress(
              options,
              "Turnstile 后续请求仍未出现，保留首次响应结果",
            )
          }
        }
      } finally {
        if (shouldNormalizeHeaders) {
          await page.unroute(routePattern).catch(() => undefined)
        }
      }

      if (!browserResponse) {
        throw new Error("浏览器会话未捕获到签到请求响应")
      }

      const payload = this.tryParseJsonRecord(browserResponse.rawText)
      const message = resolvePayloadMessage(payload, browserResponse.rawText)
      const isSuccess = payload?.success === true

      if (isSuccess) {
        const reward = resolveRewardFromData(payload?.data)
        const fullMessage =
          reward && !message.includes(reward)
            ? `${message || "签到成功"}，${reward}；已通过浏览器会话补签`
            : `${message || "签到成功"}；已通过浏览器会话补签`
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Success,
          message: fullMessage,
          rawMessage: message || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (this.isAlreadyCheckedMessage(message)) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.AlreadyChecked,
          message: `${message || "今天已经签到"}；已通过浏览器会话校验`,
          rawMessage: message || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (
        this.isManualActionRequiredMessage(message) ||
        browserResponse.rawText.toLowerCase().includes("cloudflare")
      ) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.ManualActionRequired,
          code: "turnstile_required",
          message: message || "需要人工完成验证后重试",
          rawMessage: message || browserResponse.rawText || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (
        browserResponse.statusCode === 401 ||
        browserResponse.statusCode === 403
      ) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Failed,
          code: "auth_invalid",
          message: message || "认证失效，请重新登录",
          rawMessage: message || browserResponse.rawText || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      return {
        accountId: account.id,
        siteName: account.site_name,
        siteUrl: account.site_url,
        siteType: account.site_type,
        status: CheckinResultStatus.Failed,
        code: "checkin_failed",
        message: message || `签到失败，HTTP ${browserResponse.statusCode}`,
        rawMessage: message || browserResponse.rawText || undefined,
        startedAt,
        completedAt: Date.now(),
        checkInUrl,
      }
    } catch (error) {
      const message = describeError(error)
      return {
        accountId: account.id,
        siteName: account.site_name,
        siteUrl: account.site_url,
        siteType: account.site_type,
        status: CheckinResultStatus.Failed,
        code: "network_error",
        message: message || "浏览器会话请求失败",
        rawMessage: message || undefined,
        startedAt,
        completedAt: Date.now(),
        checkInUrl,
      }
    }
  }

  private async performRunAnytimePowCheckin(
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<CheckinAccountResult> {
    const startedAt = Date.now()
    const checkInUrl = joinUrl(account.site_url, resolveCheckInPath(account.site_type))
    const extractedAccessToken = await this.extractAccessToken(page, profile).catch(
      () => "",
    )

    await this.reportProgress(options, "检测到 RunAnytime 站点，直接执行 PoW 签到协议")
    await this.reportProgress(
      options,
      extractedAccessToken
        ? "RunAnytime 页面已提取到 access token，优先使用 token + cookie 直签"
        : "RunAnytime 页面未提取到 access token，先使用 cookie 直签",
    )

    try {
      const browserResult = await page.evaluate(
        async ({
          fallbackUserId,
          fallbackAccessToken,
        }: {
          fallbackUserId: string
          fallbackAccessToken: string
        }) => {
          const resolvedUserId =
            fallbackUserId ||
            document.body?.innerText.match(/ID:\\s*(\\d+)/u)?.[1] ||
            ""
          const resolvedAccessToken = fallbackAccessToken.trim()

          const headers: Record<string, string> = {
            accept: "application/json, text/plain, */*",
            "cache-control": "no-store",
            "new-api-user": resolvedUserId,
          }
          if (resolvedAccessToken) {
            headers.Authorization = `Bearer ${resolvedAccessToken}`
          }

          const parseJson = async (response: Response) => {
            const rawText = await response.text()
            let payload: Record<string, unknown> | null = null
            try {
              payload = JSON.parse(rawText) as Record<string, unknown>
            } catch {
              payload = null
            }

            return {
              statusCode: response.status,
              rawText,
              payload,
            }
          }

          const challengeResponse = await fetch(
            "/api/user/pow/challenge?action=checkin",
            {
              method: "GET",
              credentials: "include",
              headers,
            },
          )
          const challenge = await parseJson(challengeResponse)

          if (
            !challenge.payload?.success ||
            !challenge.payload?.data ||
            typeof challenge.payload.data !== "object"
          ) {
            return {
              challenge,
              checkin: null,
              solved: null,
            }
          }

          const challengeData = challenge.payload.data as Record<string, unknown>
          const challengeId =
            typeof challengeData.challenge_id === "string"
              ? challengeData.challenge_id
              : ""
          const prefix =
            typeof challengeData.prefix === "string" ? challengeData.prefix : ""
          const difficulty =
            typeof challengeData.difficulty === "number"
              ? challengeData.difficulty
              : Number(challengeData.difficulty)

          if (!challengeId || !prefix || !Number.isFinite(difficulty)) {
            return {
              challenge,
              checkin: null,
              solved: null,
            }
          }

          const solved = await new Promise<{ nonce: string; attempts: number }>(
            (resolve, reject) => {
              const workerSource = `
                function meetsDifficulty(bytes, difficulty) {
                  if (difficulty <= 0) return true;
                  const fullBytes = Math.floor(difficulty / 8);
                  const remainingBits = difficulty % 8;
                  for (let i = 0; i < fullBytes && i < bytes.length; i += 1) {
                    if (bytes[i] !== 0) return false;
                  }
                  if (remainingBits > 0 && fullBytes < bytes.length) {
                    const mask = 255 << (8 - remainingBits);
                    if (bytes[fullBytes] & mask) return false;
                  }
                  return true;
                }
                function formatNonce(value) {
                  return value.toString(16).padStart(8, "0");
                }
                self.onmessage = async function(event) {
                  const { prefix, difficulty } = event.data;
                  let attempt = 0;
                  try {
                    for (;;) {
                      const nonce = formatNonce(attempt);
                      const bytes = new TextEncoder().encode(prefix + nonce);
                      const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
                      const hash = new Uint8Array(hashBuffer);
                      if (meetsDifficulty(hash, difficulty)) {
                        self.postMessage({ type: "solved", nonce, attempts: attempt + 1 });
                        return;
                      }
                      attempt += 1;
                      if (attempt > 4294967295) {
                        self.postMessage({ type: "error", message: "Max attempts reached" });
                        return;
                      }
                    }
                  } catch (error) {
                    self.postMessage({
                      type: "error",
                      message: error && typeof error === "object" && "message" in error
                        ? String(error.message)
                        : String(error),
                    });
                  }
                };
              `

              const blob = new Blob([workerSource], { type: "text/javascript" })
              const worker = new Worker(URL.createObjectURL(blob))

              worker.onmessage = (event: MessageEvent) => {
                const data = event.data as
                  | { type: "solved"; nonce: string; attempts: number }
                  | { type: "error"; message?: string }
                worker.terminate()

                if (data.type === "solved") {
                  resolve({ nonce: data.nonce, attempts: data.attempts })
                  return
                }

                reject(new Error(data.message || "PoW calculation failed"))
              }

              worker.onerror = (event: ErrorEvent) => {
                worker.terminate()
                reject(new Error(event.message || "PoW worker failed"))
              }

              worker.postMessage({ prefix, difficulty })
            },
          )

          const url = new URL("/api/user/checkin", location.origin)
          url.searchParams.set("pow_challenge", challengeId)
          url.searchParams.set("pow_nonce", solved.nonce)

          const checkinResponse = await fetch(url.toString(), {
            method: "POST",
            credentials: "include",
            headers,
          })

          return {
            challenge,
            solved,
            checkin: await parseJson(checkinResponse),
          }
        },
        {
          fallbackUserId:
            account.account_info.id > 0 ? String(account.account_info.id) : "",
          fallbackAccessToken: extractedAccessToken,
        },
      )

      const checkinResponse = browserResult.checkin
      if (!checkinResponse) {
        const challengeMessage = resolvePayloadMessage(
          browserResult.challenge?.payload ?? null,
          browserResult.challenge?.rawText ?? "",
        )
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Failed,
          code: "browser_pow_challenge_failed",
          message: challengeMessage || "RunAnytime PoW 挑战初始化失败",
          rawMessage: browserResult.challenge?.rawText || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      const payload = checkinResponse.payload
      const message = resolvePayloadMessage(payload, checkinResponse.rawText)
      const isSuccess = payload?.success === true

      if (isSuccess) {
        const reward = resolveRewardFromData(payload?.data)
        const fullMessage =
          reward && !message.includes(reward)
            ? `${message || "签到成功"}，${reward}；已通过浏览器会话补签`
            : `${message || "签到成功"}；已通过浏览器会话补签`
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Success,
          message: fullMessage,
          rawMessage: message || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (this.isAlreadyCheckedMessage(message)) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.AlreadyChecked,
          message: `${message || "今天已经签到"}；已通过浏览器会话校验`,
          rawMessage: message || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (
        this.isManualActionRequiredMessage(message) ||
        checkinResponse.rawText.toLowerCase().includes("cloudflare")
      ) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.ManualActionRequired,
          code: "turnstile_required",
          message: message || "需要人工完成验证后重试",
          rawMessage: message || checkinResponse.rawText || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      if (checkinResponse.statusCode === 401 || checkinResponse.statusCode === 403) {
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Failed,
          code: "auth_invalid",
          message: message || "认证失效，请重新登录",
          rawMessage: message || checkinResponse.rawText || undefined,
          startedAt,
          completedAt: Date.now(),
          checkInUrl,
        }
      }

      return {
        accountId: account.id,
        siteName: account.site_name,
        siteUrl: account.site_url,
        siteType: account.site_type,
        status: CheckinResultStatus.Failed,
        code: "checkin_failed",
        message: message || `签到失败，HTTP ${checkinResponse.statusCode}`,
        rawMessage: message || checkinResponse.rawText || undefined,
        startedAt,
        completedAt: Date.now(),
        checkInUrl,
      }
    } catch (error) {
      const message = describeError(error)
      return {
        accountId: account.id,
        siteName: account.site_name,
        siteUrl: account.site_url,
        siteType: account.site_type,
        status: CheckinResultStatus.Failed,
        code: "browser_pow_checkin_failed",
        message: message || "RunAnytime PoW 签到失败",
        rawMessage: message || undefined,
        startedAt,
        completedAt: Date.now(),
        checkInUrl,
      }
    }
  }

  private async performRunAnytimeTurnstileFollowup(
    page: Page,
    account: SiteAccount,
    requestUrl: string,
  ): Promise<{ statusCode: number; rawText: string; requestUrl: string } | null> {
    const extractedAccessToken = await this.extractAccessToken(page, {
      hostname: "runanytime.hxi.me",
      loginPath: "/login",
      loginButtonSelectors: [],
      successUrlPatterns: ["/console"],
      tokenStorageKeys: ["user", "token", "access_token"],
      postLoginSelectors: [],
    }).catch(() => "")

    return await page
      .evaluate(
        async ({
          requestUrl,
          fallbackUserId,
          fallbackAccessToken,
        }: {
          requestUrl: string
          fallbackUserId: string
          fallbackAccessToken: string
        }) => {
          const waitForTurnstileToken = async (): Promise<string> => {
            const startedAt = Date.now()
            while (Date.now() - startedAt < 30_000) {
              const tokenField = document.querySelector(
                'input[name=\"cf-turnstile-response\"], textarea[name=\"cf-turnstile-response\"]',
              ) as HTMLInputElement | HTMLTextAreaElement | null
              const token = tokenField?.value?.trim() || ""
              if (token) {
                return token
              }
              await new Promise((resolve) => setTimeout(resolve, 1_000))
            }
            return ""
          }

          const turnstileToken = await waitForTurnstileToken()
          if (!turnstileToken) {
            return null
          }

          const firstUrl = new URL(requestUrl)
          const secondUrl = new URL("/api/user/checkin", location.origin)
          secondUrl.searchParams.set("turnstile", turnstileToken)

          const powChallenge = firstUrl.searchParams.get("pow_challenge")
          const powNonce = firstUrl.searchParams.get("pow_nonce")
          if (powChallenge) {
            secondUrl.searchParams.set("pow_challenge", powChallenge)
          }
          if (powNonce) {
            secondUrl.searchParams.set("pow_nonce", powNonce)
          }

          const headers: Record<string, string> = {
            accept: "application/json, text/plain, */*",
            "cache-control": "no-store",
            "new-api-user":
              fallbackUserId ||
              document.body?.innerText.match(/ID:\\s*(\\d+)/u)?.[1] ||
              "",
          }

          if (fallbackAccessToken) {
            headers.Authorization = `Bearer ${fallbackAccessToken}`
          }

          const response = await fetch(secondUrl.toString(), {
            method: "POST",
            credentials: "include",
            headers,
          })

          return {
            statusCode: response.status,
            rawText: await response.text(),
            requestUrl: secondUrl.toString(),
          }
        },
        {
          requestUrl,
          fallbackUserId:
            account.account_info.id > 0 ? String(account.account_info.id) : "",
          fallbackAccessToken: extractedAccessToken,
        },
      )
      .catch(() => null)
  }

  private buildBrowserSessionCheckinHeaders(
    requestHeaders: Record<string, string>,
  ): Record<string, string> {
    return {
      ...requestHeaders,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "sec-ch-ua":
        "\"Not.A/Brand\";v=\"99\", \"Google Chrome\";v=\"136\", \"Chromium\";v=\"136\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua-mobile": "?0",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      ...buildCompatUserIdHeaders(requestHeaders["new-api-user"] || requestHeaders["New-API-User"]),
    }
  }

  private tryParseJsonRecord(rawText: string): Record<string, unknown> | null {
    if (!rawText.trim()) {
      return null
    }

    try {
      return JSON.parse(rawText) as Record<string, unknown>
    } catch {
      return null
    }
  }

  private isAlreadyCheckedMessage(message: string): boolean {
    const normalized = message.toLowerCase()
    return ["已经签到", "已签到", "今天已经签到", "already"].some((snippet) =>
      normalized.includes(snippet.toLowerCase()),
    )
  }

  private isRunAnytimeSite(account: SiteAccount): boolean {
    try {
      return new URL(account.site_url).hostname.toLowerCase() === "runanytime.hxi.me"
    } catch {
      return false
    }
  }

  private isManualActionRequiredMessage(message: string): boolean {
    const normalized = message.toLowerCase()
    return (
      normalized.includes("turnstile") ||
      normalized.includes("cloudflare") ||
      normalized.includes("captcha") ||
      normalized.includes("校验") ||
      normalized.includes("验证")
    )
  }

  private async detectManualChallenge(page: Page): Promise<string | null> {
    const normalized = await this.readNormalizedPageText(page)

    if (normalized.includes("captcha")) {
      return "登录流程遇到 CAPTCHA，需人工介入"
    }

    if (
      this.getUrlHostname(page.url()) === "github.com" &&
      (normalized.includes("security key") ||
        normalized.includes("passkey") ||
        normalized.includes("verify your identity") ||
        normalized.includes("device verification") ||
        normalized.includes("邮件验证") ||
        normalized.includes("邮箱验证"))
    ) {
      return "GitHub 出现附加身份验证，当前自动化路径已停止"
    }

    return null
  }

  private async detectCloudflareChallenge(page: Page): Promise<boolean> {
    const normalized = await this.readNormalizedPageText(page)
    return (
      normalized.includes("请稍候") ||
      normalized.includes("just a moment") ||
      normalized.includes("turnstile") ||
      normalized.includes("cloudflare")
    )
  }

  private async solveCloudflareWithFlareSolverr(
    context: BrowserContext,
    page: Page,
    options: SessionRefreshOptions,
  ): Promise<boolean> {
    if (!this.config.flareSolverrUrl) return false

    try {
      await this.reportProgress(
        options,
        "检测到 Cloudflare 拦截，正在通过 FlareSolverr 自动破解",
      )

      const result = await solveCloudflareChallenge(
        this.config.flareSolverrUrl,
        page.url(),
        this.fetchImpl,
        (msg) => this.reportProgress(options, `[FlareSolverr] ${msg}`),
      )

      if (!result) {
        await this.reportProgress(options, "FlareSolverr 自动破解失败")
        return false
      }

      await this.reportProgress(options, `注入 ${result.cookies.length} 个 cookie`)
      await context.addCookies(
        result.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite as "Strict" | "Lax" | "None",
        })),
      )

      if (result.userAgent) {
        await this.reportProgress(options, `同步 UA: ${result.userAgent.slice(0, 40)}...`)
        await Promise.race([
          page.setExtraHTTPHeaders({ "User-Agent": result.userAgent }),
          new Promise((r) => setTimeout(r, 3_000)),
        ]).catch(() => undefined)
      }

      const cleanUrl = this.stripCfChallengeParams(page.url())
      await this.reportProgress(options, `导航至: ${cleanUrl.slice(0, 80)}...`)
      await page
        .goto(cleanUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
        .catch(() => undefined)
      await this.reportProgress(options, "页面导航完成")
      return true
    } catch {
      await this.reportProgress(options, "FlareSolverr 自动破解异常")
      return false
    }
  }

  private stripCfChallengeParams(url: string): string {
    try {
      const u = new URL(url)
      u.searchParams.delete("__cf_chl_rt_tk")
      return u.toString()
    } catch {
      return url
    }
  }

  private async readNormalizedPageText(page: Page): Promise<string> {
    const title = await page.title().catch(() => "")
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "")
    return `${title}\n${bodyText}`.toLowerCase()
  }

  private async isLoginSuccess(
    page: Page,
    targetHost: string,
    profile: SiteLoginProfile,
  ): Promise<boolean> {
    for (const selector of profile.postLoginSelectors) {
      if (await this.hasVisibleSelector(page, selector)) {
        return true
      }
    }

    const currentUrl = page.url()
    if (this.getUrlHostname(currentUrl) !== targetHost) {
      return false
    }

    if (
      profile.successUrlPatterns.length > 0 &&
      profile.successUrlPatterns.some((pattern) => currentUrl.includes(pattern))
    ) {
      return true
    }

    const pathname = this.getUrlPathname(currentUrl)
    return !pathname.includes("/login") && !pathname.includes("/auth")
  }

  private async isGitHubLoginPage(page: Page): Promise<boolean> {
    return (
      this.getUrlPathname(page.url()) === "/login" ||
      (await this.hasVisibleSelector(page, GITHUB_LOGIN_FIELD_SELECTORS[0])) ||
      (await this.hasVisibleSelector(page, GITHUB_LOGIN_FIELD_SELECTORS[1]))
    )
  }

  private async isGitHubOtpPage(page: Page): Promise<boolean> {
    for (const selector of GITHUB_TOTP_SELECTORS) {
      if (await this.hasVisibleSelector(page, selector)) {
        return true
      }
    }
    return false
  }

  private async isGitHubTwoFactorChoicePage(page: Page): Promise<boolean> {
    return (
      this.getUrlHostname(page.url()) === "github.com" &&
      this.getUrlPathname(page.url()).includes("two-factor") &&
      !(await this.isGitHubOtpPage(page))
    )
  }

  private async submitGitHubCredentials(page: Page): Promise<void> {
    await this.fillFirst(page, GITHUB_LOGIN_FIELD_SELECTORS, this.config.github.username)
    await this.fillFirst(page, GITHUB_PASSWORD_SELECTORS, this.config.github.password)
    if (await this.clickFirstVisible(page, GITHUB_SUBMIT_SELECTORS)) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined)
    }
  }

  private async submitGitHubTotp(page: Page): Promise<void> {
    const code = generateGitHubTotp(this.config.github.totpSecret)
    await this.fillFirst(page, GITHUB_TOTP_SELECTORS, code)
    if (await this.clickFirstVisible(page, GITHUB_SUBMIT_SELECTORS)) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined)
      return
    }

    await page.keyboard.press("Enter")
    await page.waitForLoadState("domcontentloaded").catch(() => undefined)
  }

  private async extractAccessToken(
    page: Page,
    profile: SiteLoginProfile,
  ): Promise<string> {
    return await page
      .evaluate((keys) => {
        const storageCandidates = [window.localStorage, window.sessionStorage]
        const tokenPattern = /access[_-]?token|token|jwt|auth/i
        const normalizeToken = (value: string): string =>
          value.trim().replace(/^Bearer\s+/iu, "")

        const findTokenInNode = (
          value: unknown,
          path: string[] = [],
          depth = 0,
        ): string => {
          if (depth > 6 || value == null) {
            return ""
          }

          if (typeof value === "string") {
            const trimmed = value.trim()
            if (!trimmed) {
              return ""
            }

            try {
              return findTokenInNode(JSON.parse(trimmed), path, depth + 1)
            } catch {
              const currentKey = path[path.length - 1] || ""
              return tokenPattern.test(currentKey) ? normalizeToken(trimmed) : ""
            }
          }

          if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
              const candidate = findTokenInNode(
                value[index],
                [...path, String(index)],
                depth + 1,
              )
              if (candidate) {
                return candidate
              }
            }
            return ""
          }

          if (typeof value === "object") {
            for (const [nestedKey, nestedValue] of Object.entries(
              value as Record<string, unknown>,
            )) {
              const candidate = findTokenInNode(
                nestedValue,
                [...path, nestedKey],
                depth + 1,
              )
              if (candidate) {
                return candidate
              }
            }
          }

          return ""
        }

        for (const storage of storageCandidates) {
          for (const key of keys) {
            const rawValue = storage.getItem(key)
            if (!rawValue) {
              continue
            }

            const nestedToken = findTokenInNode(rawValue, [key])
            if (nestedToken) {
              return nestedToken
            }

            return normalizeToken(rawValue)
          }
        }

        for (const storage of storageCandidates) {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i)
            if (!key) continue
            const value = storage.getItem(key)
            if (!value || value.length < 12) continue

            if (tokenPattern.test(key)) {
              return normalizeToken(value)
            }

            const nestedToken = findTokenInNode(value, [key])
            if (nestedToken) {
              return nestedToken
            }
          }
        }

        return ""
      }, profile.tokenStorageKeys)
      .catch(() => "")
  }

  private async reportAccessTokenDiagnostics(
    page: Page,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<void> {
    try {
      const diagnostics = await this.collectAccessTokenDiagnostics(page, profile)
      await this.reportProgress(
        options,
        `access token 提取诊断：currentUrl=${diagnostics.currentUrl || "<unknown>"}`,
      )
      await this.reportProgress(
        options,
        `access token 提取诊断：localStorage keys=${this.formatDiagnosticList(
          diagnostics.localStorageKeys,
        )}`,
      )
      await this.reportProgress(
        options,
        `access token 提取诊断：sessionStorage keys=${this.formatDiagnosticList(
          diagnostics.sessionStorageKeys,
        )}`,
      )
      await this.reportProgress(
        options,
        `access token 提取诊断：configured keys=${this.formatDiagnosticEntries(
          diagnostics.configuredKeyEntries,
        )}`,
      )
      await this.reportProgress(
        options,
        `access token 提取诊断：token-like entries=${this.formatDiagnosticEntries(
          diagnostics.tokenLikeEntries,
        )}`,
      )
      await this.reportProgress(
        options,
        `access token 提取诊断：globals=${this.formatDiagnosticList(
          diagnostics.globalHints,
        )}`,
      )
    } catch (error) {
      await this.reportProgress(
        options,
        `access token 提取诊断失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async collectAccessTokenDiagnostics(
    page: Page,
    profile: SiteLoginProfile,
  ): Promise<AccessTokenDiagnostics> {
    return await page.evaluate(
      ({ tokenStorageKeys }) => {
        type TokenStorageKind = "localStorage" | "sessionStorage"

        interface TokenStorageDiagnosticEntry {
          storage: TokenStorageKind
          key: string
          status: string
        }

        const tokenPattern = /access[_-]?token|token|jwt|auth/i
        const normalizeToken = (value: string): string =>
          value.trim().replace(/^Bearer\s+/iu, "")

        const findNestedTokenPath = (
          value: unknown,
          path: string[] = [],
          depth = 0,
        ): string | null => {
          if (depth > 6 || value == null) {
            return null
          }

          if (typeof value === "string") {
            const trimmed = value.trim()
            if (!trimmed) {
              return null
            }

            try {
              return findNestedTokenPath(JSON.parse(trimmed), path, depth + 1)
            } catch {
              const currentKey = path[path.length - 1] || ""
              return tokenPattern.test(currentKey) ? path.join(".") : null
            }
          }

          if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index += 1) {
              const candidate = findNestedTokenPath(
                value[index],
                [...path, String(index)],
                depth + 1,
              )
              if (candidate) {
                return candidate
              }
            }
            return null
          }

          if (typeof value === "object") {
            for (const [nestedKey, nestedValue] of Object.entries(
              value as Record<string, unknown>,
            )) {
              const candidate = findNestedTokenPath(
                nestedValue,
                [...path, nestedKey],
                depth + 1,
              )
              if (candidate) {
                return candidate
              }
            }
          }

          return null
        }

        const summarizeValue = (rawValue: string): string => {
          const trimmed = rawValue.trim()
          if (!trimmed) {
            return "empty-string"
          }

          if (!/^[\[{\"]/.test(trimmed)) {
            return trimmed.length >= 12 ? "raw-string-token-like" : "raw-string-short"
          }

          try {
            const parsed = JSON.parse(trimmed) as unknown
            const nestedTokenPath = findNestedTokenPath(parsed)
            if (nestedTokenPath) {
              return `nested-token(${nestedTokenPath})`
            }

            if (typeof parsed === "string") {
              return parsed.trim().length >= 12
                ? "json-string-token-like"
                : "json-string-short"
            }

            if (parsed && typeof parsed === "object") {
              const record = parsed as Record<string, unknown>
              if (
                typeof record.access_token === "string" &&
                record.access_token.trim().length > 0
              ) {
                return "json-access_token"
              }

              const tokenLikeKeys = Object.entries(record)
                .filter(
                  ([entryKey, entryValue]) =>
                    /access[_-]?token|token|jwt|auth/i.test(entryKey) &&
                    typeof entryValue === "string" &&
                    entryValue.trim().length > 0,
                )
                .map(([entryKey]) => entryKey)

              if (tokenLikeKeys.length > 0) {
                return `json-token-fields(${tokenLikeKeys.slice(0, 3).join(", ")})`
              }

              const sampleKeys = Object.keys(record).slice(0, 4)
              return sampleKeys.length > 0
                ? `json-object(${sampleKeys.join(", ")})`
                : "json-object(empty)"
            }

            return `json-${typeof parsed}`
          } catch {
            return "json-invalid"
          }
        }

        const readStorageKeys = (storage: Storage): string[] => {
          const keys: string[] = []
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index)
            if (key) {
              keys.push(key)
            }
          }
          return keys
        }

        const collectEntries = (
          storage: Storage,
          storageName: TokenStorageKind,
          keys: string[],
        ): TokenStorageDiagnosticEntry[] =>
          keys.map((key) => {
            const rawValue = storage.getItem(key)
            return {
              storage: storageName,
              key,
              status: rawValue ? summarizeValue(rawValue) : "missing",
            }
          })

        const localStorageKeys = readStorageKeys(window.localStorage)
        const sessionStorageKeys = readStorageKeys(window.sessionStorage)
        const configuredKeyEntries = [
          ...collectEntries(window.localStorage, "localStorage", tokenStorageKeys),
          ...collectEntries(window.sessionStorage, "sessionStorage", tokenStorageKeys),
        ]

        const tokenLikeEntries: TokenStorageDiagnosticEntry[] = []
        const collectTokenLikeEntries = (
          storage: Storage,
          storageName: TokenStorageKind,
          keys: string[],
        ) => {
          for (const key of keys) {
            if (!tokenPattern.test(key)) {
              continue
            }

            const rawValue = storage.getItem(key)
            if (!rawValue) {
              continue
            }

            const nestedTokenPath = findNestedTokenPath(rawValue, [key])
            if (!tokenPattern.test(key) && !nestedTokenPath) {
              continue
            }

            tokenLikeEntries.push({
              storage: storageName,
              key,
              status: nestedTokenPath
                ? `nested-token(${nestedTokenPath})`
                : summarizeValue(rawValue),
            })
          }
        }

        collectTokenLikeEntries(window.localStorage, "localStorage", localStorageKeys)
        collectTokenLikeEntries(window.sessionStorage, "sessionStorage", sessionStorageKeys)

        const globalHints = [
          "__NUXT__",
          "__NEXT_DATA__",
          "__INITIAL_STATE__",
          "__APOLLO_STATE__",
        ].filter((key) => key in window)

        return {
          currentUrl: window.location.href,
          localStorageKeys,
          sessionStorageKeys,
          configuredKeyEntries,
          tokenLikeEntries,
          globalHints,
        }
      },
      { tokenStorageKeys: profile.tokenStorageKeys },
    )
  }

  private formatDiagnosticList(values?: string[] | null): string {
    return values && values.length > 0 ? values.join(", ") : "<none>"
  }

  private formatDiagnosticEntries(
    entries?: TokenStorageDiagnosticEntry[] | null,
  ): string {
    return entries && entries.length > 0
      ? entries
          .map((entry) => `${entry.storage}:${entry.key}=${entry.status}`)
          .join("; ")
      : "<none>"
  }

  private async clickFirstVisible(
    page: Page,
    selectors: string[],
  ): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        continue
      }

      const visible = await locator.isVisible().catch(() => false)
      if (!visible) {
        continue
      }

      await locator.click({ timeout: 5_000, noWaitAfter: true })
      return true
    }

    return false
  }

  private async clickRunAnytimeCheckinButton(
    page: Page,
    options: SessionRefreshOptions,
  ): Promise<boolean> {
    const pageResult = await page
      .evaluate(() => {
        const targetTexts = new Set([
          "check in now",
          "checkin now",
          "立即签到",
        ])

        const isVisible = (element: HTMLElement): boolean => {
          const style = window.getComputedStyle(element)
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.opacity === "0"
          ) {
            return false
          }
          const rect = element.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }

        const createSyntheticEvent = (button: HTMLElement) => ({
          type: "click",
          bubbles: true,
          cancelable: true,
          composed: true,
          defaultPrevented: false,
          currentTarget: button,
          target: button,
          nativeEvent: new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
          preventDefault() {
            this.defaultPrevented = true
          },
          stopPropagation() {},
          isDefaultPrevented() {
            return this.defaultPrevented
          },
          isPropagationStopped() {
            return false
          },
          persist() {},
        })

        const findReactOnClick = (
          node: HTMLElement | null,
        ): ((event: unknown) => unknown) | null => {
          let current = node as (HTMLElement & Record<string, unknown>) | null
          while (current) {
            for (const key of Object.keys(current)) {
              if (key.startsWith("__reactProps$")) {
                const props = current[key] as Record<string, unknown> | undefined
                if (props && typeof props.onClick === "function") {
                  return props.onClick as (event: unknown) => unknown
                }
              }

              if (key.startsWith("__reactFiber$")) {
                const fiber = current[key] as
                  | {
                      memoizedProps?: Record<string, unknown>
                      return?: {
                        memoizedProps?: Record<string, unknown>
                      } | null
                    }
                  | undefined

                if (fiber?.memoizedProps && typeof fiber.memoizedProps.onClick === "function") {
                  return fiber.memoizedProps.onClick as (event: unknown) => unknown
                }

                if (
                  fiber?.return?.memoizedProps &&
                  typeof fiber.return.memoizedProps.onClick === "function"
                ) {
                  return fiber.return.memoizedProps.onClick as (event: unknown) => unknown
                }
              }
            }

            current = current.parentElement as (HTMLElement & Record<string, unknown>) | null
          }

          return null
        }

        const normalizeButtonText = (element: HTMLElement): string =>
          (element.textContent || "").trim().replace(/\s+/gu, " ")

        const candidates = Array.from(
          document.querySelectorAll("button, [role='button']"),
        )
          .map((element) => element as HTMLElement)
          .filter((element) => {
            if (!isVisible(element)) {
              return false
            }
            const normalizedText = normalizeButtonText(element).toLowerCase()
            return targetTexts.has(normalizedText)
          })

        const button = candidates[0] ?? null
        if (!button) {
          return null
        }

        const text = normalizeButtonText(button)
        const disabled =
          button.hasAttribute("disabled") ||
          button.getAttribute("aria-disabled") === "true" ||
          (button as HTMLButtonElement).disabled === true
        const ariaBusy = button.getAttribute("aria-busy") || ""

        const buttonState = {
          text,
          disabled,
          ariaBusy,
        }

        if (disabled) {
          return {
            buttonState,
            clickResult: "",
          }
        }

        const reactOnClick = findReactOnClick(button)
        if (reactOnClick) {
          const maybePromise = reactOnClick(createSyntheticEvent(button))
          if (maybePromise && typeof (maybePromise as PromiseLike<unknown>).then === "function") {
            void (maybePromise as PromiseLike<unknown>).then(
              () => undefined,
              () => undefined,
            )
          }
          return {
            buttonState,
            clickResult: `react:${text}`,
          }
        }

        if (typeof (button as HTMLButtonElement).click === "function") {
          ;(button as HTMLButtonElement).click()
          return {
            buttonState,
            clickResult: `native:${text}`,
          }
        }

        const eventTypes = [
          "pointerdown",
          "mousedown",
          "pointerup",
          "mouseup",
          "click",
        ]

        for (const type of eventTypes) {
          button.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
            }),
          )
        }

        return {
          buttonState,
          clickResult: `dispatch:${text}`,
        }
      })
      .catch(() => null)

    if (!pageResult?.buttonState) {
      return false
    }

    await this.reportProgress(
      options,
      `RunAnytime 按钮状态：text=${pageResult.buttonState.text || "<empty>"} disabled=${pageResult.buttonState.disabled} aria-busy=${pageResult.buttonState.ariaBusy || "<empty>"}`,
    )

    if (pageResult.buttonState.disabled || !pageResult.clickResult) {
      return false
    }

    const [strategy, rawLabel] = pageResult.clickResult.includes(":")
      ? pageResult.clickResult.split(/:(.+)/u)
      : ["dispatch", pageResult.clickResult]
    const clickedLabel = rawLabel || pageResult.buttonState.text || "Check in now"

    await this.reportProgress(
      options,
      strategy === "react"
        ? `RunAnytime 页面内直接调用签到逻辑：${clickedLabel}`
        : strategy === "native"
          ? `RunAnytime 原生 click 触发签到按钮：${clickedLabel}`
          : `RunAnytime 事件派发点击签到按钮：${clickedLabel}`,
    )
    return true
  }

  private async clickFirstVisibleWithPopup(
    context: BrowserContext,
    page: Page,
    selectors: string[],
  ): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        continue
      }

      const visible = await locator.isVisible().catch(() => false)
      if (!visible) {
        continue
      }

      const popupPromise = context.waitForEvent("page", { timeout: 3_000 }).catch(
        () => null,
      )
      await locator.click({ timeout: 5_000, noWaitAfter: true })
      const popup = await popupPromise
      if (popup) {
        await popup.waitForLoadState("domcontentloaded").catch(() => undefined)
      } else {
        await page.waitForLoadState("domcontentloaded").catch(() => undefined)
      }
      return true
    }

    return false
  }

  private async dismissCommonOverlays(page: Page): Promise<void> {
    const selectors = [
      "button[aria-label='close']",
      ".semi-modal-close",
      ".semi-modal-header button[aria-label='close']",
      "button:has-text('关闭')",
      "button:has-text('我知道了')",
      "button:has-text('知道了')",
    ]

    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        continue
      }

      const visible = await locator.isVisible().catch(() => false)
      if (!visible) {
        continue
      }

      await locator.click({ timeout: 2_000 }).catch(() => undefined)
      await page.waitForTimeout(300).catch(() => undefined)
    }
  }

  private async describeVisibleActionTexts(page: Page): Promise<string> {
    const items = await page
      .locator("button, a")
      .evaluateAll((elements) =>
        elements
          .map((element) => ({
            text: (element.textContent || "").trim().replace(/\s+/gu, " "),
            tag: element.tagName.toLowerCase(),
          }))
          .filter((item) => item.text.length > 0)
          .slice(0, 8)
          .map((item) => `${item.tag}:${item.text.slice(0, 24)}`),
      )
      .catch(() => [])

    return items.length > 0 ? items.join(" | ") : "无"
  }

  private async cleanupStaleProfileLocks(directory: string): Promise<void> {
    const singletonArtifacts = [
      "SingletonLock",
      "SingletonSocket",
      "SingletonCookie",
    ]

    await Promise.all(
      singletonArtifacts.map(async (name) => {
        await fs.rm(path.join(directory, name), {
          force: true,
          recursive: true,
        }).catch(() => undefined)
      }),
    )
  }

  private async reportProgress(
    options: SessionRefreshOptions,
    message: string,
  ): Promise<void> {
    await options.onProgress?.(message)
  }

  private pickFlowPage(
    context: BrowserContext,
    targetHost: string,
    linuxdoHost: string,
  ): Page | null {
    const pages = context
      .pages()
      .filter((item) => !item.isClosed())

    return (
      pages.find((item) => this.getUrlHostname(item.url()) === "github.com") ||
      pages.find((item) =>
        this.isSameOrSubdomain(this.getUrlHostname(item.url()), linuxdoHost),
      ) ||
      pages.find((item) => this.getUrlHostname(item.url()) === targetHost) ||
      pages[0] ||
      null
    )
  }

  private async findTargetPage(
    context: BrowserContext,
    targetHost: string,
    profile: SiteLoginProfile,
  ): Promise<Page | null> {
    for (const candidate of context.pages().filter((item) => !item.isClosed())) {
      if (this.getUrlHostname(candidate.url()) !== targetHost) {
        continue
      }

      if (await this.isLoginSuccess(candidate, targetHost, profile)) {
        return candidate
      }
    }

    return null
  }

  private async fillFirst(
    page: Page,
    selectors: string[],
    value: string,
  ): Promise<void> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first()
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        continue
      }

      await locator.fill(value, { timeout: 5_000 })
      return
    }

    throw new Error(`未找到可填写输入框：${selectors.join(", ")}`)
  }

  private async hasVisibleSelector(page: Page, selector: string): Promise<boolean> {
    const locator = page.locator(selector).first()
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      return false
    }

    return await locator.isVisible().catch(() => false)
  }

  private getUrlHostname(url: string): string {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return ""
    }
  }

  private getUrlPathname(url: string): string {
    try {
      return new URL(url).pathname.toLowerCase()
    } catch {
      return ""
    }
  }

  private async captureDiagnostic(
    page: Page,
    account: SiteAccount,
  ): Promise<string | undefined> {
    const fileName = `${Date.now()}-${sanitizeFileName(account.id || account.site_name)}.png`
    const filePath = path.join(this.config.diagnosticsDirectory, fileName)
    await page.screenshot({ path: filePath, fullPage: true }).catch(() => undefined)
    return filePath
  }

  private isSameOrSubdomain(hostname: string, expectedHost: string): boolean {
    return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`)
  }
}
