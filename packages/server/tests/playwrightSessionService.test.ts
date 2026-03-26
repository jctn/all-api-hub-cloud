import { describe, expect, it } from "vitest"

import {
  AuthType,
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
})
