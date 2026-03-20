import fs from "node:fs/promises"
import path from "node:path"

import {
  AuthType,
  buildCookieHeader,
  fetchNewApiSelf,
  joinUrl,
  normalizeBaseUrl,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"
import { chromium, type BrowserContext, type Page } from "playwright"

import type { ServerConfig } from "../config.js"
import { sanitizeFileName } from "../utils/text.js"
import {
  matchSiteLoginProfile,
  type SiteLoginProfile,
} from "./siteLoginProfiles.js"
import { generateGitHubTotp } from "./githubTotp.js"

const LINUXDO_GITHUB_SELECTORS = [
  "a[href*='github']",
  "button[data-provider='github']",
  "button[title*='GitHub']",
  "a.btn-social.github",
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
  "button[type='submit']",
]

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
    const profile = matchSiteLoginProfile(
      account.site_url,
      this.config.siteLoginProfiles,
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
    const deadline = Date.now() + 120_000
    const visitedHosts = new Set<string>()

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
      const currentHostLabel = currentHost || currentUrl || "about:blank"

      if (currentHostLabel && !visitedHosts.has(currentHostLabel)) {
        visitedHosts.add(currentHostLabel)
        await this.reportProgress(options, `当前流程页面：${currentHostLabel}`)
      }

      const challengeMessage = await this.detectManualChallenge(flowPage)
      if (challengeMessage) {
        await this.reportProgress(options, challengeMessage)
        return {
          status: "manual_action_required",
          message: challengeMessage,
        }
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

      if (
        currentHost === "github.com" &&
        (await this.clickFirstVisibleWithPopup(context, flowPage, GITHUB_AUTHORIZE_SELECTORS))
      ) {
        await this.reportProgress(options, "检测到 GitHub 授权确认页，提交授权")
        continue
      }

      if (currentHost === linuxdoHost) {
        if (
          await this.clickFirstVisibleWithPopup(
            context,
            flowPage,
            LINUXDO_GITHUB_SELECTORS,
          )
        ) {
          await this.reportProgress(options, "检测到 Linux.do 授权页，点击 GitHub 登录入口")
          continue
        }

        await this.dismissCommonOverlays(flowPage)
        await flowPage.waitForTimeout(1_000)
        continue
      }

      if (currentHost === targetHost) {
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

        await this.dismissCommonOverlays(flowPage)
      }

      await flowPage.waitForTimeout(1_000)
    }

    return {
      status: "manual_action_required",
      message: "登录流程超时，未能完成 Linux.do / GitHub SSO",
    }
  }

  private async captureAuthenticatedAccount(
    page: Page,
    context: BrowserContext,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<SiteAccount | null> {
    const targetBaseUrl = normalizeBaseUrl(account.site_url)
    if (this.getUrlHostname(page.url()) !== new URL(targetBaseUrl).hostname) {
      await this.reportProgress(options, `返回目标站点主页：${targetBaseUrl}`)
      await page.goto(targetBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      })
    }

    await this.reportProgress(options, "提取 cookie 与 access token")
    const cookieHeader = buildCookieHeader(await context.cookies([targetBaseUrl]))
    const accessToken = await this.extractAccessToken(page, profile)
    const now = Date.now()

    const nextAccount: SiteAccount = {
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

    await this.reportProgress(options, "调用 /api/user/self 校验登录状态")
    const synced = await fetchNewApiSelf({
      account: nextAccount,
      fetchImpl: this.fetchImpl,
    })

    if (!synced) {
      await this.reportProgress(options, "/api/user/self 校验失败")
      return null
    }

    await this.reportProgress(options, "/api/user/self 校验成功")

    const finalAccessToken = accessToken || synced.account_info.access_token || ""

    return {
      ...synced,
      updated_at: now,
      last_sync_time: now,
      authType: finalAccessToken
        ? AuthType.AccessToken
        : cookieHeader
          ? AuthType.Cookie
          : synced.authType,
      account_info: {
        ...synced.account_info,
        access_token: finalAccessToken,
      },
      cookieAuth: cookieHeader ? { sessionCookie: cookieHeader } : synced.cookieAuth,
    }
  }

  private async detectManualChallenge(page: Page): Promise<string | null> {
    const title = await page.title().catch(() => "")
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "")
    const normalized = `${title}\n${bodyText}`.toLowerCase()

    if (
      normalized.includes("请稍候") ||
      normalized.includes("just a moment") ||
      normalized.includes("turnstile") ||
      normalized.includes("cloudflare") ||
      normalized.includes("captcha")
    ) {
      return "登录流程遇到 Cloudflare / Turnstile / CAPTCHA，需人工介入"
    }

    if (
      normalized.includes("security key") ||
      normalized.includes("passkey") ||
      normalized.includes("verify your identity") ||
      normalized.includes("device verification") ||
      normalized.includes("邮件验证") ||
      normalized.includes("邮箱验证")
    ) {
      return "GitHub 出现附加身份验证，当前自动化路径已停止"
    }

    return null
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
    if (this.getUrlPathname(page.url()).includes("two-factor")) {
      return true
    }

    for (const selector of GITHUB_TOTP_SELECTORS) {
      if (await this.hasVisibleSelector(page, selector)) {
        return true
      }
    }

    return false
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
        for (const storage of storageCandidates) {
          for (const key of keys) {
            const rawValue = storage.getItem(key)
            if (!rawValue) {
              continue
            }

            try {
              const parsed = JSON.parse(rawValue) as unknown
              if (
                parsed &&
                typeof parsed === "object" &&
                "access_token" in parsed &&
                typeof parsed.access_token === "string"
              ) {
                return parsed.access_token.trim()
              }
            } catch {
              // Keep raw values as a fallback.
            }

            return rawValue.trim().replace(/^Bearer\s+/iu, "")
          }
        }

        return ""
      }, profile.tokenStorageKeys)
      .catch(() => "")
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

      await locator.click({ timeout: 5_000 })
      return true
    }

    return false
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
      await locator.click({ timeout: 5_000 })
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
      pages.find((item) => this.getUrlHostname(item.url()) === linuxdoHost) ||
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
}
