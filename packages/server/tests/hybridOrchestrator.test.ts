import { describe, expect, it, vi } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  HealthState,
  type AppSettings,
  type CheckinHistoryDocument,
  type CheckinRunRecord,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"

import type {
  BatchCheckinExecutionResult,
  BatchCheckinRunOptions,
  SessionRefreshRunOptions,
  SessionRefreshRunResult,
} from "../src/checkin/orchestrator.js"
import { HybridCheckinOrchestrator } from "../src/localWorker/hybridOrchestrator.js"

function createAccount(overrides: Partial<SiteAccount> = {}): SiteAccount {
  const now = Date.now()
  return {
    id: overrides.id ?? "account-1",
    site_name: overrides.site_name ?? "Demo",
    site_url: overrides.site_url ?? "https://demo.example.com",
    site_type: overrides.site_type ?? "new-api",
    health: overrides.health ?? { status: HealthState.Healthy },
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
    authType: overrides.authType ?? AuthType.AccessToken,
    cookieAuth: overrides.cookieAuth,
    sub2apiAuth: overrides.sub2apiAuth,
    checkIn: overrides.checkIn ?? {
      enableDetection: true,
      autoCheckInEnabled: true,
    },
    manualBalanceUsd: overrides.manualBalanceUsd,
  }
}

class InMemoryRepository implements StorageRepository {
  private history: CheckinHistoryDocument = {
    version: 1,
    records: [],
    accountStates: {},
  }

  constructor(private readonly accounts: SiteAccount[]) {}

  async initialize(): Promise<void> {}
  async getAccounts(): Promise<SiteAccount[]> {
    return [...this.accounts]
  }
  async getAccountById(accountId: string): Promise<SiteAccount | null> {
    return this.accounts.find((account) => account.id === accountId) ?? null
  }
  async replaceAccounts(accounts: SiteAccount[]): Promise<void> {
    this.accounts.splice(0, this.accounts.length, ...accounts)
  }
  async saveAccount(account: SiteAccount): Promise<SiteAccount> {
    const index = this.accounts.findIndex((item) => item.id === account.id)
    if (index >= 0) {
      this.accounts[index] = account
    } else {
      this.accounts.push(account)
    }
    return account
  }
  async deleteAccount(accountId: string): Promise<boolean> {
    const index = this.accounts.findIndex((account) => account.id === accountId)
    if (index < 0) {
      return false
    }
    this.accounts.splice(index, 1)
    return true
  }
  async getSettings(): Promise<AppSettings> {
    return { version: 1 }
  }
  async saveSettings(): Promise<AppSettings> {
    return { version: 1 }
  }
  async getHistory(): Promise<CheckinHistoryDocument> {
    return this.history
  }
  async appendHistory(record: CheckinRunRecord): Promise<CheckinHistoryDocument> {
    this.history = {
      ...this.history,
      records: [record, ...this.history.records],
    }
    return this.history
  }
  async setLatestAccountResult(): Promise<void> {}
}

describe("HybridCheckinOrchestrator", () => {
  it("splits mixed checkin accounts between cloud and local worker, then persists one merged record", async () => {
    const cloudAccount = createAccount({
      id: "cloud-1",
      site_name: "CloudSite",
      site_url: "https://cloud.example.com",
    })
    const localAccount = createAccount({
      id: "local-1",
      site_name: "RunAnytime",
      site_url: "https://runanytime.example.com",
    })
    const repository = new InMemoryRepository([cloudAccount, localAccount])
    const cloudExecution = vi.fn(
      async (
        accounts: SiteAccount[],
        _options: BatchCheckinRunOptions,
      ): Promise<BatchCheckinExecutionResult> => ({
        targetAccountIds: accounts.map((account) => account.id),
        startedAt: 100,
        completedAt: 200,
        refreshedAccountIds: [],
        results: [
          {
            accountId: cloudAccount.id,
            siteName: cloudAccount.site_name,
            siteUrl: cloudAccount.site_url,
            siteType: cloudAccount.site_type,
            status: CheckinResultStatus.Success,
            message: "云端签到成功",
            startedAt: 100,
            completedAt: 200,
          },
        ],
      }),
    )
    const localCheckin = vi.fn(async (accounts: SiteAccount[]) => ({
      record: {
        id: "local-run",
        initiatedBy: "worker",
        targetAccountIds: accounts.map((account) => account.id),
        startedAt: 150,
        completedAt: 350,
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
            accountId: localAccount.id,
            siteName: localAccount.site_name,
            siteUrl: localAccount.site_url,
            siteType: localAccount.site_type,
            status: CheckinResultStatus.Success,
            message: "本地浏览器签到成功",
            startedAt: 150,
            completedAt: 350,
          },
        ],
      },
      refreshedAccountIds: [localAccount.id],
    }))

    const orchestrator = new HybridCheckinOrchestrator({
      repository,
      siteLoginProfiles: {
        "runanytime.example.com": {
          hostname: "runanytime.example.com",
          loginPath: "/auth/login",
          loginButtonSelectors: ["button[data-provider='linuxdo']"],
          successUrlPatterns: ["/console"],
          tokenStorageKeys: ["access_token"],
          postLoginSelectors: [".avatar"],
          executionMode: "local-browser",
        },
      },
      cloud: {
        executeCheckinBatchForAccounts: cloudExecution,
        refreshSessionsForAccounts: vi.fn(),
      },
      localWorker: {
        runCheckinTask: localCheckin,
        runRefreshTask: vi.fn(),
        getActiveTask: vi.fn(async () => null),
      },
    })

    const result = await orchestrator.runCheckinBatch({
      mode: "scheduled",
    })
    const history = await repository.getHistory()

    expect(cloudExecution).toHaveBeenCalledWith([cloudAccount], expect.any(Object))
    expect(localCheckin).toHaveBeenCalledWith([localAccount], expect.any(Object))
    expect(result.record.summary).toMatchObject({
      total: 2,
      success: 2,
    })
    expect(result.refreshedAccountIds).toEqual([localAccount.id])
    expect(history.records).toHaveLength(1)
    expect(history.records[0]?.results).toHaveLength(2)
  })

  it("splits mixed refresh tasks between cloud and local worker, then merges summary counts", async () => {
    const cloudAccount = createAccount({
      id: "cloud-1",
      site_name: "CloudSite",
      site_url: "https://cloud.example.com",
    })
    const localAccount = createAccount({
      id: "local-1",
      site_name: "RunAnytime",
      site_url: "https://runanytime.example.com",
    })
    const repository = new InMemoryRepository([cloudAccount, localAccount])
    const refreshCloud = vi.fn(
      async (_accounts: SiteAccount[], _options: SessionRefreshRunOptions): Promise<SessionRefreshRunResult> => ({
        startedAt: 100,
        completedAt: 180,
        summary: {
          total: 1,
          refreshed: 1,
          manualActionRequired: 0,
          unsupportedAutoReauth: 0,
          failed: 0,
        },
        results: [
          {
            accountId: cloudAccount.id,
            siteName: cloudAccount.site_name,
            status: "refreshed",
            message: "云端刷新成功",
          },
        ],
      }),
    )
    const refreshLocal = vi.fn(async () => ({
      startedAt: 140,
      completedAt: 320,
      summary: {
        total: 1,
        refreshed: 0,
        manualActionRequired: 1,
        unsupportedAutoReauth: 0,
        failed: 0,
      },
      results: [
        {
          accountId: localAccount.id,
          siteName: localAccount.site_name,
          status: "manual_action_required" as const,
          message: "等待人工处理",
        },
      ],
    }))

    const orchestrator = new HybridCheckinOrchestrator({
      repository,
      siteLoginProfiles: {
        "runanytime.example.com": {
          hostname: "runanytime.example.com",
          loginPath: "/auth/login",
          loginButtonSelectors: ["button[data-provider='linuxdo']"],
          successUrlPatterns: ["/console"],
          tokenStorageKeys: ["access_token"],
          postLoginSelectors: [".avatar"],
          executionMode: "local-browser",
        },
      },
      cloud: {
        executeCheckinBatchForAccounts: vi.fn(),
        refreshSessionsForAccounts: refreshCloud,
      },
      localWorker: {
        runCheckinTask: vi.fn(),
        runRefreshTask: refreshLocal,
        getActiveTask: vi.fn(async () => null),
      },
    })

    const result = await orchestrator.refreshSessions()

    expect(refreshCloud).toHaveBeenCalledWith([cloudAccount], expect.any(Object))
    expect(refreshLocal).toHaveBeenCalledWith([localAccount], expect.any(Object))
    expect(result.summary).toEqual({
      total: 2,
      refreshed: 1,
      manualActionRequired: 1,
      unsupportedAutoReauth: 0,
      failed: 0,
    })
    expect(result.results).toHaveLength(2)
  })
})
