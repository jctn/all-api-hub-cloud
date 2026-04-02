import {
  summarizeCheckinResults,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"

import {
  matchOrDefaultSiteLoginProfile,
  requiresLocalBrowserExecution,
  type SiteLoginProfileMap,
} from "../auth/siteLoginProfiles.js"
import {
  buildCheckinRunRecord,
  selectCheckinAccounts,
  type BatchCheckinExecutionResult,
  type BatchCheckinRunOptions,
  type BatchCheckinRunResult,
  type SessionRefreshRunOptions,
  type SessionRefreshRunResult,
} from "../checkin/orchestrator.js"
import type { LocalWorkerTask } from "./taskStore.js"

interface CloudExecutionController {
  executeCheckinBatchForAccounts(
    accounts: SiteAccount[],
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinExecutionResult>
  refreshSessionsForAccounts(
    accounts: SiteAccount[],
    options?: SessionRefreshRunOptions,
  ): Promise<SessionRefreshRunResult>
}

export interface LocalWorkerExecutionGateway {
  runCheckinTask(
    accounts: SiteAccount[],
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult>
  runRefreshTask(
    accounts: SiteAccount[],
    options?: SessionRefreshRunOptions,
  ): Promise<SessionRefreshRunResult>
  getActiveTask(): Promise<LocalWorkerTask | null>
}

export interface CheckinExecutionController {
  runCheckinBatch(
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult>
  refreshSessions(
    accountId?: string,
    options?: SessionRefreshRunOptions,
  ): Promise<SessionRefreshRunResult>
  getActiveLocalWorkerTask?(): Promise<LocalWorkerTask | null>
}

function partitionAccountsByExecutionMode(
  accounts: SiteAccount[],
  siteLoginProfiles: SiteLoginProfileMap,
): {
  cloudAccounts: SiteAccount[]
  localAccounts: SiteAccount[]
} {
  const cloudAccounts: SiteAccount[] = []
  const localAccounts: SiteAccount[] = []

  for (const account of accounts) {
    const profile = matchOrDefaultSiteLoginProfile(
      account.site_url,
      siteLoginProfiles,
      account.site_type,
    )
    if (profile && requiresLocalBrowserExecution(profile)) {
      localAccounts.push(account)
      continue
    }

    cloudAccounts.push(account)
  }

  return {
    cloudAccounts,
    localAccounts,
  }
}

function mergeRefreshResults(
  cloud: SessionRefreshRunResult | null,
  local: SessionRefreshRunResult | null,
): SessionRefreshRunResult {
  const results = [
    ...(cloud?.results ?? []),
    ...(local?.results ?? []),
  ]

  return {
    startedAt: Math.min(
      cloud?.startedAt ?? Number.POSITIVE_INFINITY,
      local?.startedAt ?? Number.POSITIVE_INFINITY,
      Date.now(),
    ),
    completedAt: Math.max(
      cloud?.completedAt ?? 0,
      local?.completedAt ?? 0,
    ),
    summary: {
      total: (cloud?.summary.total ?? 0) + (local?.summary.total ?? 0),
      refreshed:
        (cloud?.summary.refreshed ?? 0) + (local?.summary.refreshed ?? 0),
      manualActionRequired:
        (cloud?.summary.manualActionRequired ?? 0) +
        (local?.summary.manualActionRequired ?? 0),
      unsupportedAutoReauth:
        (cloud?.summary.unsupportedAutoReauth ?? 0) +
        (local?.summary.unsupportedAutoReauth ?? 0),
      failed: (cloud?.summary.failed ?? 0) + (local?.summary.failed ?? 0),
    },
    results,
  }
}

function createEmptyRefreshResult(): SessionRefreshRunResult {
  const now = Date.now()
  return {
    startedAt: now,
    completedAt: now,
    summary: {
      total: 0,
      refreshed: 0,
      manualActionRequired: 0,
      unsupportedAutoReauth: 0,
      failed: 0,
    },
    results: [],
  }
}

export class HybridCheckinOrchestrator implements CheckinExecutionController {
  constructor(private readonly params: {
    repository: StorageRepository
    siteLoginProfiles: SiteLoginProfileMap
    cloud: CloudExecutionController
    localWorker: LocalWorkerExecutionGateway
  }) {}

  async runCheckinBatch(
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult> {
    const allAccounts = await this.params.repository.getAccounts()
    const selectedAccounts = selectCheckinAccounts(allAccounts, options)
    const { cloudAccounts, localAccounts } = partitionAccountsByExecutionMode(
      selectedAccounts,
      this.params.siteLoginProfiles,
    )

    const [cloudResult, localResult] = await Promise.all([
      cloudAccounts.length > 0
        ? this.params.cloud.executeCheckinBatchForAccounts(cloudAccounts, {
            ...options,
            onProgress: options.onProgress
              ? (message) => options.onProgress?.(`[云端] ${message}`)
              : undefined,
          })
        : Promise.resolve<BatchCheckinExecutionResult | null>(null),
      localAccounts.length > 0
        ? this.params.localWorker.runCheckinTask(localAccounts, {
            ...options,
            onProgress: options.onProgress
              ? (message) => options.onProgress?.(`[本地浏览器] ${message}`)
              : undefined,
          })
        : Promise.resolve<BatchCheckinRunResult | null>(null),
    ])

    const results = [
      ...(cloudResult?.results ?? []),
      ...(localResult?.record.results ?? []),
    ]
    const record = buildCheckinRunRecord({
      targetAccountIds:
        selectedAccounts.length > 0
          ? selectedAccounts.map((account) => account.id)
          : null,
      startedAt: Math.min(
        cloudResult?.startedAt ?? Number.POSITIVE_INFINITY,
        localResult?.record.startedAt ?? Number.POSITIVE_INFINITY,
        Date.now(),
      ),
      completedAt: Math.max(
        cloudResult?.completedAt ?? 0,
        localResult?.record.completedAt ?? 0,
      ),
      results,
    })

    await this.params.repository.appendHistory(record)
    return {
      record: {
        ...record,
        summary: summarizeCheckinResults(results),
      },
      refreshedAccountIds: [
        ...(cloudResult?.refreshedAccountIds ?? []),
        ...(localResult?.refreshedAccountIds ?? []),
      ],
    }
  }

  async refreshSessions(
    accountId?: string,
    options: SessionRefreshRunOptions = {},
  ): Promise<SessionRefreshRunResult> {
    const allAccounts = await this.params.repository.getAccounts()
    const selectedAccounts = accountId
      ? allAccounts.filter((account) => account.id === accountId)
      : allAccounts.filter((account) => !account.disabled)
    const { cloudAccounts, localAccounts } = partitionAccountsByExecutionMode(
      selectedAccounts,
      this.params.siteLoginProfiles,
    )

    if (cloudAccounts.length === 0 && localAccounts.length === 0) {
      return createEmptyRefreshResult()
    }

    const [cloudResult, localResult] = await Promise.all([
      cloudAccounts.length > 0
        ? this.params.cloud.refreshSessionsForAccounts(cloudAccounts, {
            ...options,
            onProgress: options.onProgress
              ? (message) => options.onProgress?.(`[云端] ${message}`)
              : undefined,
          })
        : Promise.resolve<SessionRefreshRunResult | null>(null),
      localAccounts.length > 0
        ? this.params.localWorker.runRefreshTask(localAccounts, {
            ...options,
            onProgress: options.onProgress
              ? (message) => options.onProgress?.(`[本地浏览器] ${message}`)
              : undefined,
          })
        : Promise.resolve<SessionRefreshRunResult | null>(null),
    ])

    return mergeRefreshResults(cloudResult, localResult)
  }

  async getActiveLocalWorkerTask(): Promise<LocalWorkerTask | null> {
    return this.params.localWorker.getActiveTask()
  }
}
