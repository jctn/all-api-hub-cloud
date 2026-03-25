import crypto from "node:crypto"

import {
  CheckinResultStatus,
  executeCheckinAccount,
  hasUsableAuth,
  isAnyrouterSiteType,
  isSupportedCheckinSiteType,
  summarizeCheckinResults,
  type CheckinAccountResult,
  type CheckinRunRecord,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"

import {
  type SessionRefreshResult,
  type SiteSessionRefresher,
} from "../auth/playwrightSessionService.js"
import { matchOrDefaultSiteLoginProfile } from "../auth/siteLoginProfiles.js"
import type { ServerConfig } from "../config.js"
import { classifyCheckinResultForReauth } from "./authRecovery.js"

export interface BatchCheckinRunOptions {
  accountId?: string
  mode: "scheduled" | "manual"
}

export interface BatchCheckinRunResult {
  record: CheckinRunRecord
  refreshedAccountIds: string[]
}

export interface SessionRefreshAccountResult {
  accountId: string
  siteName: string
  status: SessionRefreshResult["status"]
  message: string
}

export interface SessionRefreshRunResult {
  startedAt: number
  completedAt: number
  summary: {
    total: number
    refreshed: number
    manualActionRequired: number
    unsupportedAutoReauth: number
    failed: number
  }
  results: SessionRefreshAccountResult[]
}

export interface SessionRefreshRunOptions {
  onProgress?: (message: string) => Promise<void> | void
}

function buildRefreshFailureResult(
  account: SiteAccount,
  refreshResult: SessionRefreshResult,
): CheckinAccountResult {
  const now = Date.now()
  return {
    accountId: account.id,
    siteName: account.site_name,
    siteUrl: account.site_url,
    siteType: account.site_type,
    status:
      refreshResult.status === "failed"
        ? CheckinResultStatus.Failed
        : CheckinResultStatus.ManualActionRequired,
    code: refreshResult.status,
    message: refreshResult.message,
    rawMessage: refreshResult.diagnosticPath,
    startedAt: now,
    completedAt: now,
  }
}

function isScheduledBatchCandidate(account: SiteAccount): boolean {
  return (
    !account.disabled &&
    isSupportedCheckinSiteType(account.site_type) &&
    account.checkIn.enableDetection &&
    account.checkIn.autoCheckInEnabled !== false &&
    hasUsableAuth(account)
  )
}

export class CheckinOrchestrator {
  constructor(
    private readonly repository: StorageRepository,
    private readonly config: Pick<ServerConfig, "siteLoginProfiles">,
    private readonly sessionRefresher: SiteSessionRefresher,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async runCheckinBatch(
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult> {
    const allAccounts = await this.repository.getAccounts()
    const selectedAccounts = options.accountId
      ? allAccounts.filter((account) => account.id === options.accountId)
      : allAccounts.filter(isScheduledBatchCandidate)
    const results: CheckinAccountResult[] = []
    const refreshedAccountIds: string[] = []
    const startedAt = Date.now()

    for (const account of selectedAccounts) {
      let result = await executeCheckinAccount({
        repository: this.repository,
        account,
        mode: options.mode,
        fetchImpl: this.fetchImpl,
      })

      const hasProfile = Boolean(
        matchOrDefaultSiteLoginProfile(account.site_url, this.config.siteLoginProfiles, account.site_type),
      )
      const classification = classifyCheckinResultForReauth(result, hasProfile)

      if (classification.retryable) {
        const refreshResult = await this.sessionRefresher.refreshSiteSession(account)

        if (refreshResult.status === "refreshed") {
          refreshedAccountIds.push(account.id)

          if (isAnyrouterSiteType(account.site_type)) {
            result = {
              accountId: account.id,
              siteName: account.site_name,
              siteUrl: account.site_url,
              siteType: account.site_type,
              status: CheckinResultStatus.Success,
              message: "登录成功即签到（AnyRouter）",
              startedAt: result.startedAt,
              completedAt: Date.now(),
            }
          } else {
            const refreshedAccount =
              refreshResult.account ??
              (await this.repository.getAccountById(account.id)) ??
              account

            result = await executeCheckinAccount({
              repository: this.repository,
              account: refreshedAccount,
              mode: "manual",
              fetchImpl: this.fetchImpl,
            })
          }
        } else {
          result = buildRefreshFailureResult(account, refreshResult)
        }
      } else if (classification.type === "unsupported_auto_reauth") {
        result = {
          ...result,
          status: CheckinResultStatus.ManualActionRequired,
          code: "unsupported_auto_reauth",
          message: "该站点未配置云端自动登录 profile，无法自动续期会话",
        }
      }

      results.push(result)
    }

    const completedAt = Date.now()
    const record: CheckinRunRecord = {
      id: crypto.randomUUID(),
      initiatedBy: "server",
      targetAccountIds: options.accountId ? [options.accountId] : null,
      startedAt,
      completedAt,
      summary: summarizeCheckinResults(results),
      results,
    }

    await this.repository.appendHistory(record)
    return {
      record,
      refreshedAccountIds,
    }
  }

  async refreshSessions(
    accountId?: string,
    options: SessionRefreshRunOptions = {},
  ): Promise<SessionRefreshRunResult> {
    const allAccounts = await this.repository.getAccounts()
    const selectedAccounts = accountId
      ? allAccounts.filter((account) => account.id === accountId)
      : allAccounts.filter((account) => !account.disabled)
    const startedAt = Date.now()
    const results: SessionRefreshAccountResult[] = []

    for (const [index, account] of selectedAccounts.entries()) {
      await options.onProgress?.(
        `刷新进度 (${index + 1}/${selectedAccounts.length})：${account.site_name} (${account.id})`,
      )

      const result = await this.sessionRefresher.refreshSiteSession(account, {
        onProgress: (message) =>
          options.onProgress?.(`[${account.site_name}] ${message}`),
      })
      results.push({
        accountId: account.id,
        siteName: account.site_name,
        status: result.status,
        message: result.message,
      })
      await options.onProgress?.(
        `[${account.site_name}] 结果：${formatRefreshProgressStatus(result)}`,
      )
    }

    const summary = results.reduce(
      (current, result) => {
        current.total += 1
        if (result.status === "refreshed") current.refreshed += 1
        if (result.status === "manual_action_required") {
          current.manualActionRequired += 1
        }
        if (result.status === "unsupported_auto_reauth") {
          current.unsupportedAutoReauth += 1
        }
        if (result.status === "failed") current.failed += 1
        return current
      },
      {
        total: 0,
        refreshed: 0,
        manualActionRequired: 0,
        unsupportedAutoReauth: 0,
        failed: 0,
      },
    )

    return {
      startedAt,
      completedAt: Date.now(),
      summary,
      results,
    }
  }
}

function formatRefreshProgressStatus(result: SessionRefreshResult): string {
  switch (result.status) {
    case "refreshed":
      return `刷新成功；${result.message}`
    case "manual_action_required":
      return `需人工介入；${result.message}`
    case "unsupported_auto_reauth":
      return `未配置自动续期；${result.message}`
    case "failed":
    default:
      return `刷新失败；${result.message}`
  }
}
