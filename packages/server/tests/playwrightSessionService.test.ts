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
    expect(progress).toContain("返回目标站点主页：https://demo.example.com")
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
      async evaluate() {
        tokenReads += 1
        return tokenReads >= 3 ? "fresh-token" : ""
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
        return "https://demo.example.com/console"
      },
      async evaluate(_fn: unknown, arg?: unknown) {
        if (Array.isArray(arg)) {
          return ""
        }

        return {
          statusCode: 200,
          rawText: JSON.stringify({
            success: true,
            message: "签到成功",
          }),
        }
      },
      async goto() {
        return undefined
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
    expect(progress).toContain("使用浏览器上下文调用 /api/user/checkin")
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
