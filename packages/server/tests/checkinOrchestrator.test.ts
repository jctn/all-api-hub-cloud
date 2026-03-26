import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  FileSystemRepository,
  HealthState,
  type SiteAccount,
} from "@all-api-hub/core"

import { CheckinOrchestrator } from "../src/checkin/orchestrator.js"
import type {
  SessionRefreshResult,
  SiteSessionRefresher,
} from "../src/auth/playwrightSessionService.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})

async function createRepositoryWithAccounts(accounts: SiteAccount[]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aah-server-checkin-"))
  tempDirectories.push(directory)

  const repository = new FileSystemRepository(directory)
  await repository.initialize()
  await repository.replaceAccounts(accounts)
  return repository
}

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

describe("CheckinOrchestrator", () => {
  it("refreshes the session once and retries the account", async () => {
    const repository = await createRepositoryWithAccounts([baseAccount])
    const requests: string[] = []

    const refresher: SiteSessionRefresher = {
      async refreshSiteSession(): Promise<SessionRefreshResult> {
        return {
          status: "refreshed",
          message: "ok",
          account: {
            ...baseAccount,
            account_info: {
              ...baseAccount.account_info,
              access_token: "fresh-token",
            },
          },
        }
      },
    }

    const orchestrator = new CheckinOrchestrator(
      repository,
      {
        siteLoginProfiles: {
          "demo.example.com": {
            hostname: "demo.example.com",
            loginPath: "/login",
            loginButtonSelectors: ["button.login"],
            successUrlPatterns: ["/console"],
            tokenStorageKeys: ["access_token"],
            postLoginSelectors: [".avatar"],
          },
        },
      },
      refresher,
      async (_input, init) => {
        const headers = new Headers(init?.headers)
        requests.push(headers.get("Authorization") || "")
        const auth = headers.get("Authorization")

        if (auth === "Bearer expired-token") {
          return new Response(
            JSON.stringify({
              success: false,
              message: "无权进行此操作",
            }),
            { status: 401 },
          )
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    )

    const result = await orchestrator.runCheckinBatch({
      accountId: baseAccount.id,
      mode: "manual",
    })

    expect(result.refreshedAccountIds).toEqual(["acc-1"])
    expect(result.record.summary.success).toBe(1)
    expect(result.record.results[0].status).toBe(CheckinResultStatus.Success)
    expect(requests).toContain("Bearer expired-token")
    expect(requests).toContain("Bearer fresh-token")
  })

  it("refreshes scheduled accounts even when they were synced recently", async () => {
    const recentAccount: SiteAccount = {
      ...baseAccount,
      last_sync_time: Date.now(),
    }
    const repository = await createRepositoryWithAccounts([recentAccount])
    const requests: string[] = []
    let refreshAttempts = 0

    const refresher: SiteSessionRefresher = {
      async refreshSiteSession(account): Promise<SessionRefreshResult> {
        refreshAttempts += 1
        return {
          status: "refreshed",
          message: "ok",
          account: {
            ...account,
            account_info: {
              ...account.account_info,
              access_token: "fresh-token",
            },
          },
        }
      },
    }

    const orchestrator = new CheckinOrchestrator(
      repository,
      {
        siteLoginProfiles: {
          "demo.example.com": {
            hostname: "demo.example.com",
            loginPath: "/login",
            loginButtonSelectors: ["button.login"],
            successUrlPatterns: ["/console"],
            tokenStorageKeys: ["access_token"],
            postLoginSelectors: [".avatar"],
          },
        },
      },
      refresher,
      async (_input, init) => {
        const headers = new Headers(init?.headers)
        requests.push(headers.get("Authorization") || "")
        const auth = headers.get("Authorization")

        if (auth === "Bearer expired-token") {
          return new Response(
            JSON.stringify({
              success: false,
              message: "无权进行此操作",
            }),
            { status: 401 },
          )
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    )

    const result = await orchestrator.runCheckinBatch({
      mode: "scheduled",
    })

    expect(refreshAttempts).toBe(1)
    expect(result.refreshedAccountIds).toEqual(["acc-1"])
    expect(result.record.summary.success).toBe(1)
    expect(result.record.results[0].message).not.toContain("24小时内已刷新")
    expect(requests).toContain("Bearer expired-token")
    expect(requests).toContain("Bearer fresh-token")
  })

  it("falls back to browser-session check-in when refresh finds a logged-in cookie session but no token", async () => {
    const cookieOnlyAccount: SiteAccount = {
      ...baseAccount,
      account_info: {
        ...baseAccount.account_info,
        access_token: "",
      },
      authType: AuthType.Cookie,
      cookieAuth: {
        sessionCookie: "sid=stale-cookie",
      },
    }
    const repository = await createRepositoryWithAccounts([cookieOnlyAccount])

    const refresher = {
      async refreshSiteSession(): Promise<SessionRefreshResult> {
        return {
          status: "failed",
          message: "登录成功但未提取到 access token",
        }
      },
      async checkInWithBrowserSession(): Promise<CheckinAccountResult> {
        const now = Date.now()
        return {
          accountId: cookieOnlyAccount.id,
          siteName: cookieOnlyAccount.site_name,
          siteUrl: cookieOnlyAccount.site_url,
          siteType: cookieOnlyAccount.site_type,
          status: CheckinResultStatus.Success,
          message: "签到成功；已通过浏览器会话补签",
          startedAt: now,
          completedAt: now,
        }
      },
    } satisfies SiteSessionRefresher & {
      checkInWithBrowserSession: (
        account: SiteAccount,
      ) => Promise<CheckinAccountResult>
    }

    const orchestrator = new CheckinOrchestrator(
      repository,
      {
        siteLoginProfiles: {
          "demo.example.com": {
            hostname: "demo.example.com",
            loginPath: "/login",
            loginButtonSelectors: ["button.login"],
            successUrlPatterns: ["/console"],
            tokenStorageKeys: ["access_token"],
            postLoginSelectors: [".avatar"],
          },
        },
      },
      refresher,
      async (_input) =>
        new Response(
          JSON.stringify({
            success: false,
            message: "无权进行此操作",
          }),
          { status: 401 },
        ),
    )

    const result = await orchestrator.runCheckinBatch({
      accountId: cookieOnlyAccount.id,
      mode: "manual",
    })

    expect(result.refreshedAccountIds).toEqual([])
    expect(result.record.summary.success).toBe(1)
    expect(result.record.results[0].status).toBe(CheckinResultStatus.Success)
    expect(result.record.results[0].message).toContain("浏览器会话补签")
  })

  it("includes reward delta when anyrouter login refresh counts as a successful check-in", async () => {
    const anyrouterAccount: SiteAccount = {
      ...baseAccount,
      site_name: "AnyRouter",
      site_url: "https://anyrouter.example.com",
      site_type: "anyrouter",
      authType: AuthType.Cookie,
      account_info: {
        ...baseAccount.account_info,
        access_token: "",
        quota: 1_000_000,
        today_income: 0,
      },
      cookieAuth: {
        sessionCookie: "sid=expired",
      },
    }
    const repository = await createRepositoryWithAccounts([anyrouterAccount])

    const refresher: SiteSessionRefresher = {
      async refreshSiteSession(): Promise<SessionRefreshResult> {
        return {
          status: "refreshed",
          message: "ok",
          account: {
            ...anyrouterAccount,
            cookieAuth: {
              sessionCookie: "sid=fresh",
            },
            account_info: {
              ...anyrouterAccount.account_info,
              quota: 1_250_000,
            },
          },
        }
      },
    }

    const orchestrator = new CheckinOrchestrator(
      repository,
      {
        siteLoginProfiles: {
          "anyrouter.example.com": {
            hostname: "anyrouter.example.com",
            loginPath: "/login",
            loginButtonSelectors: ["button.login"],
            successUrlPatterns: ["/console"],
            tokenStorageKeys: ["access_token"],
            postLoginSelectors: [".avatar"],
          },
        },
      },
      refresher,
      async (input) => {
        const url = String(input)

        if (url.includes("/api/log/self") && url.includes("type=4")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 1,
                items: [
                  {
                    quota: 250_000,
                    content: "签到奖励",
                  },
                ],
              },
            }),
            { status: 200 },
          )
        }

        if (url.includes("/api/log/self")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                total: 0,
                items: [],
              },
            }),
            { status: 200 },
          )
        }

        return new Response(
          "<html>login required</html>",
          { status: 403 },
        )
      },
    )

    const result = await orchestrator.runCheckinBatch({
      accountId: anyrouterAccount.id,
      mode: "manual",
    })

    expect(result.refreshedAccountIds).toEqual([anyrouterAccount.id])
    expect(result.record.summary.success).toBe(1)
    expect(result.record.results[0].message).toContain("0.5")
    expect(result.record.results[0].message).toContain("今日收入 +0.5 刀")
  })

  it("emits progress messages during refreshSessions", async () => {
    const repository = await createRepositoryWithAccounts([baseAccount])
    const progress: string[] = []

    const refresher: SiteSessionRefresher = {
      async refreshSiteSession(
        _account,
        options,
      ): Promise<SessionRefreshResult> {
        await options?.onProgress?.("打开站点登录页")
        return {
          status: "manual_action_required",
          message: "登录流程超时",
        }
      },
    }

    const orchestrator = new CheckinOrchestrator(
      repository,
      {
        siteLoginProfiles: {},
      },
      refresher,
    )

    const result = await orchestrator.refreshSessions(baseAccount.id, {
      onProgress: async (message) => {
        progress.push(message)
      },
    })

    expect(result.summary.manualActionRequired).toBe(1)
    expect(progress).toEqual([
      `刷新进度 (1/1)：${baseAccount.site_name} (${baseAccount.id})`,
      `[${baseAccount.site_name}] 打开站点登录页`,
      `[${baseAccount.site_name}] 结果：需人工介入；登录流程超时`,
    ])
  })
})
