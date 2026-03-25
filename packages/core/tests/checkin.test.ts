import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  FileSystemRepository,
  HealthState,
  executeCheckinRun,
  runAnyrouterCheckin,
  runNewApiCheckin,
  runWongCheckin,
} from "../src/index.js"
import { toLocalDayKey } from "../src/utils/date.js"

const baseAccount = {
  id: "acc-1",
  site_name: "Demo",
  site_url: "https://demo.example.com",
  site_type: "new-api",
  health: { status: HealthState.Healthy },
  exchange_rate: 7.2,
  account_info: {
    id: 1,
    access_token: "token",
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
  checkIn: { enableDetection: true },
}

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})

async function createRepositoryWithAccounts(accounts = [baseAccount]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aah-core-checkin-"))
  tempDirectories.push(directory)

  const repository = new FileSystemRepository(directory)
  await repository.initialize()
  await repository.replaceAccounts(accounts)

  return repository
}

describe("runNewApiCheckin", () => {
  it("recognizes a success response", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.Success)
  })

  it("appends reward details when the provider returns string amounts in payload.data", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
            data: {
              amount: "0.5",
            },
          }),
          { status: 200 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.Success)
    expect(result.message).toContain("0.5")
  })

  it("recognizes already-checked responses", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: "今天已经签到",
          }),
          { status: 200 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.AlreadyChecked)
  })

  it("marks turnstile messages as manual-action-required", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: "Turnstile 校验失败，请刷新重试",
          }),
          { status: 403 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.ManualActionRequired)
    expect(result.code).toBe("turnstile_required")
  })

  it("recognizes auth invalid responses", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: "无权进行此操作",
          }),
          { status: 401 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.Failed)
    expect(result.code).toBe("auth_invalid")
  })

  it("includes compatibility user-id headers for new-api deployments", async () => {
    let capturedHeaders: Headers | null = null

    await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    })

    expect(capturedHeaders?.get("New-API-User")).toBe("1")
    expect(capturedHeaders?.get("User-id")).toBe("1")
    expect(capturedHeaders?.get("Rix-Api-User")).toBe("1")
  })

  it("surfaces the nested network cause for fetch failures", async () => {
    const result = await runNewApiCheckin({
      account: baseAccount,
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("certificate has expired"),
        })
      },
    })

    expect(result.status).toBe(CheckinResultStatus.Failed)
    expect(result.code).toBe("network_error")
    expect(result.message).toContain("fetch failed")
    expect(result.message).toContain("certificate has expired")
  })

  it("normalizes imported cookie headers before sending the request", async () => {
    let capturedHeaders: Headers | null = null

    await runNewApiCheckin({
      account: {
        ...baseAccount,
        authType: AuthType.Cookie,
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        cookieAuth: {
          sessionCookie:
            "Cookie: session=abc123; Path=/; HttpOnly;\r\ncf_clearance=xyz789; Secure",
        },
      },
      fetchImpl: async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    })

    expect(capturedHeaders?.get("Cookie")).toBe("session=abc123; cf_clearance=xyz789")
  })
})

describe("runAnyrouterCheckin", () => {
  it("uses the anyrouter sign-in endpoint and treats empty success messages as already checked", async () => {
    let requestUrl = ""
    let capturedHeaders: Headers | null = null

    const result = await runAnyrouterCheckin({
      account: {
        ...baseAccount,
        site_type: "anyrouter",
        authType: AuthType.Cookie,
        account_info: {
          ...baseAccount.account_info,
          access_token: "",
        },
        cookieAuth: {
          sessionCookie: "sid=abc123",
        },
      },
      fetchImpl: async (input, init) => {
        requestUrl = String(input)
        capturedHeaders = new Headers(init?.headers)

        return new Response(
          JSON.stringify({
            success: true,
            message: "",
          }),
          { status: 200 },
        )
      },
    })

    expect(requestUrl).toBe("https://demo.example.com/api/user/sign_in")
    expect(capturedHeaders?.get("X-Requested-With")).toBe("XMLHttpRequest")
    expect(capturedHeaders?.get("Cookie")).toBe("sid=abc123")
    expect(result.status).toBe(CheckinResultStatus.AlreadyChecked)
  })
})

describe("runWongCheckin", () => {
  it("recognizes already-checked responses from checked_in=true", async () => {
    const result = await runWongCheckin({
      account: {
        ...baseAccount,
        site_name: "WONG公益站",
        site_type: "wong-gongyi",
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: false,
            message: "",
            data: {
              enabled: true,
              checked_in: true,
            },
          }),
          { status: 200 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.AlreadyChecked)
  })

  it("recognizes successful WONG check-ins", async () => {
    const result = await runWongCheckin({
      account: {
        ...baseAccount,
        site_name: "WONG公益站",
        site_type: "wong-gongyi",
      },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: "",
            data: {
              enabled: true,
              checked_in: false,
            },
          }),
          { status: 200 },
        ),
    })

    expect(result.status).toBe(CheckinResultStatus.Success)
  })
})

describe("executeCheckinRun", () => {
  it("treats scheduled accounts as already checked when local state says today is completed", async () => {
    const repository = await createRepositoryWithAccounts([
      {
        ...baseAccount,
        checkIn: {
          ...baseAccount.checkIn,
          autoCheckInEnabled: true,
          siteStatus: {
            isCheckedInToday: true,
            lastCheckInDate: toLocalDayKey(),
            lastDetectedAt: Date.now(),
          },
        },
      },
    ])

    const fetchMock = async () => {
      throw new Error("scheduled already-checked accounts should not hit the network")
    }

    const record = await executeCheckinRun({
      repository,
      initiatedBy: "server",
      mode: "scheduled",
      fetchImpl: fetchMock,
    })

    expect(record.summary.alreadyChecked).toBe(1)
    expect(record.summary.failed).toBe(0)
    expect(record.results[0].status).toBe(CheckinResultStatus.AlreadyChecked)
    expect(record.results[0].message).toBe("今天已经签到")
  })

  it("still checks the remote site in manual mode even if local state says today is completed", async () => {
    const repository = await createRepositoryWithAccounts([
      {
        ...baseAccount,
        checkIn: {
          ...baseAccount.checkIn,
          autoCheckInEnabled: true,
          siteStatus: {
            isCheckedInToday: true,
            lastCheckInDate: toLocalDayKey(),
            lastDetectedAt: Date.now(),
          },
        },
      },
    ])

    const requestedUrls: string[] = []

    const record = await executeCheckinRun({
      repository,
      initiatedBy: "server",
      mode: "manual",
      fetchImpl: async (input) => {
        requestedUrls.push(String(input))
        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    })

    expect(requestedUrls.some((url) => url.endsWith("/api/user/checkin"))).toBe(true)
    expect(record.summary.success).toBe(1)
  })

  it("syncs account_info.id from /api/user/self before check-in when the imported account lacks a user id", async () => {
    const repository = await createRepositoryWithAccounts([
      {
        ...baseAccount,
        account_info: {
          ...baseAccount.account_info,
          id: 0,
        },
      },
    ])

    const requests: Array<{ url: string; headers: Headers }> = []

    const record = await executeCheckinRun({
      repository,
      initiatedBy: "desktop",
      mode: "manual",
      targetAccountId: baseAccount.id,
      fetchImpl: async (input, init) => {
        const url = String(input)
        requests.push({
          url,
          headers: new Headers(init?.headers),
        })

        if (url.endsWith("/api/user/self")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                id: 42,
                username: "alice",
              },
            }),
            { status: 200 },
          )
        }

        if (url.endsWith("/api/user/checkin")) {
          return new Response(
            JSON.stringify({
              success: true,
              message: "签到成功",
            }),
            { status: 200 },
          )
        }

        throw new Error(`Unexpected URL: ${url}`)
      },
    })

    expect(record.summary.success).toBe(1)

    const checkinRequest = requests.find((request) => request.url.endsWith("/api/user/checkin"))
    expect(checkinRequest?.headers.get("New-API-User")).toBe("42")

    const savedAccount = await repository.getAccountById(baseAccount.id)
    expect(savedAccount?.account_info.id).toBe(42)
  })

  it("runs only the explicitly selected account subset when targetAccountIds is provided", async () => {
    const repository = await createRepositoryWithAccounts([
      baseAccount,
      {
        ...baseAccount,
        id: "acc-2",
        site_name: "Second",
        site_url: "https://second.example.com",
      },
      {
        ...baseAccount,
        id: "acc-3",
        site_name: "Third",
        site_url: "https://third.example.com",
      },
    ])

    const requestedUrls: string[] = []

    const record = await executeCheckinRun({
      repository,
      initiatedBy: "desktop",
      mode: "manual",
      targetAccountIds: ["acc-1", "acc-3"],
      fetchImpl: async (input) => {
        requestedUrls.push(String(input))
        return new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        )
      },
    })

    expect(record.summary.total).toBe(2)
    expect(record.results.map((result) => result.accountId)).toEqual(["acc-1", "acc-3"])
    expect(requestedUrls.some((url) => url.includes("second.example.com"))).toBe(false)
  })

  it("reports progress while running batch check-in", async () => {
    const repository = await createRepositoryWithAccounts([
      baseAccount,
      {
        ...baseAccount,
        id: "acc-2",
        site_name: "Second",
        site_url: "https://second.example.com",
      },
    ])

    const phases: Array<{
      phase: string
      processed: number
      total: number
      siteName?: string
    }> = []

    const record = await executeCheckinRun({
      repository,
      initiatedBy: "desktop",
      mode: "manual",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            message: "签到成功",
          }),
          { status: 200 },
        ),
      onProgress: async (progress) => {
        phases.push({
          phase: progress.phase,
          processed: progress.processed,
          total: progress.total,
          siteName: progress.siteName,
        })
      },
    })

    expect(record.summary.success).toBe(2)
    expect(phases[0]).toMatchObject({
      phase: "started",
      processed: 0,
      total: 2,
    })
    expect(phases).toContainEqual({
      phase: "account_started",
      processed: 0,
      total: 2,
      siteName: "Demo",
    })
    expect(phases).toContainEqual({
      phase: "account_completed",
      processed: 2,
      total: 2,
      siteName: "Second",
    })
    expect(phases.at(-1)).toMatchObject({
      phase: "completed",
      processed: 2,
      total: 2,
    })
  })
})
