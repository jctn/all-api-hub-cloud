import crypto from "node:crypto"

import {
  CheckinResultStatus,
  executeCheckinAccount,
  fetchNewApiSelf,
  fetchNewApiTodayIncome,
  hasUsableAuth,
  isAnyrouterSiteType,
  resolveRewardFromAccountDiff,
  resolveTodayIncomeDetail,
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
  onProgress?: (message: string) => Promise<void> | void
}

export interface BatchCheckinRunResult {
  record: CheckinRunRecord
  refreshedAccountIds: string[]
}

export interface CheckinExecutionController {
  runCheckinBatch(
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult>
  refreshAccountSnapshots(
    accountId?: string,
    options?: AccountSnapshotRefreshRunOptions,
  ): Promise<AccountSnapshotRefreshRunResult>
  refreshSessions(
    accountId?: string,
    options?: SessionRefreshRunOptions,
  ): Promise<SessionRefreshRunResult>
}

export interface BatchCheckinExecutionResult {
  targetAccountIds: string[] | null
  startedAt: number
  completedAt: number
  results: CheckinAccountResult[]
  refreshedAccountIds: string[]
}

export interface SessionRefreshAccountResult {
  accountId: string
  siteName: string
  status: SessionRefreshResult["status"]
  code?: string
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

export interface AccountSnapshotRefreshAccountResult {
  accountId: string
  siteName: string
  status: "updated" | "failed" | "skipped"
  code?: string
  message: string
}

export interface AccountSnapshotRefreshRunResult {
  startedAt: number
  completedAt: number
  summary: {
    total: number
    updated: number
    failed: number
    skipped: number
  }
  results: AccountSnapshotRefreshAccountResult[]
}

export interface AccountSnapshotRefreshRunOptions {
  onProgress?: (message: string) => Promise<void> | void
}

const TRANSIENT_HTML_RETRY_DELAY_MS = 1500

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
    code: refreshResult.code ?? refreshResult.status,
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

export function selectCheckinAccounts(
  accounts: SiteAccount[],
  options: Pick<BatchCheckinRunOptions, "accountId">,
): SiteAccount[] {
  return options.accountId
    ? accounts.filter((account) => account.id === options.accountId)
    : accounts.filter(isScheduledBatchCandidate)
}

export function buildCheckinRunRecord(params: {
  targetAccountIds: string[] | null
  startedAt: number
  completedAt: number
  results: CheckinAccountResult[]
  initiatedBy?: CheckinRunRecord["initiatedBy"]
}): CheckinRunRecord {
  return {
    id: crypto.randomUUID(),
    initiatedBy: params.initiatedBy ?? "server",
    targetAccountIds: params.targetAccountIds,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    summary: summarizeCheckinResults(params.results),
    results: params.results,
  }
}

function isRunAnytimeTurnstileFallbackCandidate(
  account: SiteAccount,
  options: BatchCheckinRunOptions,
  result: CheckinAccountResult,
): boolean {
  if (
    !result.message.includes("Turnstile token 为空") &&
    result.code !== "auth_invalid" &&
    result.code !== "missing_auth" &&
    result.code !== "missing_cookie_auth"
  ) {
    return false
  }

  try {
    return new URL(account.site_url).hostname.toLowerCase() === "runanytime.hxi.me"
  } catch {
    return false
  }
}

function isTransientHtmlRetryCandidate(result: CheckinAccountResult): boolean {
  return (
    result.status === CheckinResultStatus.Failed &&
    result.code === "html_interstitial"
  )
}

function annotateTransientRetrySuccess(
  result: CheckinAccountResult,
): CheckinAccountResult {
  if (
    result.status !== CheckinResultStatus.Success &&
    result.status !== CheckinResultStatus.AlreadyChecked
  ) {
    return result
  }

  if (!result.message || result.message.includes("已自动重试成功")) {
    return result
  }

  return {
    ...result,
    message: `${result.message}；已在临时中间页后自动重试成功`,
  }
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
    const selectedAccounts = selectCheckinAccounts(allAccounts, options)
    const execution = await this.executeCheckinBatchForAccounts(
      selectedAccounts,
      options,
    )
    const record = buildCheckinRunRecord({
      targetAccountIds: execution.targetAccountIds,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      results: execution.results,
    })

    await this.repository.appendHistory(record)
    return {
      record,
      refreshedAccountIds: execution.refreshedAccountIds,
    }
  }

  async executeCheckinBatchForAccounts(
    selectedAccounts: SiteAccount[],
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinExecutionResult> {
    const results: CheckinAccountResult[] = []
    const refreshedAccountIds: string[] = []
    const startedAt = Date.now()

    for (const [index, account] of selectedAccounts.entries()) {
      await options.onProgress?.(
        `签到进度 (${index + 1}/${selectedAccounts.length})：${account.site_name} (${account.id})`,
      )

      let result = await executeCheckinAccount({
        repository: this.repository,
        account,
        mode: options.mode,
        fetchImpl: this.fetchImpl,
      })

      if (isTransientHtmlRetryCandidate(result)) {
        await options.onProgress?.(
          `[${account.site_name}] 检测到站点临时返回 HTML 中间页，等待后自动重试`,
        )
        await new Promise((resolve) =>
          setTimeout(resolve, TRANSIENT_HTML_RETRY_DELAY_MS),
        )
        const latestAccount =
          (await this.repository.getAccountById(account.id)) ?? account
        result = annotateTransientRetrySuccess(
          await executeCheckinAccount({
            repository: this.repository,
            account: latestAccount,
            mode: "manual",
            fetchImpl: this.fetchImpl,
          }),
        )
      }

      if (isRunAnytimeTurnstileFallbackCandidate(account, options, result)) {
        await options.onProgress?.(
          `[${account.site_name}] 检测到 RunAnytime 会话异常，切换到浏览器会话补签`,
        )
        const browserSessionResult =
          await this.sessionRefresher.checkInWithBrowserSession?.(account, {
            onProgress: (message) =>
              options.onProgress?.(`[${account.site_name}] ${message}`),
          })
        if (browserSessionResult) {
          results.push(browserSessionResult)
          continue
        }
      }

      const hasProfile = Boolean(
        matchOrDefaultSiteLoginProfile(account.site_url, this.config.siteLoginProfiles, account.site_type),
      )
      const classification = classifyCheckinResultForReauth(result, hasProfile)

      if (classification.retryable) {
        await options.onProgress?.(
          `[${account.site_name}] 检测到可恢复失败（${classification.type}），尝试刷新会话`,
        )
        const refreshResult = await this.sessionRefresher.refreshSiteSession(account, {
          onProgress: (message) =>
            options.onProgress?.(`[${account.site_name}] ${message}`),
        })

        if (refreshResult.status === "refreshed") {
          refreshedAccountIds.push(account.id)

          if (isAnyrouterSiteType(account.site_type)) {
            let refreshedAccount =
              refreshResult.account ??
              (await this.repository.getAccountById(account.id)) ??
              account
            const syncedTodayIncome = await fetchNewApiTodayIncome({
              account: refreshedAccount,
              fetchImpl: this.fetchImpl,
            }).catch(() => refreshedAccount.account_info.today_income)
            refreshedAccount = {
              ...refreshedAccount,
              account_info: {
                ...refreshedAccount.account_info,
                today_income: syncedTodayIncome,
              },
            }
            const rewardFromDiff = resolveRewardFromAccountDiff(account, refreshedAccount)
            const todayIncomeDetail = resolveTodayIncomeDetail(refreshedAccount)
            const detailParts = [rewardFromDiff, todayIncomeDetail].filter(Boolean)
            result = {
              accountId: account.id,
              siteName: account.site_name,
              siteUrl: account.site_url,
              siteType: account.site_type,
              status: CheckinResultStatus.Success,
              message: detailParts.length > 0
                ? `登录成功即签到（AnyRouter），${detailParts.join("，")}`
                : "登录成功即签到（AnyRouter）",
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

    return {
      targetAccountIds:
        options.accountId || selectedAccounts.length > 0
          ? selectedAccounts.map((account) => account.id)
          : null,
      startedAt,
      completedAt: Date.now(),
      results,
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
    return this.refreshSessionsForAccounts(selectedAccounts, options)
  }

  async refreshSessionsForAccounts(
    selectedAccounts: SiteAccount[],
    options: SessionRefreshRunOptions = {},
  ): Promise<SessionRefreshRunResult> {
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
        code: result.code,
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

  async refreshAccountSnapshots(
    accountId?: string,
    options: AccountSnapshotRefreshRunOptions = {},
  ): Promise<AccountSnapshotRefreshRunResult> {
    const allAccounts = await this.repository.getAccounts()
    const selectedAccounts = accountId
      ? allAccounts.filter((account) => account.id === accountId)
      : allAccounts.filter((account) => !account.disabled)
    return this.refreshAccountSnapshotsForAccounts(selectedAccounts, options)
  }

  async refreshAccountSnapshotsForAccounts(
    selectedAccounts: SiteAccount[],
    options: AccountSnapshotRefreshRunOptions = {},
  ): Promise<AccountSnapshotRefreshRunResult> {
    const startedAt = Date.now()
    const results: AccountSnapshotRefreshAccountResult[] = []

    for (const [index, account] of selectedAccounts.entries()) {
      await options.onProgress?.(
        `刷新进度 (${index + 1}/${selectedAccounts.length})：${account.site_name} (${account.id})`,
      )

      if (!isSupportedCheckinSiteType(account.site_type)) {
        const result: AccountSnapshotRefreshAccountResult = {
          accountId: account.id,
          siteName: account.site_name,
          status: "skipped",
          code: "unsupported_site",
          message: "已跳过：站点暂不支持",
        }
        results.push(result)
        await options.onProgress?.(`[${account.site_name}] ${result.message}`)
        continue
      }

      if (!hasUsableAuth(account)) {
        const result: AccountSnapshotRefreshAccountResult = {
          accountId: account.id,
          siteName: account.site_name,
          status: "skipped",
          code: "missing_auth",
          message: "已跳过：缺少可用认证信息",
        }
        results.push(result)
        await options.onProgress?.(`[${account.site_name}] ${result.message}`)
        continue
      }

      const synced = await fetchNewApiSelf({
        account,
        fetchImpl: this.fetchImpl,
      })
      if (!synced) {
        const result: AccountSnapshotRefreshAccountResult = {
          accountId: account.id,
          siteName: account.site_name,
          status: "failed",
          code: "snapshot_refresh_failed",
          message: "刷新失败，请检查登录状态或站点接口",
        }
        results.push(result)
        await options.onProgress?.(`[${account.site_name}] ${result.message}`)
        continue
      }

      await this.repository.saveAccount(synced)
      const result: AccountSnapshotRefreshAccountResult = {
        accountId: account.id,
        siteName: account.site_name,
        status: "updated",
        message: "账号数据已刷新",
      }
      results.push(result)
      await options.onProgress?.(`[${account.site_name}] ${result.message}`)
    }

    const summary = results.reduce(
      (current, result) => {
        current.total += 1
        if (result.status === "updated") current.updated += 1
        if (result.status === "failed") current.failed += 1
        if (result.status === "skipped") current.skipped += 1
        return current
      },
      {
        total: 0,
        updated: 0,
        failed: 0,
        skipped: 0,
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
