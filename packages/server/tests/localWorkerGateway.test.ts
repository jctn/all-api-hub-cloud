import { describe, expect, it } from "vitest"

import {
  CheckinResultStatus,
  type SiteAccount,
} from "@all-api-hub/core"

import { type BatchCheckinRunResult } from "../src/checkin/orchestrator.js"
import { PollingLocalWorkerExecutionGateway } from "../src/localWorker/gateway.js"
import { InMemoryLocalWorkerTaskStore } from "../src/localWorker/taskStore.js"

function createAccount(overrides: Partial<SiteAccount> = {}): SiteAccount {
  const now = Date.now()
  return {
    id: overrides.id ?? "account-1",
    site_name: overrides.site_name ?? "RunAnytime",
    site_url: overrides.site_url ?? "https://runanytime.example.com",
    site_type: overrides.site_type ?? "new-api",
    health: overrides.health ?? { status: "healthy" },
    exchange_rate: overrides.exchange_rate ?? 7.2,
    account_info: overrides.account_info ?? {
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
    last_sync_time: overrides.last_sync_time ?? now,
    updated_at: overrides.updated_at ?? now,
    created_at: overrides.created_at ?? now,
    notes: overrides.notes ?? "",
    tagIds: overrides.tagIds ?? [],
    disabled: overrides.disabled ?? false,
    excludeFromTotalBalance: overrides.excludeFromTotalBalance ?? false,
    authType: overrides.authType ?? "access_token",
    cookieAuth: overrides.cookieAuth,
    sub2apiAuth: overrides.sub2apiAuth,
    checkIn: overrides.checkIn ?? {
      enableDetection: true,
      autoCheckInEnabled: true,
    },
    manualBalanceUsd: overrides.manualBalanceUsd,
  } as SiteAccount
}

describe("PollingLocalWorkerExecutionGateway", () => {
  it("enqueues a local checkin task, waits for worker completion, and streams progress text", async () => {
    const store = new InMemoryLocalWorkerTaskStore()
    const progress: string[] = []
    const gateway = new PollingLocalWorkerExecutionGateway({
      taskStore: store,
      pollIntervalMs: 5,
      claimTimeoutMs: 1_000,
      heartbeatTimeoutMs: 1_000,
    })
    const account = createAccount()

    const pending = gateway.runCheckinTask([account], {
      accountId: account.id,
      mode: "manual",
      onProgress: async (message) => {
        progress.push(message)
      },
    })

    const claimed = await store.claimNext("local-browser-1", 100)
    expect(claimed?.kind).toBe("checkin")
    await store.updateProgress(claimed!.id, "local-browser-1", {
      status: "running",
      progressText: "浏览器已启动",
      heartbeatAt: 110,
    })

    const result: BatchCheckinRunResult = {
      record: {
        id: "run-1",
        initiatedBy: "worker",
        targetAccountIds: [account.id],
        startedAt: 100,
        completedAt: 200,
        summary: {
          total: 1,
          success: 1,
          alreadyChecked: 0,
          failed: 0,
          manualActionRequired: 0,
          skipped: 0,
        },
        results: [
          {
            accountId: account.id,
            siteName: account.site_name,
            siteUrl: account.site_url,
            siteType: account.site_type,
            status: CheckinResultStatus.Success,
            message: "签到成功",
            startedAt: 100,
            completedAt: 200,
          },
        ],
      },
      refreshedAccountIds: [],
    }
    await store.finish(claimed!.id, "local-browser-1", {
      status: "succeeded",
      finishedAt: 200,
      resultJson: result,
    })

    await expect(pending).resolves.toEqual(result)
    expect(progress).toContain("浏览器已启动")
  })
})
