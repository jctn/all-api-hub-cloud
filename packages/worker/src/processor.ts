import {
  type SiteAccount,
} from "@all-api-hub/core"

import {
  buildCheckinRunRecord,
  CheckinOrchestrator,
  type BatchCheckinRunResult,
  type SessionRefreshRunResult,
  PlaywrightSiteSessionService,
  type PlaywrightSiteSessionConfig,
  type LocalWorkerTask,
} from "@all-api-hub/server"
import type { WorkerConfig } from "./config.js"
import type { WorkerRuntime } from "./runtime.js"

type LocalPlaywrightSiteSessionConfig = PlaywrightSiteSessionConfig & {
  localFlareSolverr: WorkerConfig["localFlareSolverr"]
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)]
}

function createEmptyCheckinResult(): BatchCheckinRunResult {
  const now = Date.now()
  return {
    record: buildCheckinRunRecord({
      initiatedBy: "server",
      targetAccountIds: null,
      startedAt: now,
      completedAt: now,
      results: [],
    }),
    refreshedAccountIds: [],
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

function isSiteAccount(value: unknown): value is SiteAccount {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as SiteAccount).id === "string" &&
      typeof (value as SiteAccount).site_url === "string" &&
      typeof (value as SiteAccount).site_name === "string" &&
      typeof (value as SiteAccount).site_type === "string",
  )
}

export class LocalBrowserTaskProcessor {
  constructor(
    private readonly config: WorkerConfig,
    private readonly runtime: WorkerRuntime,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async processTask(
    task: LocalWorkerTask,
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<BatchCheckinRunResult | SessionRefreshRunResult> {
    const accounts = await this.resolveTaskAccounts(task)

    if (task.kind === "checkin") {
      return this.processCheckinTask(task, accounts, onProgress)
    }

    return this.processRefreshTask(accounts, onProgress)
  }

  private async resolveTaskAccounts(task: LocalWorkerTask): Promise<SiteAccount[]> {
    const resolved: SiteAccount[] = []

    for (const entry of task.payload.accounts) {
      if (isSiteAccount(entry.rawAccount)) {
        resolved.push(entry.rawAccount)
        await this.runtime.repository.saveAccount(entry.rawAccount)
        continue
      }

      const account = await this.runtime.repository.getAccountById(entry.id)
      if (!account) {
        throw new Error(`Worker account snapshot missing: ${entry.id}`)
      }
      resolved.push(account)
    }

    return resolved
  }

  private createLocalSessionConfig(
    accountId: string,
  ): LocalPlaywrightSiteSessionConfig {
    const localFlareSolverr = this.config.localFlareSolverr

    return {
      diagnosticsDirectory: this.runtime.paths.diagnosticsDirectory,
      sharedSsoProfileDirectory: this.runtime.paths.siteProfileDirectory(accountId),
      chromiumExecutablePath: this.config.chromiumExecutablePath,
      github: this.config.github,
      flareSolverrUrl:
        localFlareSolverr.enabled && localFlareSolverr.url
          ? localFlareSolverr.url
          : null,
      localFlareSolverr,
      siteLoginProfiles: this.runtime.siteLoginProfiles,
      browserHeadless: false,
      chromiumLaunchArgs: [],
      manualLoginWaitTimeoutMs: 300_000,
      runAnytimeDebugRootOnlyPause: this.config.runAnytimeDebugRootOnlyPause,
    }
  }

  private async processCheckinTask(
    task: LocalWorkerTask,
    accounts: SiteAccount[],
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<BatchCheckinRunResult> {
    if (accounts.length === 0) {
      return createEmptyCheckinResult()
    }

    const results: BatchCheckinRunResult["record"]["results"] = []
    const refreshedAccountIds: string[] = []
    let startedAt = Number.POSITIVE_INFINITY
    let completedAt = 0

    for (const account of accounts) {
      const sessionService = new PlaywrightSiteSessionService(
        this.runtime.repository,
        this.createLocalSessionConfig(account.id),
        this.fetchImpl,
      )
      const orchestrator = new CheckinOrchestrator(
        this.runtime.repository,
        { siteLoginProfiles: this.runtime.siteLoginProfiles },
        sessionService,
        this.fetchImpl,
      )
      const execution = await orchestrator.executeCheckinBatchForAccounts(
        [account],
        {
          accountId: account.id,
          mode: task.payload.mode ?? "manual",
          onProgress: (message) =>
            onProgress?.(`[${account.site_name}] ${message}`),
        },
      )
      results.push(...execution.results)
      refreshedAccountIds.push(...execution.refreshedAccountIds)
      startedAt = Math.min(startedAt, execution.startedAt)
      completedAt = Math.max(completedAt, execution.completedAt)
    }

    return {
      record: buildCheckinRunRecord({
        initiatedBy: "server",
        targetAccountIds: accounts.map((account) => account.id),
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
        completedAt: completedAt || Date.now(),
        results,
      }),
      refreshedAccountIds: dedupeStrings(refreshedAccountIds),
    }
  }

  private async processRefreshTask(
    accounts: SiteAccount[],
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<SessionRefreshRunResult> {
    if (accounts.length === 0) {
      return createEmptyRefreshResult()
    }

    const results: SessionRefreshRunResult["results"] = []
    let startedAt = Number.POSITIVE_INFINITY
    let completedAt = 0

    for (const account of accounts) {
      const sessionService = new PlaywrightSiteSessionService(
        this.runtime.repository,
        this.createLocalSessionConfig(account.id),
        this.fetchImpl,
      )
      const orchestrator = new CheckinOrchestrator(
        this.runtime.repository,
        { siteLoginProfiles: this.runtime.siteLoginProfiles },
        sessionService,
        this.fetchImpl,
      )
      const refreshRun = await orchestrator.refreshSessionsForAccounts([account], {
        onProgress: (message) => onProgress?.(`[${account.site_name}] ${message}`),
      })
      results.push(...refreshRun.results)
      startedAt = Math.min(startedAt, refreshRun.startedAt)
      completedAt = Math.max(completedAt, refreshRun.completedAt)
    }

    return {
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      completedAt: completedAt || Date.now(),
      summary: {
        total: results.length,
        refreshed: results.filter((item) => item.status === "refreshed").length,
        manualActionRequired: results.filter(
          (item) => item.status === "manual_action_required",
        ).length,
        unsupportedAutoReauth: results.filter(
          (item) => item.status === "unsupported_auto_reauth",
        ).length,
        failed: results.filter((item) => item.status === "failed").length,
      },
      results,
    }
  }
}
