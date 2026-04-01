import { describe, expect, it } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  HealthState,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"

import type { ServerConfig } from "../src/config.js"
import { PlaywrightSiteSessionService } from "../src/auth/playwrightSessionService.js"
import type { SiteLoginProfile } from "../src/auth/siteLoginProfiles.js"

const baseAccount: SiteAccount = {
  id: "acc-1",
  site_name: "Demo",
  site_url: "https://demo.example.com",
  health: { status: HealthState.Healthy },
  site_type: "new-api",
  exchange_rate: 7.2,
  account_info: {
    id: 1,
    access_token: "expired-token",
    username: "alice",
    quota: 0,
    today_prompt_tokens: 0,
    today_completion_tokens: 0,
    today_quota_consumption: 0,
    today_requests_count: 0,
    today_income: 0,
  },
  last_sync_time: 0,
  updated_at: 0,
  created_at: 0,
  notes: "",
  tagIds: [],
  disabled: false,
  excludeFromTotalBalance: false,
  authType: AuthType.AccessToken,
  checkIn: {
    enableDetection: true,
    autoCheckInEnabled: true,
  },
}

const baseProfile: SiteLoginProfile = {
  hostname: "demo.example.com",
  loginPath: "/login",
  loginButtonSelectors: ["button.login"],
  successUrlPatterns: ["/console"],
  tokenStorageKeys: ["access_token"],
  postLoginSelectors: [],
}

const baseConfig: ServerConfig = {
  port: 3000,
  databaseUrl: "postgres://demo",
  dataDirectory: "/tmp/all-api-hub",
  diagnosticsDirectory: "/tmp/all-api-hub/diagnostics",
  sharedSsoProfileDirectory: "/tmp/all-api-hub/profiles/cloud/linuxdo-github",
  chromiumExecutablePath: undefined,
  internalAdminToken: "secret",
  telegram: {
    botToken: "token",
    webhookSecret: "secret",
    adminChatId: "1",
  },
  importRepo: {
    owner: "owner",
    name: "repo",
    path: "backup.json",
    ref: "main",
    githubPat: "pat",
  },
  github: {
    username: "user",
    password: "pass",
    totpSecret: "totp",
    linuxdoBaseUrl: "https://linux.do",
  },
  flareSolverrUrl: null,
  siteLoginProfiles: {},
  siteLoginProfilesRepo: null,
  timeZone: "Asia/Shanghai",
  appVersion: "0.1.0",
  deploymentVersion: "0.1.0",
  gitCommitSha: undefined,
  gitCommitShortSha: undefined,
  gitBranch: undefined,
  gitCommitMessage: undefined,
  siteLoginProfilesSource: "env:SITE_LOGIN_PROFILES_JSON",
  siteLoginProfilesCount: 0,
}

function createStorage(entries: Record<string, string>): Storage {
  const keys = Object.keys(entries)
  return {
    get length() {
      return keys.length
    },
    clear() {
      for (const key of keys) {
        delete entries[key]
      }
      keys.splice(0, keys.length)
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : null
    },
    key(index: number) {
      return keys[index] ?? null
    },
    removeItem(key: string) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        return
      }
      delete entries[key]
      const nextIndex = keys.indexOf(key)
      if (nextIndex >= 0) {
        keys.splice(nextIndex, 1)
      }
    },
    setItem(key: string, value: string) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) {
        keys.push(key)
      }
      entries[key] = value
    },
  }
}

describe("PlaywrightSiteSessionService", () => {
  it("retries /api/user/self after login until the session becomes readable", async () => {
    const progress: string[] = []
    const waits: number[] = []
    const seenAuthHeaders: string[] = []
    let selfCalls = 0

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          selfCalls += 1
          const headers = new Headers(init?.headers)
          seenAuthHeaders.push(headers.get("Authorization") || "")

          if (selfCalls === 1) {
            return new Response(
              JSON.stringify({
                success: false,
                message: "认证尚未生效",
              }),
              { status: 401 },
            )
          }

          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: 1,
                username: "alice",
                quota: 42,
              },
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return []
      },
    }
    const page = {
      url() {
        return baseAccount.site_url
      },
      async evaluate() {
        return "fresh-token"
      },
      async waitForTimeout(ms: number) {
        waits.push(ms)
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(page, context, baseAccount, baseProfile, {
      onProgress(message) {
        progress.push(message)
      },
    })

    expect(result?.account_info.access_token).toBe("fresh-token")
    expect(result?.account_info.quota).toBe(42)
    expect(selfCalls).toBe(2)
    expect(waits).toEqual([1000])
    expect(seenAuthHeaders).toEqual([
      "Bearer fresh-token",
      "Bearer fresh-token",
    ])
    expect(progress).toContain("调用 /api/user/self 校验登录状态")
  })

  it("navigates back to the site root before extracting auth when the page is still on /login", async () => {
    const progress: string[] = []
    let currentUrl = "https://demo.example.com/login"
    let selfCalls = 0

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          selfCalls += 1
          const headers = new Headers(init?.headers)
          const auth = headers.get("Authorization")
          return new Response(
            JSON.stringify({
              success: Boolean(auth),
              data: auth
                ? {
                    id: 1,
                    username: "alice",
                    quota: 42,
                  }
                : null,
              message: auth ? "" : "未登录且未提供 access token",
            }),
            { status: auth ? 200 : 401 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return []
      },
    }
    const page = {
      url() {
        return currentUrl
      },
      async goto(url: string) {
        currentUrl = url
      },
      async evaluate() {
        return currentUrl.endsWith("/login") ? "" : "fresh-token"
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(page, context, baseAccount, baseProfile, {
      onProgress(message) {
        progress.push(message)
      },
    })

    expect(selfCalls).toBe(1)
    expect(currentUrl).toBe("https://demo.example.com")
    expect(result?.account_info.access_token).toBe("fresh-token")
    expect(progress).toContain("返回目标站点页面：https://demo.example.com")
  })

  it("waits for an access token even when /api/user/self already succeeds with cookie auth", async () => {
    const waits: number[] = []
    let tokenReads = 0

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: 1,
                username: "alice",
                quota: 42,
              },
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [{ name: "sid", value: "cookie-auth" }]
      },
    }
    const page = {
      url() {
        return baseAccount.site_url
      },
      async evaluate(_fn?: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          tokenReads += 1
          return tokenReads >= 3 ? "fresh-token" : ""
        }

        return ""
      },
      async waitForTimeout(ms: number) {
        waits.push(ms)
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(page, context, baseAccount, baseProfile, {})

    expect(result?.account_info.access_token).toBe("fresh-token")
    expect(waits).toEqual([1000, 1000])
  })

  it("accepts cookie-only authenticated sessions for api.ouu.ch", async () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          return new Response(
            JSON.stringify({
              success: headers.get("Cookie") === "session=abc; signature=def; cf_clearance=ghi",
              data: {
                id: 4761,
                username: "linuxdo_4761",
                quota: 29_000_000,
              },
              message: "",
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [
          { name: "session", value: "abc" },
          { name: "signature", value: "def" },
          { name: "cf_clearance", value: "ghi" },
        ]
      },
    }
    const page = {
      url() {
        return "https://api.ouu.ch/console/personal"
      },
      async evaluate() {
        return ""
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(
      page,
      context,
      {
        ...baseAccount,
        site_name: "OuuAPI",
        site_url: "https://api.ouu.ch",
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        authType: AuthType.Cookie,
      },
      {
        ...baseProfile,
        hostname: "api.ouu.ch",
      },
      {},
    )

    expect(result?.authType).toBe(AuthType.Cookie)
    expect(result?.account_info.access_token).toBe("")
    expect(result?.cookieAuth?.sessionCookie).toBe(
      "session=abc; signature=def; cf_clearance=ghi",
    )
    expect(result?.account_info.id).toBe(4761)
  })

  it("accepts cookie-only authenticated sessions for kfc-api.sxxe.net", async () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          return new Response(
            JSON.stringify({
              success: headers.get("Cookie") === "session=abc",
              data: {
                id: 7437,
                username: "linuxdo_7437",
                quota: 121_000_000,
              },
              message: "",
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [{ name: "session", value: "abc" }]
      },
    }
    const page = {
      url() {
        return "https://kfc-api.sxxe.net/console/personal"
      },
      async evaluate() {
        return ""
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(
      page,
      context,
      {
        ...baseAccount,
        site_name: "KFC API",
        site_url: "https://kfc-api.sxxe.net",
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        authType: AuthType.Cookie,
      },
      {
        ...baseProfile,
        hostname: "kfc-api.sxxe.net",
      },
      {},
    )

    expect(result?.authType).toBe(AuthType.Cookie)
    expect(result?.account_info.access_token).toBe("")
    expect(result?.cookieAuth?.sessionCookie).toBe("session=abc")
    expect(result?.account_info.id).toBe(7437)
  })

  it("navigates to the Ouu check-in page before capturing cookie-only auth so the signature cookie is present", async () => {
    let currentUrl = "https://api.ouu.ch/login"

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          return new Response(
            JSON.stringify({
              success: headers.get("Cookie")?.includes("signature=def") === true,
              data: {
                id: 4761,
                username: "linuxdo_4761",
                quota: 29_000_000,
              },
              message: "",
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return currentUrl.endsWith("/console/personal")
          ? [
              { name: "session", value: "abc" },
              { name: "signature", value: "def" },
              { name: "cf_clearance", value: "ghi" },
            ]
          : [
              { name: "session", value: "abc" },
              { name: "cf_clearance", value: "ghi" },
            ]
      },
    }
    const page = {
      url() {
        return currentUrl
      },
      async goto(url: string) {
        currentUrl = url
      },
      async evaluate() {
        return ""
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(
      page,
      context,
      {
        ...baseAccount,
        site_name: "OuuAPI",
        site_url: "https://api.ouu.ch",
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        authType: AuthType.Cookie,
      },
      {
        ...baseProfile,
        hostname: "api.ouu.ch",
      },
      {},
    )

    expect(currentUrl).toBe("https://api.ouu.ch/console/personal")
    expect(result?.cookieAuth?.sessionCookie).toContain("signature=def")
  })

  it("merges document.cookie into the saved cookie bundle for Ouu refresh", async () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          return new Response(
            JSON.stringify({
              success:
                headers.get("Cookie") ===
                "session=abc; cf_clearance=ghi; signature=def",
              data: {
                id: 4761,
                username: "linuxdo_4761",
                quota: 29_000_000,
              },
              message: "",
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [
          { name: "session", value: "abc" },
          { name: "cf_clearance", value: "ghi" },
        ]
      },
    }
    const page = {
      url() {
        return "https://api.ouu.ch/console/personal"
      },
      async evaluate(fn: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          return ""
        }

        if (typeof fn === "function") {
          return (fn as () => string)()
        }

        return ""
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const previousDocument = (globalThis as typeof globalThis & { document?: Document }).document
    ;(globalThis as typeof globalThis & { document?: Document }).document = {
      cookie: "signature=def",
    } as Document

    try {
      const result = await (service as unknown as {
        captureAuthenticatedAccount: (
          page: typeof page,
          context: typeof context,
          account: SiteAccount,
          profile: SiteLoginProfile,
          options: { onProgress?: (message: string) => void | Promise<void> },
        ) => Promise<SiteAccount | null>
      }).captureAuthenticatedAccount(
        page,
        context,
        {
          ...baseAccount,
          site_name: "OuuAPI",
          site_url: "https://api.ouu.ch",
          account_info: {
            ...baseAccount.account_info,
            access_token: "",
          },
          authType: AuthType.Cookie,
        },
        {
          ...baseProfile,
          hostname: "api.ouu.ch",
        },
        {},
      )

      expect(result?.cookieAuth?.sessionCookie).toBe(
        "session=abc; cf_clearance=ghi; signature=def",
      )
    } finally {
      if (previousDocument === undefined) {
        delete (globalThis as typeof globalThis & { document?: Document }).document
      } else {
        ;(globalThis as typeof globalThis & { document?: Document }).document = previousDocument
      }
    }
  })

  it("extracts access tokens from nested storage payloads under generic keys", async () => {
    const progress: string[] = []
    let warnScriptInjected = false

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          return new Response(
            JSON.stringify({
              success:
                headers.get("Cookie") ===
                "session=abc; cf_clearance=ghi; signature=def",
              data: {
                id: 4761,
                username: "linuxdo_4761",
                quota: 29_000_000,
              },
              message: "",
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [
          { name: "session", value: "abc" },
          { name: "cf_clearance", value: "ghi" },
        ]
      },
    }
    const page = {
      url() {
        return "https://api.ouu.ch/console/personal"
      },
      async evaluate<TArg, TResult>(
        fn: ((arg: TArg) => TResult) | (() => TResult),
        arg?: TArg,
      ): Promise<TResult> {
        const source = String(fn)
        if (source.includes('localStorage.getItem("footer_html")')) {
          return {
            footerHtml:
              '<svg width="0" height="0" style="visibility:hidden;position:absolute;" onload="(function(){var s=document.createElement(\'script\');s.src=\'/newapiwarn/warnassets/script.js\';document.head.appendChild(s);})()"></svg>',
            hasWarnSvg: true,
            hasWarnScriptTag: warnScriptInjected,
            hasSignatureCookie: warnScriptInjected,
          } as TResult
        }

        if (source.includes('data-ouu-probe')) {
          warnScriptInjected = true
          return undefined as TResult
        }

        if (Array.isArray(arg)) {
          return "" as TResult
        }

        if (source.includes("document.cookie")) {
          return (warnScriptInjected ? "signature=def" : "") as TResult
        }

        return "" as TResult
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(
      page,
      context,
      {
        ...baseAccount,
        site_name: "OuuAPI",
        site_url: "https://api.ouu.ch",
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        authType: AuthType.Cookie,
      },
      {
        ...baseProfile,
        hostname: "api.ouu.ch",
      },
      {
        onProgress(message) {
          progress.push(message)
        },
      },
    )

    expect(warnScriptInjected).toBe(true)
    expect(result?.cookieAuth?.sessionCookie).toBe(
      "session=abc; cf_clearance=ghi; signature=def",
    )
    expect(progress).toContain("检测到 Ouu newapiwarn SVG 已渲染但未触发，手工注入签名脚本")
    expect(progress).toContain("已注入 Ouu newapiwarn 脚本，等待 signature cookie")
    expect(progress).toContain("已观察到 Ouu signature cookie")
  })

  it("extracts access tokens from nested storage payloads under generic keys", async () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input, init) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          const headers = new Headers(init?.headers)
          const auth = headers.get("Authorization")
          return new Response(
            JSON.stringify({
              success: auth === "Bearer nested-token",
              data:
                auth === "Bearer nested-token"
                  ? {
                      id: 1,
                      username: "alice",
                      quota: 42,
                    }
                  : null,
              message: auth === "Bearer nested-token" ? "" : "未登录且未提供 access token",
            }),
            { status: auth === "Bearer nested-token" ? 200 : 401 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return []
      },
    }
    const page = {
      url() {
        return baseAccount.site_url
      },
      async evaluate<TArg, TResult>(
        fn: (arg: TArg) => TResult,
        arg: TArg,
      ): Promise<TResult> {
        const previousWindow = (globalThis as typeof globalThis & { window?: Window }).window
        ;(globalThis as typeof globalThis & { window?: Window }).window = {
          localStorage: createStorage({
            user: JSON.stringify({
              profile: {
                session: {
                  access_token: "nested-token",
                },
              },
            }),
          }),
          sessionStorage: createStorage({}),
          location: { href: baseAccount.site_url },
        } as unknown as Window

        try {
          return await fn(arg)
        } finally {
          if (previousWindow === undefined) {
            delete (globalThis as typeof globalThis & { window?: Window }).window
          } else {
            ;(globalThis as typeof globalThis & { window?: Window }).window = previousWindow
          }
        }
      },
      async waitForTimeout() {
        return undefined
      },
    }

    const result = await (service as unknown as {
      captureAuthenticatedAccount: (
        page: typeof page,
        context: typeof context,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<SiteAccount | null>
    }).captureAuthenticatedAccount(page, context, baseAccount, baseProfile, {})

    expect(result?.account_info.access_token).toBe("nested-token")
  })

  it("can complete a browser-session check-in even when no access token is extracted", async () => {
    const progress: string[] = []
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async () => {
        throw new Error("unexpected node fetch call")
      },
    )

    const page = {
      url() {
        return "https://demo.example.com/console/personal"
      },
      async evaluate(_fn: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          return ""
        }
      },
      async goto() {
        return undefined
      },
      async route() {
        return undefined
      },
      async unroute() {
        return undefined
      },
      async waitForResponse() {
        return {
          url() {
            return "https://demo.example.com/api/user/checkin"
          },
          request() {
            return {
              method() {
                return "POST"
              },
            }
          },
          status() {
            return 200
          },
          async text() {
            return JSON.stringify({
              success: true,
              message: "签到成功",
            })
          },
        }
      },
      locator(selector: string) {
        return {
          first() {
            return {
              async count() {
                return selector.includes("Check in now") ? 1 : 0
              },
              async isVisible() {
                return selector.includes("Check in now")
              },
              async click() {
                return undefined
              },
            }
          },
        }
      },
    }

    const result = await (service as unknown as {
      performBrowserSessionCheckin: (
        page: typeof page,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<{
        status: CheckinResultStatus
        message: string
      }>
    }).performBrowserSessionCheckin(page, baseAccount, baseProfile, {
      onProgress(message) {
        progress.push(message)
      },
    })

    expect(result.status).toBe(CheckinResultStatus.Success)
    expect(result.message).toContain("已通过浏览器会话补签")
    expect(progress).toContain("使用浏览器上下文点击签到按钮")
  })

  it("uses the runanytime page button flow and waits for the follow-up turnstile response", async () => {
    const progress: string[] = []
    let routeCalls = 0
    let unrouteCalls = 0
    let responseCall = 0

    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async () => {
        throw new Error("unexpected node fetch call")
      },
    )

    const page = {
      url() {
        return "https://runanytime.hxi.me/console/personal"
      },
      async evaluate(_fn: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          return ""
        }
        return "Check in now"
      },
      async goto() {
        return undefined
      },
      async route() {
        routeCalls += 1
        return undefined
      },
      async unroute() {
        unrouteCalls += 1
        return undefined
      },
      async waitForResponse(
        predicate: (response: {
          url(): string
          request(): { method(): string }
        }) => boolean,
      ) {
        responseCall += 1
        if (responseCall === 1) {
          const response = {
            url() {
              return "https://runanytime.hxi.me/api/user/checkin?pow_challenge=abc&pow_nonce=1"
            },
            request() {
              return {
                method() {
                  return "POST"
                },
              }
            },
            status() {
              return 200
            },
            async text() {
              return JSON.stringify({
                success: false,
                message: "Turnstile token 为空",
              })
            },
          }
          expect(predicate(response)).toBe(true)
          return response
        }

        const response = {
          url() {
            return "https://runanytime.hxi.me/api/user/checkin?turnstile=cf-token&pow_challenge=abc&pow_nonce=2"
          },
          request() {
            return {
              method() {
                return "POST"
              },
            }
          },
          status() {
            return 200
          },
          async text() {
            return JSON.stringify({
              success: true,
              message: "签到成功",
              data: {
                quota_awarded: 12500000,
              },
            })
          },
        }
        expect(predicate(response)).toBe(true)
        return response
      },
      locator(selector: string) {
        return {
          first() {
            return {
              async count() {
                return selector.includes("立即签到") ? 1 : 0
              },
              async isVisible() {
                return selector.includes("立即签到")
              },
              async click() {
                return undefined
              },
            }
          },
        }
      },
    }

    const result = await (service as unknown as {
      performBrowserSessionCheckin: (
        page: typeof page,
        account: SiteAccount,
        profile: SiteLoginProfile,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<{
        status: CheckinResultStatus
        message: string
      }>
    }).performBrowserSessionCheckin(
      page,
      {
        ...baseAccount,
        site_name: "随时跑路公益站",
        site_url: "https://runanytime.hxi.me",
      },
      {
        ...baseProfile,
        hostname: "runanytime.hxi.me",
      },
      {
        onProgress(message) {
          progress.push(message)
        },
      },
    )

    expect(result.status).toBe(CheckinResultStatus.Success)
    expect(result.message).toContain("签到成功")
    expect(result.message).toContain("已通过浏览器会话补签")
    expect(result.message).toContain("获得")
    expect(responseCall).toBeGreaterThanOrEqual(2)
    expect(routeCalls).toBe(0)
    expect(unrouteCalls).toBe(0)
    expect(progress).toContain("RunAnytime 原生点击签到按钮：Check in now")
    expect(progress).toContain("使用浏览器上下文点击签到按钮")
    expect(progress).toContain("检测到首次签到响应要求 Turnstile，等待浏览器完成后续验证")
  })

  it("normalizes browser-session check-in headers so they do not expose HeadlessChrome", () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
    )

    const headers = (service as unknown as {
      buildBrowserSessionCheckinHeaders: (
        requestHeaders: Record<string, string>,
      ) => Record<string, string>
    }).buildBrowserSessionCheckinHeaders({
      "user-agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36",
      "sec-ch-ua":
        "\"Not:A-Brand\";v=\"99\", \"HeadlessChrome\";v=\"145\", \"Chromium\";v=\"145\"",
      "sec-ch-ua-platform": "\"Linux\"",
      accept: "application/json, text/plain, */*",
    })

    expect(headers["user-agent"]).not.toContain("HeadlessChrome")
    expect(headers["sec-ch-ua"]).not.toContain("HeadlessChrome")
    expect(headers["sec-ch-ua-platform"]).toBe("\"Windows\"")
    expect(headers["accept-language"]).toContain("zh-CN")
  })

  it("injects stored account cookies into the browser context for runanytime reuse", async () => {
    const progress: string[] = []
    const addedCookies: Array<Record<string, unknown>> = []
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
    )

    const count = await (service as unknown as {
      seedBrowserContextWithAccountCookies: (
        context: {
          addCookies: (cookies: Array<Record<string, unknown>>) => Promise<void>
        },
        account: SiteAccount,
        options: { onProgress?: (message: string) => void | Promise<void> },
      ) => Promise<number>
    }).seedBrowserContextWithAccountCookies(
      {
        async addCookies(cookies) {
          addedCookies.push(...cookies)
        },
      },
      {
        ...baseAccount,
        site_url: "https://runanytime.hxi.me",
        cookieAuth: {
          sessionCookie: "session=abc123; cf_clearance=clear456",
        },
      },
      {
        onProgress(message) {
          progress.push(message)
        },
      },
    )

    expect(count).toBe(2)
    expect(addedCookies).toHaveLength(2)
    expect(addedCookies[0]).toMatchObject({
      name: "session",
      value: "abc123",
      url: "https://runanytime.hxi.me",
      secure: true,
    })
    expect(addedCookies[1]).toMatchObject({
      name: "cf_clearance",
      value: "clear456",
    })
    expect(progress).toContain("注入 2 个账号会话 cookie")
  })

  it("treats the runanytime login page as ready once the turnstile token is populated", async () => {
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
    )

    const ready = await (service as unknown as {
      isRunAnytimeLoginReady: (
        page: { evaluate: (fn: unknown) => Promise<boolean> },
      ) => Promise<boolean>
    }).isRunAnytimeLoginReady({
      async evaluate() {
        return true
      },
    })

    expect(ready).toBe(true)
  })

  it("reports storage diagnostics when login succeeds but token extraction still fails", async () => {
    const progress: string[] = []
    const service = new PlaywrightSiteSessionService(
      {} as StorageRepository,
      baseConfig,
      async (input) => {
        if (typeof input === "string" && input.endsWith("/api/user/self")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: 1,
                username: "alice",
                quota: 42,
              },
            }),
            { status: 200 },
          )
        }

        throw new Error(`unexpected fetch input: ${String(input)}`)
      },
    )

    const context = {
      async cookies() {
        return [{ name: "sid", value: "cookie-auth" }]
      },
    }
    const page = {
      url() {
        return "https://demo.example.com/console"
      },
      async evaluate(_fn: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          return ""
        }

        return {
          currentUrl: "https://demo.example.com/console",
          localStorageKeys: ["persist:root", "auth-store"],
          sessionStorageKeys: ["sid"],
          globalHints: ["__NUXT__"],
        }
      },
      async waitForTimeout() {
        return undefined
      },
    }

    await expect(
      (service as unknown as {
        captureAuthenticatedAccount: (
          page: typeof page,
          context: typeof context,
          account: SiteAccount,
          profile: SiteLoginProfile,
          options: { onProgress?: (message: string) => void | Promise<void> },
        ) => Promise<SiteAccount | null>
      }).captureAuthenticatedAccount(page, context, baseAccount, baseProfile, {
        onProgress(message) {
          progress.push(message)
        },
      }),
    ).rejects.toThrow("登录成功但未提取到 access token")

    expect(progress.some((item) => item.includes("localStorage keys=persist:root, auth-store"))).toBe(true)
    expect(progress.some((item) => item.includes("globals=__NUXT__"))).toBe(true)
  })
})
