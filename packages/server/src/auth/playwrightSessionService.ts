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
import {
  solveCloudflareChallenge,
  type FlareSolverrResult,
} from "./flareSolverrClient.js"
import { generateGitHubTotp } from "./githubTotp.js"
import {
  matchOrDefaultSiteLoginProfile,
  type LocalBrowserProfile,
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
const COMMON_LOGIN_ENTRY_SELECTORS = [
  "a[href*='/login']",
  "button:has-text('登录')",
  "a:has-text('登录')",
  "button:has-text('Sign in')",
  "a:has-text('Sign in')",
  "button:has-text('Login')",
  "a:has-text('Login')",
]
const DIRECT_LINUXDO_LOGIN_SELECTORS = [
  "button:has-text('使用 LinuxDO 继续')",
  "button:has-text('Continue with LinuxDO')",
  "text=使用 LinuxDO 继续",
  "text=Continue with LinuxDO",
]
const COMMON_PUBLIC_ENTRY_SELECTORS = [
  "a[href*='/login']",
  "button:has-text('登录')",
  "a:has-text('登录')",
  "button:has-text('注册')",
  "a:has-text('注册')",
  "button:has-text('Sign in')",
  "a:has-text('Sign in')",
  "button:has-text('Login')",
  "a:has-text('Login')",
  "button:has-text('Register')",
  "a:has-text('Register')",
  "a[href*='/register']",
]
const AUTH_SELF_VALIDATION_ATTEMPTS = 5
const AUTH_SELF_VALIDATION_RETRY_DELAY_MS = 1_000
const LOCAL_BROWSER_CF_AUTO_CLEAR_WAIT_MS = 20_000
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
  code?: string
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

export interface PlaywrightSiteSessionConfig
  extends Pick<
    ServerConfig,
    | "diagnosticsDirectory"
    | "sharedSsoProfileDirectory"
    | "chromiumExecutablePath"
    | "github"
    | "flareSolverrUrl"
    | "siteLoginProfiles"
  > {
  browserHeadless?: boolean
  chromiumLaunchArgs?: string[]
  manualLoginWaitTimeoutMs?: number
  runAnytimeDebugRootOnlyPause?: boolean
  localFlareSolverr?: {
    enabled: boolean
    url: string | null
    timeoutMs: number
  }
}

type LoginFlowResult =
  | { status: "ready"; page: Page }
  | { status: "manual_action_required"; message: string }
  | { status: "unsupported_auto_reauth"; message: string }
  | { status: "failed"; code: string; message: string }

interface LocalBrowserPrewarmApplyResult {
  appliedCookies: number
  userAgent: string | null
}

type InitialLocalBrowserPrewarmResult =
  | {
      kind: "applied"
      result: FlareSolverrResult
    }
  | {
      kind: "no_cookies"
      userAgent: string | null
      message: string
    }

export class PlaywrightSiteSessionService implements SiteSessionRefresher {
  constructor(
    private readonly repository: StorageRepository,
    private readonly config: PlaywrightSiteSessionConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private isInitialLocalBrowserPrewarmAppliedResult(
    value: InitialLocalBrowserPrewarmResult | FlareSolverrResult,
  ): value is Extract<InitialLocalBrowserPrewarmResult, { kind: "applied" }> {
    return "kind" in value && value.kind === "applied"
  }

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

    const requiresLocalPrewarm = this.requiresLocalFlareSolverrPrewarm(profile)
    if (requiresLocalPrewarm && !this.shouldUseLocalFlareSolverr(profile)) {
      await this.reportProgress(options, "命中本地 FlareSolverr 预热策略，但本地能力不可用")
      return this.buildLocalFlareSolverrUnavailableSessionResult()
    }

    let initialPrewarmResult: InitialLocalBrowserPrewarmResult | null = null
    if (this.shouldUseLocalFlareSolverr(profile)) {
      await this.reportProgress(options, "命中本地 FlareSolverr 预热策略")
      initialPrewarmResult = await this.requestInitialLocalBrowserChallengePrewarm(
        account,
        profile,
        options,
      )
      if (!initialPrewarmResult) {
        return {
          status: "failed",
          code: "local_flaresolverr_prewarm_failed",
          message: "本地 FlareSolverr 预热失败",
        }
      }
    }

    let context: BrowserContext | null = null
    let page: Page | null = null
    const shouldOpenSiteRootFirst = this.shouldOpenSiteRootBeforeCheckin(profile)
    let injectedCookieCount = 0

    try {
      await this.reportProgress(options, "启动 Chromium 持久化上下文")
      context = await chromium.launchPersistentContext(
        this.config.sharedSsoProfileDirectory,
        this.buildPersistentContextLaunchOptions(
          this.resolveInitialPrewarmLaunchUserAgent(initialPrewarmResult),
        ),
      )
      page = context.pages()[0] ?? (await context.newPage())
      await this.clearTargetSiteCloudflareCookies(context, account, options)

      if (initialPrewarmResult?.kind === "applied") {
        const prewarmResult = await this.applyLocalBrowserChallengePrewarm(
          context,
          page,
          initialPrewarmResult.result,
          options,
        )
        if (!prewarmResult) {
          const diagnosticPath = await this.captureDiagnostic(page, account)
          if (diagnosticPath) {
            await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
          }
          return {
            status: "failed",
            code: "local_flaresolverr_prewarm_failed",
            message: "本地 FlareSolverr 预热失败",
            diagnosticPath,
          }
        }
      } else if (initialPrewarmResult?.kind === "no_cookies") {
        await this.reportProgress(
          options,
          "本地 FlareSolverr 未返回 challenge cookie，继续进入浏览器流程观察实际挑战",
        )
      }
      injectedCookieCount = await this.seedBrowserContextWithAccountCookies(
        context,
        account,
        options,
      )
      if (injectedCookieCount > 0) {
        await this.reportProgress(
          options,
          `刷新前先复用账号已有站点会话 cookie（${injectedCookieCount} 个）`,
        )
      }
      await this.reportProgress(options, "浏览器上下文已启动")

      if (shouldOpenSiteRootFirst && !this.isRunAnytimeSite(account)) {
        const targetRootUrl = joinUrl(account.site_url, "/")
        await this.reportProgress(
          options,
          `站点根页优先：预热后先打开站点根页：${targetRootUrl}`,
        )
        await page.goto(targetRootUrl, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        })
        const reusedAccount = await this.tryReuseAuthenticatedSessionFromCurrentPage(
          context,
          page,
          account,
          profile,
          options,
          {
            success: "站点根页会话校验成功，直接复用本地浏览器会话",
            failure:
              injectedCookieCount > 0
                ? "站点根页会话未通过 /api/user/self 校验，继续尝试完整 SSO"
                : "站点根页未检测到可复用会话，继续尝试完整 SSO",
          },
        )
        if (reusedAccount) {
          return {
            status: "refreshed",
            message: "站点会话已刷新",
            account: reusedAccount,
          }
        }
      } else {
        await this.reportProgress(
          options,
          `打开站点登录页：${joinUrl(account.site_url, profile.loginPath)}`,
        )
        await page.goto(joinUrl(account.site_url, profile.loginPath), {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        })
      }

      const flowResult = await this.completeLoginFlow(
        context,
        page,
        account,
        profile,
        options,
      )
      if (flowResult.status !== "ready") {
        if (flowResult.status === "failed") {
          const diagnosticPath = await this.captureDiagnostic(page, account)
          if (diagnosticPath) {
            await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
          }
          return {
            status: "failed",
            code: flowResult.code,
            message: flowResult.message,
            diagnosticPath,
          }
        }

        if (
          flowResult.status === "manual_action_required" &&
          !this.shouldAllowManualFallback(account, profile)
        ) {
          await this.reportProgress(options, "当前 profile 已禁用人工兜底，自动登录失败后直接返回")
          const diagnosticPath = await this.captureDiagnostic(page, account)
          if (diagnosticPath) {
            await this.reportProgress(options, `已保存诊断截图：${diagnosticPath}`)
          }
          return {
            status: "failed",
            code: "manual_fallback_disabled",
            message: flowResult.message,
            diagnosticPath,
          }
        }

        const manualPage = await this.waitForManualLoginCompletion(
          page,
          account,
          profile,
          options,
        )
        if (manualPage) {
          await this.reportProgress(options, "检测到人工接管完成，继续提取会话信息")
          const refreshedAccount = await this.captureAuthenticatedAccount(
            manualPage,
            context,
            account,
            profile,
            options,
          )
          if (refreshedAccount) {
            return {
              status: "refreshed",
              message: "人工接管后已提取并保存最新站点会话",
              account: refreshedAccount,
            }
          }
        }

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

    const requiresLocalPrewarm = this.requiresLocalFlareSolverrPrewarm(profile)
    if (requiresLocalPrewarm && !this.shouldUseLocalFlareSolverr(profile)) {
      await this.reportProgress(options, "命中本地 FlareSolverr 预热策略，但本地能力不可用")
      return this.buildLocalFlareSolverrUnavailableCheckinResult(account)
    }

    let initialPrewarmResult: InitialLocalBrowserPrewarmResult | null = null
    if (this.shouldUseLocalFlareSolverr(profile)) {
      await this.reportProgress(options, "命中本地 FlareSolverr 预热策略")
      initialPrewarmResult = await this.requestInitialLocalBrowserChallengePrewarm(
        account,
        profile,
        options,
      )
      if (!initialPrewarmResult) {
        const now = Date.now()
        return {
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Failed,
          code: "local_flaresolverr_prewarm_failed",
          message: "本地 FlareSolverr 预热失败",
          startedAt: now,
          completedAt: now,
          checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
        }
      }
    }

    let context: BrowserContext | null = null
    let page: Page | null = null
    let shouldCloseContext = true
    const shouldOpenSiteRootFirst = this.shouldOpenSiteRootBeforeCheckin(profile)
    let nonRunAnytimeInjectedCookieCount = 0

    try {
      context = await chromium.launchPersistentContext(
        this.config.sharedSsoProfileDirectory,
        this.buildPersistentContextLaunchOptions(
          this.resolveInitialPrewarmLaunchUserAgent(initialPrewarmResult),
        ),
      )
      page = context.pages()[0] ?? (await context.newPage())

      if (initialPrewarmResult?.kind === "applied") {
        const prewarmResult = await this.applyLocalBrowserChallengePrewarm(
          context,
          page,
          initialPrewarmResult.result,
          options,
        )
        if (!prewarmResult) {
          const now = Date.now()
          return {
            accountId: account.id,
            siteName: account.site_name,
            siteUrl: account.site_url,
            siteType: account.site_type,
            status: CheckinResultStatus.Failed,
            code: "local_flaresolverr_prewarm_failed",
            message: "本地 FlareSolverr 预热失败",
            startedAt: now,
            completedAt: now,
            checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
          }
        }
      } else if (initialPrewarmResult?.kind === "no_cookies") {
        await this.reportProgress(
          options,
          "本地 FlareSolverr 未返回 challenge cookie，继续进入浏览器流程观察实际挑战",
        )
      }

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
        }

        if (this.resolveRunAnytimeDebugRootOnlyPause()) {
          shouldCloseContext = false
          return await this.pauseRunAnytimeAtRootForDebug(page, account, options)
        }

        if (shouldOpenSiteRootFirst) {
          const runAnytimeRootUrl = joinUrl(account.site_url, "/")
          await this.reportProgress(
            options,
            `RunAnytime 根页优先：预热与 cookie 注入后先打开站点根页：${runAnytimeRootUrl}`,
          )
          await page.goto(runAnytimeRootUrl, {
            waitUntil: "domcontentloaded",
            timeout: 90_000,
          })

          const currentUrl = page.url()
          if (this.isRunAnytimeExpiredLoginPage(currentUrl)) {
            await this.reportProgress(
              options,
              "RunAnytime 根页跳转到 /login?expired=true，直接进入完整 SSO 自动登录",
            )
          } else if (!this.isRunAnytimeLoginPage(currentUrl)) {
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
                "RunAnytime 根页会话校验成功，切换为页面按钮签到流",
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
              "RunAnytime 根页会话未通过 /api/user/self 校验，继续尝试完整 SSO",
            )
          }
        } else if (injectedCookieCount > 0) {
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
      } else {
        nonRunAnytimeInjectedCookieCount = await this.seedBrowserContextWithAccountCookies(
          context,
          account,
          options,
        )
        if (nonRunAnytimeInjectedCookieCount > 0) {
          await this.reportProgress(
            options,
            `站点根页优先前先复用账号已有站点会话 cookie（${nonRunAnytimeInjectedCookieCount} 个）`,
          )
        }
      }

      if (shouldOpenSiteRootFirst && !this.isRunAnytimeSite(account)) {
        const targetRootUrl = joinUrl(account.site_url, "/")
        await this.reportProgress(
          options,
          `站点根页优先：预热后先打开站点根页：${targetRootUrl}`,
        )
        await page.goto(targetRootUrl, {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        })
        const reusedAccount = await this.tryReuseAuthenticatedSessionFromCurrentPage(
          context,
          page,
          account,
          profile,
          options,
          {
            success: "站点根页会话校验成功，切换为页面按钮签到流",
            failure:
              nonRunAnytimeInjectedCookieCount > 0
                ? "站点根页会话未通过 /api/user/self 校验，继续尝试完整 SSO"
                : "站点根页未检测到可复用会话，继续尝试完整 SSO",
          },
        )
        if (reusedAccount) {
          return await this.performBrowserSessionCheckin(
            page,
            reusedAccount,
            profile,
            options,
          )
        }
      }

      if (shouldOpenSiteRootFirst) {
        await this.reportProgress(
          options,
          this.isRunAnytimeSite(account)
            ? `RunAnytime 根页优先：沿用当前页面进入完整 SSO 自动登录：${page.url()}`
            : `站点根页优先：沿用当前页面进入完整 SSO 自动登录：${page.url()}`,
        )
      } else {
        await page.goto(joinUrl(account.site_url, profile.loginPath), {
          waitUntil: "domcontentloaded",
          timeout: 90_000,
        })
      }

      const flowResult = await this.completeLoginFlow(
        context,
        page,
        account,
        profile,
        options,
      )
      if (flowResult.status !== "ready") {
        if (flowResult.status === "failed") {
          const now = Date.now()
          return {
            accountId: account.id,
            siteName: account.site_name,
            siteUrl: account.site_url,
            siteType: account.site_type,
            status: CheckinResultStatus.Failed,
            code: flowResult.code,
            message: flowResult.message,
            startedAt: now,
            completedAt: now,
            checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
          }
        }

        if (
          flowResult.status === "manual_action_required" &&
          !this.shouldAllowManualFallback(account, profile)
        ) {
          await this.reportProgress(options, "当前 profile 已禁用人工兜底，自动登录失败后直接返回")
          const now = Date.now()
          return {
            accountId: account.id,
            siteName: account.site_name,
            siteUrl: account.site_url,
            siteType: account.site_type,
            status: CheckinResultStatus.Failed,
            code: "manual_fallback_disabled",
            message: flowResult.message,
            startedAt: now,
            completedAt: now,
            checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
          }
        }

        const manualPage = await this.waitForManualLoginCompletion(
          page,
          account,
          profile,
          options,
        )
        if (manualPage) {
          return await this.performBrowserSessionCheckin(
            manualPage,
            account,
            profile,
            options,
          )
        }

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
      if (shouldCloseContext) {
        await context?.close()
      }
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

  private async tryReuseAuthenticatedSessionFromCurrentPage(
    context: BrowserContext,
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
    messages: {
      success: string
      failure: string
    },
  ): Promise<SiteAccount | null> {
    const currentUrl = page.url()
    const currentPath = this.getUrlPathname(currentUrl)
    if (
      this.getUrlHostname(currentUrl) !== new URL(account.site_url).hostname ||
      currentPath.includes("/login") ||
      currentPath.includes("/auth")
    ) {
      return null
    }

    const capturedAccount = await this.captureAuthenticatedAccount(
      page,
      context,
      account,
      profile,
      options,
    )
    if (capturedAccount) {
      await this.repository.saveAccount(capturedAccount)
      await this.reportProgress(options, messages.success)
      return capturedAccount
    }

    await this.reportProgress(options, messages.failure)
    return null
  }

  private async completeLoginFlow(
    context: BrowserContext,
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<LoginFlowResult> {
    const targetHost = new URL(account.site_url).hostname.toLowerCase()
    const linuxdoHost = new URL(this.config.github.linuxdoBaseUrl).hostname.toLowerCase()
    let deadline = Date.now() + 120_000
    let brokenLoginRootFallbackAttempts = 0
    const visitedUrls = new Set<string>()
    const loggedSelectorDiagnostics = new Set<string>()
    const actionCooldowns = new Map<string, number>()
    const callbackWaits = new Set<string>()
    let linuxdoSsoRestartAttempts = 0
    let flareSolverrAttempts = 0
    let browserChallengePrewarmUsed = false
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
        if (this.shouldRetryBrowserChallengeWithLocalPrewarm(profile)) {
          if (browserChallengePrewarmUsed) {
            const exhaustedMsg =
              "浏览器过程中再次命中 Cloudflare，额外预热次数已耗尽，停止自动重试"
            await this.reportProgress(options, exhaustedMsg)
            return {
              status: "failed",
              code: "cloudflare_prewarm_exhausted",
              message: exhaustedMsg,
            }
          }

          browserChallengePrewarmUsed = true
          const browserChallengeRetryUrl = currentUrl
            ? this.stripCfChallengeParams(currentUrl)
            : undefined
          await this.reportProgress(
            options,
            "浏览器过程中再次命中 Cloudflare，尝试一次额外预热",
          )
          const prewarmResult = await this.prewarmLocalBrowserChallenge(
            context,
            account,
            profile,
            options,
            browserChallengeRetryUrl,
          )
          if (!prewarmResult) {
            await this.reportProgress(options, "本地 FlareSolverr 预热失败")
            return {
              status: "failed",
              code: "cloudflare_prewarm_exhausted",
              message: "浏览器过程中再次命中 Cloudflare，额外预热仍失败",
            }
          }

          await this.reportProgress(
            options,
            browserChallengeRetryUrl && browserChallengeRetryUrl !== currentUrl
              ? "额外预热完成，重新打开去掉 Cloudflare 挑战参数的原始页面后继续自动流程"
              : "额外预热完成，刷新当前页面后继续自动流程",
          )
          const reloadPage = flowPage as Page & {
            reload?: (options?: {
              waitUntil?: "domcontentloaded"
              timeout?: number
            }) => Promise<unknown>
          }
          if (
            browserChallengeRetryUrl &&
            currentUrl &&
            browserChallengeRetryUrl !== currentUrl
          ) {
            await flowPage.goto(browserChallengeRetryUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            })
          } else if (typeof reloadPage.reload === "function") {
            await reloadPage.reload({
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            })
          } else if (browserChallengeRetryUrl) {
            await flowPage.goto(browserChallengeRetryUrl, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            })
          }
          await this.reportProgress(options, "等待 Cloudflare 自动验证结果")
          if (
            !(await this.waitForCloudflareChallengeToClear(flowPage, {
              timeoutMs: LOCAL_BROWSER_CF_AUTO_CLEAR_WAIT_MS,
            }))
          ) {
            const exhaustedMsg =
              "浏览器过程中再次命中 Cloudflare，额外预热次数已耗尽，停止自动重试"
            await this.reportProgress(options, exhaustedMsg)
            return {
              status: "failed",
              code: "cloudflare_prewarm_exhausted",
              message: exhaustedMsg,
            }
          }
          await this.reportProgress(options, "Cloudflare 页面已自动放行，继续登录流程")
          continue
        }

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
        const brokenLoginEntry = await this.inspectBrokenLoginEntry(
          flowPage,
          profile,
        )
        if (brokenLoginEntry) {
          if (brokenLoginRootFallbackAttempts >= 2) {
            await this.reportProgress(
              options,
              `登录页已连续 ${brokenLoginRootFallbackAttempts} 次命中空白壳，停止自动切根路径重试`,
            )
            return {
              status: "failed",
              code: "broken_login_entry",
              message: "站点登录页资源异常，自动切换根路径重试后仍未恢复",
            }
          }

          brokenLoginRootFallbackAttempts += 1
          const fallbackUrl = normalizeBaseUrl(account.site_url)
          await this.reportProgress(
            options,
            `检测到登录页疑似命中过期前端壳（main=${brokenLoginEntry.mainAppScript}，text=${brokenLoginEntry.bodyTextLength}），切换根路径重试：${fallbackUrl}`,
          )
          visitedUrls.clear()
          loggedSelectorDiagnostics.clear()
          actionCooldowns.clear()
          await flowPage.goto(fallbackUrl, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          })
          await flowPage.waitForTimeout(1_000)
          continue
        }
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
          await this.tryStartDirectLinuxDoOauthFlow(
            context,
            flowPage,
            account,
            profile,
            options,
          )
        ) {
          continue
        }
        const targetSiteLoginActionKey = `${currentUrl || targetHost}::target-site-login-entry`
        if (
          this.canAttemptFlowAction(actionCooldowns, targetSiteLoginActionKey) &&
          await this.clickFirstVisibleWithPopup(
            context,
            flowPage,
            this.buildSiteLoginEntrySelectors(profile),
          )
        ) {
          this.markFlowActionAttempt(
            actionCooldowns,
            targetSiteLoginActionKey,
            8_000,
          )
          await this.reportProgress(options, "已点击站点登录入口，等待 SSO 跳转")
          await this.waitForFlowTransition(flowPage, currentUrl, 8_000)
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
            const manualFollowup = await this.resolveRunAnytimeTurnstileFollowup(
              page,
              account,
              browserResponse.requestUrl,
              options,
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
            requestUrl: url.toString(),
            checkin: await parseJson(checkinResponse),
          }
        },
        {
          fallbackUserId:
            account.account_info.id > 0 ? String(account.account_info.id) : "",
          fallbackAccessToken: extractedAccessToken,
        },
      )

      let checkinResponse = browserResult.checkin
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

      let payload = checkinResponse.payload
      let message = resolvePayloadMessage(payload, checkinResponse.rawText)
      if (message.includes("Turnstile token 为空") && browserResult.requestUrl) {
        await this.reportProgress(
          options,
          "检测到 RunAnytime PoW 首次响应要求 Turnstile，尝试等待页面验证结果",
        )
        const followupResponse = await this.resolveRunAnytimeTurnstileFollowup(
          page,
          account,
          browserResult.requestUrl,
          options,
        )
        if (followupResponse) {
          if (followupResponse.statusCode !== 0) {
            checkinResponse = {
              statusCode: followupResponse.statusCode,
              rawText: followupResponse.rawText,
              payload: this.tryParseJsonRecord(followupResponse.rawText),
            }
            payload = checkinResponse.payload
            message = resolvePayloadMessage(payload, checkinResponse.rawText)
          }
        } else {
          await this.reportProgress(
            options,
            "RunAnytime Turnstile 页面验证结果仍不可用，保留首次 PoW 响应",
          )
        }
      }
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
    preferredTurnstileToken = "",
  ): Promise<
    | {
        statusCode: number
        rawText: string
        requestUrl: string
        diagnostics?: Record<string, unknown>
      }
    | null
  > {
    const extractedAccessToken = await this.extractAccessToken(page, {
      hostname: "runanytime.hxi.me",
      loginPath: "/login",
      loginButtonSelectors: [],
      successUrlPatterns: ["/console"],
      tokenStorageKeys: ["user", "token", "access_token"],
      postLoginSelectors: [],
    }).catch(() => "")

    const evaluated = await page
      .evaluate(
        async ({
          requestUrl,
          fallbackUserId,
          fallbackAccessToken,
          preferredTurnstileToken,
        }: {
          requestUrl: string
          fallbackUserId: string
          fallbackAccessToken: string
          preferredTurnstileToken: string
        }) => {
          const diagnostics: Record<string, unknown> = {
            phase: "init",
          }

          const sleep = (ms: number) =>
            new Promise((resolve) => {
              setTimeout(resolve, ms)
            })

          const waitForTurnstileToken = async (): Promise<string> => {
            const startedAt = Date.now()
            while (Date.now() - startedAt < 30_000) {
              const tokenField = document.querySelector(
                'input[name=\"cf-turnstile-response\"], textarea[name=\"cf-turnstile-response\"]',
              ) as HTMLInputElement | HTMLTextAreaElement | null
              const token = tokenField?.value?.trim() || ""
              if (token) {
                diagnostics.tokenSource = "existing_field"
                return token
              }
              await sleep(1_000)
            }
            return ""
          }

          const inferSiteKey = (): string => {
            const selectorCandidates = [
              '[data-sitekey]',
              '[data-turnstile-site-key]',
              '[data-site-key]',
            ]

            for (const selector of selectorCandidates) {
              const element = document.querySelector(selector) as HTMLElement | null
              const value =
                element?.getAttribute("data-sitekey") ||
                element?.getAttribute("data-turnstile-site-key") ||
                element?.getAttribute("data-site-key") ||
                ""
              if (value.trim()) {
                return value.trim()
              }
            }

            const scriptTexts = Array.from(document.scripts)
              .map((script) => script.textContent || "")
              .join("\n")
            const scriptMatch = scriptTexts.match(
              /turnstile(?:_|-)?site(?:_|-)?key["'\s:=]+([0-9A-Za-z_-]{10,})/iu,
            )
            if (scriptMatch?.[1]) {
              return scriptMatch[1].trim()
            }

            const storageCandidates = [
              localStorage.getItem("status") || "",
              localStorage.getItem("site_status") || "",
              sessionStorage.getItem("status") || "",
            ]
            for (const entry of storageCandidates) {
              if (!entry) continue
              try {
                const parsed = JSON.parse(entry) as Record<string, unknown>
                const value =
                  typeof parsed.turnstile_site_key === "string"
                    ? parsed.turnstile_site_key
                    : typeof parsed.turnstileSiteKey === "string"
                      ? parsed.turnstileSiteKey
                      : ""
                if (value.trim()) {
                  return value.trim()
                }
              } catch {
                continue
              }
            }

            return ""
          }

          const ensureStatusConfig = async (): Promise<void> => {
            const currentStatus =
              localStorage.getItem("status") ||
              sessionStorage.getItem("status") ||
              ""
            diagnostics.statusFromStorage = Boolean(currentStatus)
            if (currentStatus) {
              try {
                const parsed = JSON.parse(currentStatus) as Record<string, unknown>
                if (
                  typeof parsed.turnstile_site_key === "string" &&
                  parsed.turnstile_site_key.trim()
                ) {
                  diagnostics.statusStorageHasSiteKey = true
                  return
                }
              } catch {
                // Ignore malformed cached status and attempt a fresh fetch below.
                diagnostics.statusStorageMalformed = true
              }
            }

            try {
              diagnostics.statusFetchAttempted = true
              const response = await fetch("/api/status", {
                method: "GET",
                credentials: "include",
                headers: {
                  accept: "application/json, text/plain, */*",
                  "cache-control": "no-store",
                },
              })
              const rawText = await response.text()
              diagnostics.statusFetchHttpStatus = response.status
              const payload = JSON.parse(rawText) as {
                success?: boolean
                data?: Record<string, unknown>
              }
              if (payload?.success && payload.data && typeof payload.data === "object") {
                localStorage.setItem("status", JSON.stringify(payload.data))
                diagnostics.statusFetchStored = true
                diagnostics.statusFetchHasSiteKey =
                  typeof payload.data.turnstile_site_key === "string" &&
                  payload.data.turnstile_site_key.trim().length > 0
              }
            } catch {
              // Best effort only. Follow-up rendering will fail naturally if the site key remains unavailable.
              diagnostics.statusFetchFailed = true
            }
          }

          const obtainTokenViaRenderedWidget = async (): Promise<string> => {
            const ensureTurnstileApi = async (): Promise<
              | {
                  render?: (
                    container: HTMLElement | string,
                    options: Record<string, unknown>,
                  ) => string | number | undefined
                  execute?: (widgetId?: string | number) => Promise<unknown> | unknown
                  remove?: (widgetId?: string | number) => void
                }
              | undefined
            > => {
              const existingTurnstile = (window as Window & {
                turnstile?: {
                  render?: (
                    container: HTMLElement | string,
                    options: Record<string, unknown>,
                  ) => string | number | undefined
                  execute?: (widgetId?: string | number) => Promise<unknown> | unknown
                  remove?: (widgetId?: string | number) => void
                }
              }).turnstile
              if (existingTurnstile?.render) {
                diagnostics.turnstileApiSource = "window"
                return existingTurnstile
              }

              const existingScript = document.querySelector(
                'script[src*="challenges.cloudflare.com/turnstile/v0/api.js"]',
              ) as HTMLScriptElement | null

              const script =
                existingScript ||
                Object.assign(document.createElement("script"), {
                  src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
                  async: true,
                  defer: true,
                })

              if (!existingScript) {
                document.head.appendChild(script)
                diagnostics.turnstileScriptInjected = true
              } else {
                diagnostics.turnstileScriptInjected = false
              }

              const loaded = await new Promise<boolean>((resolve) => {
                const finish = (ok: boolean) => resolve(ok)
                if (
                  (window as Window & { turnstile?: { render?: unknown } }).turnstile?.render
                ) {
                  diagnostics.turnstileApiAlreadyReady = true
                  finish(true)
                  return
                }

                const timeoutId = window.setTimeout(() => finish(false), 15_000)
                script.addEventListener(
                  "load",
                  () => {
                    window.clearTimeout(timeoutId)
                    diagnostics.turnstileScriptLoaded = true
                    finish(true)
                  },
                  { once: true },
                )
                script.addEventListener(
                  "error",
                  () => {
                    window.clearTimeout(timeoutId)
                    diagnostics.turnstileScriptLoadError = true
                    finish(false)
                  },
                  { once: true },
                )
              })

              if (!loaded) {
                diagnostics.turnstileApiUnavailable = true
                return undefined
              }

              return (window as Window & {
                turnstile?: {
                  render?: (
                    container: HTMLElement | string,
                    options: Record<string, unknown>,
                  ) => string | number | undefined
                  execute?: (widgetId?: string | number) => Promise<unknown> | unknown
                  remove?: (widgetId?: string | number) => void
                }
              }).turnstile
            }

            const turnstile = await ensureTurnstileApi()
            if (!turnstile?.render) {
              diagnostics.phase = "turnstile_api_missing"
              diagnostics.hasTurnstileRender = false
              diagnostics.currentUrl = location.href
              diagnostics.localStorageKeys = Object.keys(localStorage)
              return ""
            }
            diagnostics.hasTurnstileRender = true

            await ensureStatusConfig()
            const siteKey = inferSiteKey()
            diagnostics.inferredSiteKeyLength = siteKey.length
            if (!siteKey) {
              diagnostics.phase = "site_key_missing"
              diagnostics.currentUrl = location.href
              diagnostics.localStorageKeys = Object.keys(localStorage)
              return ""
            }

            const existingContainer = document.getElementById(
              "__all_api_hub_runanytime_turnstile",
            )
            const container =
              existingContainer ||
              Object.assign(document.createElement("div"), {
                id: "__all_api_hub_runanytime_turnstile",
              })

            if (!existingContainer) {
              container.setAttribute(
                "style",
                "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:rgba(255,255,255,0.98);padding:16px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);min-width:320px;text-align:center;",
              )
              document.body.appendChild(container)
            } else {
              container.setAttribute(
                "style",
                "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:rgba(255,255,255,0.98);padding:16px;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,0.18);min-width:320px;text-align:center;",
              )
            }

            return await new Promise<string>((resolve) => {
              let settled = false
              const finish = (token = "") => {
                if (settled) return
                settled = true
                diagnostics.finalTokenLength = token.length
                resolve(token)
              }

              try {
                diagnostics.phase = "rendering_widget"
                const render = turnstile.render
                if (typeof render !== "function") {
                  diagnostics.renderMissing = true
                  finish("")
                  return
                }

                const widgetId = render(container, {
                  sitekey: siteKey,
                  callback: (token: unknown) => {
                    finish(typeof token === "string" ? token : "")
                  },
                  "error-callback": () => finish(""),
                  "expired-callback": () => finish(""),
                  "timeout-callback": () => finish(""),
                })

                diagnostics.phase = "widget_rendered"
                diagnostics.widgetId = widgetId == null ? "" : String(widgetId)
              } catch {
                diagnostics.renderFailed = true
                finish("")
              }

              void (async () => {
                const startedAt = Date.now()
                while (Date.now() - startedAt < 30_000) {
                  const token = await waitForTurnstileToken()
                  if (token) {
                    diagnostics.phase = "token_obtained"
                    finish(token)
                    return
                  }
                  await sleep(500)
                }
                diagnostics.phase = "token_timeout"
                finish("")
              })()
            })
          }

          let turnstileToken = preferredTurnstileToken.trim()
          diagnostics.preferredTokenProvided = Boolean(turnstileToken)
          if (!turnstileToken) {
            turnstileToken = await waitForTurnstileToken()
          }
          if (!turnstileToken) {
            diagnostics.phase = "render_widget_needed"
            turnstileToken = await obtainTokenViaRenderedWidget()
          }
          if (!turnstileToken) {
            return {
              statusCode: 0,
              rawText: "",
              requestUrl,
              diagnostics,
            }
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
            diagnostics,
          }
        },
        {
          requestUrl,
          fallbackUserId:
            account.account_info.id > 0 ? String(account.account_info.id) : "",
          fallbackAccessToken: extractedAccessToken,
          preferredTurnstileToken,
        },
      )
      .catch(() => null)

    if (!evaluated) {
      return null
    }

    if (evaluated.statusCode === 0) {
      const parts = Object.entries(evaluated.diagnostics || {})
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) =>
          `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
        )
      if (parts.length > 0) {
        // This path is intentionally noisy: it exists only for targeted RunAnytime debugging.
        // The caller logs the returned diagnostics summary when follow-up still cannot produce a token.
        return {
          ...evaluated,
          rawText: parts.join(" | "),
        }
      }
      return null
    }

    return evaluated
  }

  private async resolveRunAnytimeTurnstileFollowup(
    page: Page,
    account: SiteAccount,
    requestUrl: string,
    options: SessionRefreshOptions,
  ): Promise<
    | {
        statusCode: number
        rawText: string
        requestUrl: string
        diagnostics?: Record<string, unknown>
      }
    | null
  > {
    if (!this.resolveBrowserHeadless()) {
      const manualWaitTimeoutMs = this.config.manualLoginWaitTimeoutMs ?? 300_000
      const nativeFollowupTimeoutMs = Math.min(manualWaitTimeoutMs, 15_000)

      await this.reportProgress(options, "请在本机浏览器完成 RunAnytime Turnstile 验证")

      const nativeFollowupResponse = await this.waitForRunAnytimeNativeFollowupResponse(
        page,
        account,
        nativeFollowupTimeoutMs,
      )
      if (nativeFollowupResponse) {
        return nativeFollowupResponse
      }

      const manualToken = await this.waitForManualRunAnytimeTurnstileToken(
        page,
        options,
        {
          timeoutMs: Math.max(manualWaitTimeoutMs - nativeFollowupTimeoutMs, 0),
          suppressIntro: true,
        },
      )
      if (!manualToken) {
        return null
      }

      await this.reportProgress(
        options,
        "检测到人工完成 RunAnytime Turnstile 验证，重新提交签到请求",
      )

      return await this.performRunAnytimeTurnstileFollowup(
        page,
        account,
        requestUrl,
        manualToken,
      )
    }

    const followupResponse = await this.performRunAnytimeTurnstileFollowup(
      page,
      account,
      requestUrl,
    )

    if (!followupResponse || followupResponse.statusCode !== 0) {
      return followupResponse
    }

    await this.reportProgress(
      options,
      `RunAnytime Turnstile follow-up 诊断：${followupResponse.rawText || "<empty>"}`,
    )

    const manualToken = await this.waitForManualRunAnytimeTurnstileToken(
      page,
      options,
    )
    if (!manualToken) {
      return followupResponse
    }

    await this.reportProgress(
      options,
      "检测到人工完成 RunAnytime Turnstile 验证，重新提交签到请求",
    )

    return (
      (await this.performRunAnytimeTurnstileFollowup(
        page,
        account,
        requestUrl,
        manualToken,
      )) || followupResponse
    )
  }

  private async waitForRunAnytimeNativeFollowupResponse(
    page: Page,
    account: SiteAccount,
    timeoutMs: number,
  ): Promise<
    | {
        statusCode: number
        rawText: string
        requestUrl: string
      }
    | null
  > {
    if (timeoutMs <= 0) {
      return null
    }

    const apiUrl = joinUrl(normalizeBaseUrl(account.site_url), "/api/user/checkin")
    const response = await page
      .waitForResponse(
        (candidate) =>
          candidate.url().startsWith(apiUrl) &&
          candidate.url().toLowerCase().includes("turnstile=") &&
          candidate.request().method().toUpperCase() === "POST",
        { timeout: timeoutMs },
      )
      .catch(() => null)

    if (!response) {
      return null
    }

    return {
      statusCode: response.status(),
      rawText: await response.text().catch(() => ""),
      requestUrl: response.url(),
    }
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

  private extractJsonRecordFromFlareSolverrResponse(
    rawText: string,
  ): Record<string, unknown> | null {
    const directRecord = this.tryParseJsonRecord(rawText)
    if (directRecord) {
      return directRecord
    }

    const preMatch = rawText.match(/<pre[^>]*>([\s\S]*?)<\/pre>/iu)
    if (!preMatch) {
      return null
    }

    const normalized = preMatch[1]
      .replaceAll("&quot;", "\"")
      .replaceAll("&#39;", "'")
      .replaceAll("&amp;", "&")
      .trim()
    return this.tryParseJsonRecord(normalized)
  }

  private extractOauthStateFromFlareSolverrResponse(rawText: string): string {
    const record = this.extractJsonRecordFromFlareSolverrResponse(rawText)
    return typeof record?.data === "string" ? record.data : ""
  }

  private async readLinuxDoClientIdFromStatus(page: Page): Promise<string> {
    const pageWithEvaluate = page as Page & {
      evaluate?: <TResult>(pageFunction: () => TResult | Promise<TResult>) => Promise<TResult>
    }
    if (typeof pageWithEvaluate.evaluate !== "function") {
      return ""
    }

    return await page
      .evaluate(() => {
        try {
          const rawStatus = window.localStorage.getItem("status")
          const parsed = rawStatus ? JSON.parse(rawStatus) : null
          const clientId = parsed?.linuxdo_client_id ?? parsed?.linux_do_client_id
          return typeof clientId === "string" ? clientId : ""
        } catch {
          return ""
        }
      })
      .catch(() => "")
  }

  private async tryStartDirectLinuxDoOauthFlow(
    context: BrowserContext,
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<boolean> {
    if (!this.shouldUseLocalFlareSolverr(profile)) {
      return false
    }

    if (!this.getUrlPathname(page.url()).includes("/login")) {
      return false
    }

    if (!(await this.hasVisibleAnySelector(page, DIRECT_LINUXDO_LOGIN_SELECTORS))) {
      return false
    }

    const linuxDoClientId = await this.readLinuxDoClientIdFromStatus(page)
    if (!linuxDoClientId) {
      return false
    }

    await this.reportProgress(
      options,
      "检测到 New API LinuxDO 登录页，尝试直取 oauth state 并直连 Linux.do 授权页",
    )
    const oauthStateResult = await this.requestLocalBrowserChallengePrewarm(
      account,
      profile,
      options,
      joinUrl(account.site_url, "/api/oauth/state"),
    )
    if (!oauthStateResult) {
      return false
    }

    const oauthState = this.extractOauthStateFromFlareSolverrResponse(
      oauthStateResult.response ?? "",
    )
    if (!oauthState) {
      await this.reportProgress(
        options,
        "本地 FlareSolverr 已请求 /api/oauth/state，但未提取到 oauth state",
      )
      return false
    }

    const applied = await this.applyLocalBrowserChallengePrewarm(
      context,
      page,
      oauthStateResult,
      options,
    )
    if (!applied) {
      return false
    }

    const authUrl = new URL("https://connect.linux.do/oauth2/authorize")
    authUrl.searchParams.set("response_type", "code")
    authUrl.searchParams.set("client_id", linuxDoClientId)
    authUrl.searchParams.set("state", oauthState)

    await this.reportProgress(
      options,
      "已绕过站点失效的 LinuxDO 按钮，直接打开 Linux.do 授权页",
    )
    await page.goto(authUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    })
    return true
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

  private resolveRunAnytimeDebugRootOnlyPause(): boolean {
    return this.config.runAnytimeDebugRootOnlyPause ?? false
  }

  private async pauseRunAnytimeAtRootForDebug(
    page: Page,
    account: SiteAccount,
    options: SessionRefreshOptions,
  ): Promise<CheckinAccountResult> {
    const startedAt = Date.now()
    const targetBaseUrl = normalizeBaseUrl(account.site_url)

    await this.reportProgress(
      options,
      `RunAnytime 调试模式：打开站点根页面：${targetBaseUrl}`,
    )
    await page.goto(targetBaseUrl, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    })
    await this.reportProgress(
      options,
      `RunAnytime 调试模式：当前页面：${page.url()}`,
    )
    await this.reportProgress(
      options,
      "RunAnytime 调试模式：已暂停自动签到，请先在本机浏览器观察并手动处理登录状态",
    )
    await this.reportProgress(
      options,
      "RunAnytime 调试模式：保留当前浏览器窗口，供本机继续调试",
    )

    return {
      accountId: account.id,
      siteName: account.site_name,
      siteUrl: account.site_url,
      siteType: account.site_type,
      status: CheckinResultStatus.ManualActionRequired,
      code: "runanytime_debug_root_pause",
      message: "RunAnytime 调试模式已暂停自动签到，请先在本机浏览器观察并手动处理登录状态",
      startedAt,
      completedAt: Date.now(),
      checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
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

  private async waitForCloudflareChallengeToClear(
    page: Page,
    settings?: {
      timeoutMs?: number
      intervalMs?: number
    },
  ): Promise<boolean> {
    const timeoutMs = settings?.timeoutMs ?? LOCAL_BROWSER_CF_AUTO_CLEAR_WAIT_MS
    const intervalMs = settings?.intervalMs ?? 1_000
    const maxChecks = Math.max(1, Math.ceil(timeoutMs / intervalMs))
    const pageWithWaitForLoadState = page as Page & {
      waitForLoadState?: (
        state?: "load" | "domcontentloaded" | "networkidle",
        options?: { timeout?: number },
      ) => Promise<unknown>
    }
    const pageWithWaitForTimeout = page as Page & {
      waitForTimeout?: (timeoutMs: number) => Promise<unknown>
    }

    for (let attempt = 0; attempt < maxChecks; attempt += 1) {
      if (!(await this.detectCloudflareChallenge(page))) {
        return true
      }

      if (attempt >= maxChecks - 1) {
        break
      }

      if (typeof pageWithWaitForLoadState.waitForLoadState === "function") {
        await pageWithWaitForLoadState
          .waitForLoadState("domcontentloaded", { timeout: intervalMs })
          .catch(() => undefined)
      }

      if (typeof pageWithWaitForTimeout.waitForTimeout === "function") {
        await pageWithWaitForTimeout.waitForTimeout(intervalMs).catch(() => undefined)
        continue
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }

    return !(await this.detectCloudflareChallenge(page))
  }

  private resolveLocalBrowserProfile(
    _profile: SiteLoginProfile,
  ): LocalBrowserProfile | null {
    // The local-browser worker path has been removed. Keep parsing legacy
    // profile fields for backward compatibility, but never let cloud runtime
    // execute local-browser-only behavior again.
    return null
  }

  private shouldAllowManualFallback(
    account: SiteAccount,
    profile: SiteLoginProfile,
  ): boolean {
    const localProfile = this.resolveLocalBrowserProfile(profile)
    if (!localProfile) {
      return true
    }

    if (localProfile.manualFallbackPolicyExplicit) {
      return localProfile.manualFallbackPolicy !== "disabled"
    }

    if (this.isRunAnytimeSite(account)) {
      return false
    }

    return localProfile.manualFallbackPolicy !== "disabled"
  }

  private shouldOpenSiteRootBeforeCheckin(profile: SiteLoginProfile): boolean {
    return this.resolveLocalBrowserProfile(profile)?.openRootBeforeCheckin === true
  }

  private buildSiteLoginEntrySelectors(profile: SiteLoginProfile): string[] {
    return [...new Set([...profile.loginButtonSelectors, ...COMMON_LOGIN_ENTRY_SELECTORS])]
  }

  private shouldRetryBrowserChallengeWithLocalPrewarm(
    profile: SiteLoginProfile,
  ): boolean {
    const localProfile = this.resolveLocalBrowserProfile(profile)
    return Boolean(
      localProfile?.allowRetryAfterBrowserChallenge &&
        this.shouldUseLocalFlareSolverr(profile),
    )
  }

  private requiresLocalFlareSolverrPrewarm(profile: SiteLoginProfile): boolean {
    const localProfile = this.resolveLocalBrowserProfile(profile)
    return Boolean(localProfile && localProfile.cloudflareMode === "prewarm")
  }

  private isRunAnytimeLoginPage(url: string): boolean {
    try {
      const parsed = new URL(url)
      return (
        parsed.hostname.toLowerCase() === "runanytime.hxi.me" &&
        parsed.pathname.includes("/login")
      )
    } catch {
      return false
    }
  }

  private isRunAnytimeExpiredLoginPage(url: string): boolean {
    try {
      const parsed = new URL(url)
      return (
        parsed.hostname.toLowerCase() === "runanytime.hxi.me" &&
        parsed.pathname.includes("/login") &&
        parsed.searchParams.get("expired") === "true"
      )
    } catch {
      return false
    }
  }

  private shouldUseLocalFlareSolverr(profile: SiteLoginProfile): boolean {
    if (!this.requiresLocalFlareSolverrPrewarm(profile)) {
      return false
    }

    return Boolean(
      this.config.localFlareSolverr?.enabled && this.config.localFlareSolverr.url,
    )
  }

  private resolveInitialPrewarmLaunchUserAgent(
    initialPrewarmResult: InitialLocalBrowserPrewarmResult | null,
  ): string | undefined {
    if (initialPrewarmResult?.kind !== "applied") {
      return undefined
    }

    return initialPrewarmResult.result.userAgent || undefined
  }

  private buildLocalFlareSolverrTargetUrl(
    account: SiteAccount,
    profile: SiteLoginProfile,
    targetUrl?: string,
  ): string {
    if (targetUrl) {
      return targetUrl
    }

    const localProfile = this.resolveLocalBrowserProfile(profile)
    const targetPath =
      localProfile?.flareSolverrTargetPath ||
      (localProfile?.flareSolverrScope === "root"
        ? "/"
        : localProfile?.flareSolverrScope === "checkin"
          ? resolveCheckInPath(account.site_type)
          : profile.loginPath)

    return joinUrl(account.site_url, targetPath)
  }

  private buildPersistentContextLaunchOptions(userAgent?: string): Parameters<
    typeof chromium.launchPersistentContext
  >[1] {
    return {
      executablePath: this.config.chromiumExecutablePath,
      headless: this.resolveBrowserHeadless(),
      args: this.resolveChromiumLaunchArgs(),
      viewport: { width: 1400, height: 960 },
      ...(userAgent ? { userAgent } : {}),
    }
  }

  private async clearTargetSiteCloudflareCookies(
    context: BrowserContext,
    account: SiteAccount,
    options: SessionRefreshOptions,
  ): Promise<void> {
    const browserContext = context as BrowserContext & {
      cookies?: BrowserContext["cookies"]
      clearCookies?: BrowserContext["clearCookies"]
    }
    if (
      typeof browserContext.cookies !== "function" ||
      typeof browserContext.clearCookies !== "function"
    ) {
      return
    }

    const targetHost = this.getUrlHostname(account.site_url)
    if (!targetHost) {
      return
    }

    const cookieDomains = Array.from(
      new Set(
        (await browserContext.cookies().catch(() => []))
          .filter((cookie) =>
            /^(__cf_bm|cf_clearance)$/i.test(cookie.name) &&
            this.isSameOrSubdomain(
              targetHost,
              cookie.domain.replace(/^\./u, "").toLowerCase(),
            ),
          )
          .map((cookie) => cookie.domain.replace(/^\./u, "").toLowerCase()),
      ),
    )

    for (const domain of cookieDomains) {
      await browserContext.clearCookies({
        name: /^(__cf_bm|cf_clearance)$/i,
        domain: new RegExp(`^\\.?${this.escapeRegex(domain)}$`, "iu"),
      })
      await this.reportProgress(
        options,
        `已清理目标站点残留 Cloudflare cookie：${domain}`,
      )
    }
  }

  private buildLocalFlareSolverrUnavailableSessionResult(): SessionRefreshResult {
    return {
      status: "failed",
      code: "local_flaresolverr_unavailable",
      message: "本地 FlareSolverr 不可用，无法执行预热模式",
    }
  }

  private buildLocalFlareSolverrUnavailableCheckinResult(
    account: SiteAccount,
  ): CheckinAccountResult {
    const now = Date.now()
    return {
      accountId: account.id,
      siteName: account.site_name,
      siteUrl: account.site_url,
      siteType: account.site_type,
      status: CheckinResultStatus.Failed,
      code: "local_flaresolverr_unavailable",
      message: "本地 FlareSolverr 不可用，无法执行预热模式",
      startedAt: now,
      completedAt: now,
      checkInUrl: joinUrl(account.site_url, resolveCheckInPath(account.site_type)),
    }
  }

  private resolveLocalFlareSolverrUrl(): string | null {
    if (!this.config.localFlareSolverr?.enabled || !this.config.localFlareSolverr.url) {
      return null
    }

    return this.config.localFlareSolverr.url
  }

  private async requestInitialLocalBrowserChallengePrewarm(
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<InitialLocalBrowserPrewarmResult | null> {
    const localFlareSolverrUrl = this.resolveLocalFlareSolverrUrl()
    if (!localFlareSolverrUrl) {
      return null
    }

    const targetUrl = this.buildLocalFlareSolverrTargetUrl(account, profile)

    await this.reportProgress(options, `开始本地 FlareSolverr 预热：${targetUrl}`)

    try {
      const result = await solveCloudflareChallenge(
        localFlareSolverrUrl,
        targetUrl,
        this.fetchImpl,
        (msg) => this.reportProgress(options, `[本地 FlareSolverr] ${msg}`),
        this.config.localFlareSolverr
          ? {
              maxTimeoutMs: this.config.localFlareSolverr.timeoutMs,
              requestTimeoutMs: this.config.localFlareSolverr.timeoutMs,
              allowEmptyCookies: true,
            }
          : undefined,
      )

      if (!result) {
        await this.reportProgress(options, "本地 FlareSolverr 预热失败")
        return null
      }

      if (result.cookies.length === 0) {
        return {
          kind: "no_cookies",
          userAgent: result.userAgent || null,
          message: result.message ?? "",
        }
      }

      return {
        kind: "applied",
        result,
      }
    } catch {
      await this.reportProgress(options, "本地 FlareSolverr 预热异常")
      return null
    }
  }

  private async requestLocalBrowserChallengePrewarm(
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
    targetUrlOverride?: string,
  ): Promise<FlareSolverrResult | null> {
    const localFlareSolverrUrl = this.resolveLocalFlareSolverrUrl()
    if (!localFlareSolverrUrl) {
      return null
    }

    const targetUrl = this.buildLocalFlareSolverrTargetUrl(
      account,
      profile,
      targetUrlOverride,
    )

    await this.reportProgress(options, `开始本地 FlareSolverr 预热：${targetUrl}`)

    try {
      const result = await solveCloudflareChallenge(
        localFlareSolverrUrl,
        targetUrl,
        this.fetchImpl,
        (msg) => this.reportProgress(options, `[本地 FlareSolverr] ${msg}`),
        this.config.localFlareSolverr
          ? {
              maxTimeoutMs: this.config.localFlareSolverr.timeoutMs,
              requestTimeoutMs: this.config.localFlareSolverr.timeoutMs,
            }
          : undefined,
      )

      if (!result) {
        await this.reportProgress(options, "本地 FlareSolverr 预热失败")
        return null
      }

      return result
    } catch {
      await this.reportProgress(options, "本地 FlareSolverr 预热异常")
      return null
    }
  }

  private async applyLocalBrowserChallengePrewarm(
    context: BrowserContext,
    _page: Page,
    result: FlareSolverrResult,
    options: SessionRefreshOptions,
  ): Promise<LocalBrowserPrewarmApplyResult | null> {
    try {
      await context.addCookies(
        result.cookies.map((cookie) => ({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite as "Strict" | "Lax" | "None",
        })),
      )
      await this.reportProgress(
        options,
        `本地 FlareSolverr 注入 ${result.cookies.length} 个 challenge cookie`,
      )

      const userAgent = result.userAgent || null
      if (userAgent) {
        await this.reportProgress(
          options,
          "本地 FlareSolverr 返回求解 UA，但本地浏览器保留系统 Chrome 原生 UA",
        )
      }

      return {
        appliedCookies: result.cookies.length,
        userAgent,
      }
    } catch {
      await this.reportProgress(options, "本地 FlareSolverr 预热异常")
      return null
    }
  }

  private async prewarmLocalBrowserChallenge(
    context: BrowserContext,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
    targetUrlOverride?: string,
  ): Promise<LocalBrowserPrewarmApplyResult | null> {
    const result = await this.requestLocalBrowserChallengePrewarm(
      account,
      profile,
      options,
      targetUrlOverride,
    )
    if (!result) {
      return null
    }

    if (this.isInitialLocalBrowserPrewarmAppliedResult(result)) {
      const page = context.pages()[0] ?? (await context.newPage())
      return await this.applyLocalBrowserChallengePrewarm(
        context,
        page,
        result.result,
        options,
      )
    }

    if ("kind" in result) {
      if (result.kind !== "applied") {
        return null
      }
      return null
    }

    const page = context.pages()[0] ?? (await context.newPage())
    return await this.applyLocalBrowserChallengePrewarm(context, page, result, options)
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

  private resolveBrowserHeadless(): boolean {
    return this.config.browserHeadless ?? true
  }

  private resolveChromiumLaunchArgs(): string[] {
    return this.config.chromiumLaunchArgs ?? ["--no-sandbox", "--disable-dev-shm-usage"]
  }

  private async waitForManualLoginCompletion(
    page: Page,
    account: SiteAccount,
    profile: SiteLoginProfile,
    options: SessionRefreshOptions,
  ): Promise<Page | null> {
    if (this.resolveBrowserHeadless()) {
      return null
    }

    const timeoutMs = this.config.manualLoginWaitTimeoutMs ?? 300_000
    const targetHost = new URL(account.site_url).hostname.toLowerCase()
    await this.reportProgress(
      options,
      `检测到需要人工接管，请在本机浏览器完成登录或挑战；最长等待 ${Math.round(timeoutMs / 1_000)} 秒`,
    )
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (await this.isLoginSuccess(page, targetHost, profile)) {
        await this.reportProgress(options, "人工接管完成，继续执行后续步骤")
        return page
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(
        () => undefined,
      )
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    await this.reportProgress(options, "人工接管等待超时")
    return null
  }

  private async waitForManualRunAnytimeTurnstileToken(
    page: Page,
    options: SessionRefreshOptions,
    settings?: {
      timeoutMs?: number
      suppressIntro?: boolean
    },
  ): Promise<string> {
    if (this.resolveBrowserHeadless()) {
      return ""
    }

    const timeoutMs = settings?.timeoutMs ?? this.config.manualLoginWaitTimeoutMs ?? 300_000
    if (timeoutMs <= 0) {
      await this.reportProgress(options, "RunAnytime Turnstile 人工验证等待超时")
      return ""
    }

    if (!settings?.suppressIntro) {
      await this.reportProgress(
        options,
        `RunAnytime Turnstile 需要人工验证，请在本机浏览器完成挑战；最长等待 ${Math.round(timeoutMs / 1_000)} 秒`,
      )
    }

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const token = await page
        .evaluate(() => {
          const tokenField = document.querySelector(
            'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
          ) as HTMLInputElement | HTMLTextAreaElement | null
          return tokenField?.value?.trim() || ""
        })
        .catch(() => "")

      if (token) {
        await this.reportProgress(
          options,
          "检测到人工完成 RunAnytime Turnstile 验证，已获取 token",
        )
        return token
      }

      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(
        () => undefined,
      )
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    await this.reportProgress(options, "RunAnytime Turnstile 人工验证等待超时")
    return ""
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
    if (pathname.includes("/login") || pathname.includes("/auth")) {
      return false
    }

    if (await this.hasVisibleAnySelector(page, COMMON_PUBLIC_ENTRY_SELECTORS)) {
      return false
    }

    return await this.probeBrowserAuthenticatedSession(page, profile)
  }

  private async inspectBrokenLoginEntry(
    page: Page,
    profile: SiteLoginProfile,
  ): Promise<{
    mainAppScript: string
    bodyTextLength: number
  } | null> {
    const currentPath = this.normalizeComparablePath(this.getUrlPathname(page.url()))
    const loginPath = this.normalizeComparablePath(profile.loginPath)
    if (!loginPath || loginPath === "/" || currentPath !== loginPath) {
      return null
    }

    const snapshot = await page
      .evaluate(async () => {
        const root = document.getElementById("root")
        const bodyText = document.body?.innerText?.trim() || ""
        const mainAppScript =
          Array.from(document.querySelectorAll("script[src]"))
            .map((item) => item.getAttribute("src") || "")
            .find((src) => /\/assets\/index-[^/]+\.js(?:[?#].*)?$/iu.test(src)) || ""

        const resolveMainAppScriptStatus = async (): Promise<number> => {
          if (!mainAppScript) {
            return 0
          }

          try {
            const response = await fetch(mainAppScript, {
              method: "HEAD",
              cache: "no-store",
            })
            return response.status
          } catch {
            return 0
          }
        }

        return {
          readyState: document.readyState,
          rootChildren: root?.children.length ?? 0,
          rootHtmlLength: root?.innerHTML.length ?? 0,
          bodyTextLength: bodyText.length,
          mainAppScript,
          mainAppScriptStatus: await resolveMainAppScriptStatus(),
        }
      })
      .catch(() => null)

    if (!snapshot) {
      return null
    }

    const looksLikeBrokenSpaShell =
      snapshot.readyState === "complete" &&
      Boolean(snapshot.mainAppScript) &&
      (
        (
          snapshot.rootChildren === 0 &&
          snapshot.rootHtmlLength === 0 &&
          snapshot.bodyTextLength <= 80
        ) ||
        snapshot.mainAppScriptStatus >= 400
      )

    if (!looksLikeBrokenSpaShell) {
      return null
    }

    return {
      mainAppScript: snapshot.mainAppScript,
      bodyTextLength: snapshot.bodyTextLength,
    }
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
    const pageWithLocator = page as Page & {
      locator?: (selector: string) => {
        first: () => {
          count: () => Promise<number>
          isVisible: () => Promise<boolean>
        }
      }
    }
    if (typeof pageWithLocator.locator !== "function") {
      return false
    }

    const locator = page.locator(selector).first()
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      return false
    }

    return await locator.isVisible().catch(() => false)
  }

  private async hasVisibleAnySelector(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await this.hasVisibleSelector(page, selector)) {
        return true
      }
    }

    return false
  }

  private async probeBrowserAuthenticatedSession(
    page: Page,
    profile: SiteLoginProfile,
  ): Promise<boolean> {
    const pageWithEvaluate = page as Page & {
      evaluate?: <TArg, TResult>(
        pageFunction: (arg: TArg) => Promise<TResult> | TResult,
        arg: TArg,
      ) => Promise<TResult>
    }
    if (typeof pageWithEvaluate.evaluate !== "function") {
      return false
    }

    return await page
      .evaluate(async ({ tokenStorageKeys }) => {
        const tokenPattern = /access[_-]?token|token|jwt|auth/i
        const normalizeToken = (value: string): string => {
          const trimmed = value.trim()
          if (!trimmed) {
            return ""
          }

          try {
            const parsed = JSON.parse(trimmed) as unknown
            if (typeof parsed === "string") {
              return parsed.trim()
            }

            if (parsed && typeof parsed === "object") {
              const record = parsed as Record<string, unknown>
              const directToken =
                typeof record.access_token === "string"
                  ? record.access_token.trim()
                  : ""
              if (directToken) {
                return directToken
              }

              for (const [key, entryValue] of Object.entries(record)) {
                if (
                  tokenPattern.test(key) &&
                  typeof entryValue === "string" &&
                  entryValue.trim()
                ) {
                  return entryValue.trim()
                }
              }
            }
          } catch {
            return trimmed
          }

          return ""
        }

        const storages = [window.localStorage, window.sessionStorage]
        let accessToken = ""
        for (const storage of storages) {
          for (const key of tokenStorageKeys) {
            const rawValue = storage.getItem(key)
            if (!rawValue) {
              continue
            }
            accessToken = normalizeToken(rawValue)
            if (accessToken) {
              break
            }
          }

          if (accessToken) {
            break
          }
        }

        const headers = new Headers({
          Accept: "application/json, text/plain, */*",
        })
        if (accessToken) {
          headers.set(
            "Authorization",
            /^bearer\s+/iu.test(accessToken) ? accessToken : `Bearer ${accessToken}`,
          )
        }

        try {
          const response = await fetch("/api/user/self", {
            method: "GET",
            credentials: "include",
            headers,
          })
          if (!response.ok) {
            return false
          }

          const payload = (await response.json().catch(() => null)) as
            | Record<string, unknown>
            | null
          if (!payload || typeof payload !== "object") {
            return false
          }

          const payloadData =
            payload.data && typeof payload.data === "object"
              ? (payload.data as Record<string, unknown>)
              : payload.payload && typeof payload.payload === "object"
                ? (
                    (payload.payload as Record<string, unknown>).data ??
                    payload.payload
                  )
                : payload

          return Boolean(
            payloadData &&
              typeof payloadData === "object" &&
              Object.keys(payloadData as Record<string, unknown>).length > 0,
          )
        } catch {
          return false
        }
      }, { tokenStorageKeys: profile.tokenStorageKeys })
      .catch(() => false)
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

  private normalizeComparablePath(pathname: string): string {
    const normalized = pathname.trim().toLowerCase()
    if (!normalized || normalized === "/") {
      return "/"
    }

    return normalized.replace(/\/+$/u, "") || "/"
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
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
