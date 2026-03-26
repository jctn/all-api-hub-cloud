import { CheckinResultStatus } from "@all-api-hub/core"
import { describe, expect, it, vi } from "vitest"

import { runSingleAccountCheckinWithAuthFallback } from "../src/telegram/accountActions.js"

describe("runSingleAccountCheckinWithAuthFallback", () => {
  it("refreshes and retries once when a single check-in fails with auth_invalid", async () => {
    const firstRun = {
      refreshedAccountIds: [],
      record: {
        id: "run-1",
        initiatedBy: "server" as const,
        targetAccountIds: ["acc-1"],
        startedAt: 1,
        completedAt: 2,
        summary: {
          total: 1,
          success: 0,
          alreadyChecked: 0,
          failed: 1,
          manualActionRequired: 0,
          skipped: 0,
        },
        results: [
          {
            accountId: "acc-1",
            siteName: "OuuAPI",
            siteUrl: "https://api.ouu.ch",
            siteType: "new-api",
            status: CheckinResultStatus.Failed,
            code: "auth_invalid",
            message: "认证失效，请重新登录",
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
    }

    const retryRun = {
      refreshedAccountIds: ["acc-1"],
      record: {
        ...firstRun.record,
        id: "run-2",
        summary: {
          ...firstRun.record.summary,
          success: 1,
          failed: 0,
        },
        results: [
          {
            ...firstRun.record.results[0],
            status: CheckinResultStatus.Success,
            code: undefined,
            message: "签到成功",
          },
        ],
      },
    }

    const runCheckinBatch = vi
      .fn()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(retryRun)
    const refreshSessions = vi.fn().mockResolvedValue({
      startedAt: 3,
      completedAt: 4,
      summary: {
        total: 1,
        refreshed: 1,
        manualActionRequired: 0,
        unsupportedAutoReauth: 0,
        failed: 0,
      },
      results: [
        {
          accountId: "acc-1",
          siteName: "OuuAPI",
          status: "refreshed" as const,
          message: "站点会话已刷新",
        },
      ],
    })

    const result = await runSingleAccountCheckinWithAuthFallback(
      {
        id: "acc-1",
        site_name: "OuuAPI",
      },
      {
        runCheckinBatch,
        refreshSessions,
      },
    )

    expect(runCheckinBatch).toHaveBeenNthCalledWith(1, {
      accountId: "acc-1",
      mode: "manual",
    })
    expect(refreshSessions).toHaveBeenCalledWith("acc-1")
    expect(runCheckinBatch).toHaveBeenNthCalledWith(2, {
      accountId: "acc-1",
      mode: "manual",
    })
    expect(result.record.results[0].message).toContain("已自动刷新会话后重试成功")
  })

  it("returns the original result when failure is unrelated to auth", async () => {
    const firstRun = {
      refreshedAccountIds: [],
      record: {
        id: "run-1",
        initiatedBy: "server" as const,
        targetAccountIds: ["acc-1"],
        startedAt: 1,
        completedAt: 2,
        summary: {
          total: 1,
          success: 0,
          alreadyChecked: 0,
          failed: 1,
          manualActionRequired: 0,
          skipped: 0,
        },
        results: [
          {
            accountId: "acc-1",
            siteName: "OuuAPI",
            siteUrl: "https://api.ouu.ch",
            siteType: "new-api",
            status: CheckinResultStatus.Failed,
            code: "network_error",
            message: "网络请求失败",
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
    }

    const runCheckinBatch = vi.fn().mockResolvedValue(firstRun)
    const refreshSessions = vi.fn()

    const result = await runSingleAccountCheckinWithAuthFallback(
      {
        id: "acc-1",
        site_name: "OuuAPI",
      },
      {
        runCheckinBatch,
        refreshSessions,
      },
    )

    expect(refreshSessions).not.toHaveBeenCalled()
    expect(result).toBe(firstRun)
  })

  it("annotates the final message when auth refresh succeeds but retry still fails", async () => {
    const firstRun = {
      refreshedAccountIds: [],
      record: {
        id: "run-1",
        initiatedBy: "server" as const,
        targetAccountIds: ["acc-1"],
        startedAt: 1,
        completedAt: 2,
        summary: {
          total: 1,
          success: 0,
          alreadyChecked: 0,
          failed: 1,
          manualActionRequired: 0,
          skipped: 0,
        },
        results: [
          {
            accountId: "acc-1",
            siteName: "OuuAPI",
            siteUrl: "https://api.ouu.ch",
            siteType: "new-api",
            status: CheckinResultStatus.Failed,
            code: "auth_invalid",
            message: "认证失效，请重新登录",
            startedAt: 1,
            completedAt: 2,
          },
        ],
      },
    }

    const retryRun = {
      refreshedAccountIds: ["acc-1"],
      record: {
        ...firstRun.record,
        id: "run-2",
        results: [
          {
            ...firstRun.record.results[0],
            message: "认证失效，请重新登录",
            completedAt: 3,
            startedAt: 2,
          },
        ],
      },
    }

    const runCheckinBatch = vi
      .fn()
      .mockResolvedValueOnce(firstRun)
      .mockResolvedValueOnce(retryRun)
    const refreshSessions = vi.fn().mockResolvedValue({
      startedAt: 3,
      completedAt: 4,
      summary: {
        total: 1,
        refreshed: 1,
        manualActionRequired: 0,
        unsupportedAutoReauth: 0,
        failed: 0,
      },
      results: [
        {
          accountId: "acc-1",
          siteName: "OuuAPI",
          status: "refreshed" as const,
          message: "站点会话已刷新",
        },
      ],
    })

    const result = await runSingleAccountCheckinWithAuthFallback(
      {
        id: "acc-1",
        site_name: "OuuAPI",
      },
      {
        runCheckinBatch,
        refreshSessions,
      },
    )

    expect(result.record.results[0].message).toContain("已自动刷新会话后重试仍失败")
  })
})
