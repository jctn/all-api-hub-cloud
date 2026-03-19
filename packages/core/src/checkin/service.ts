import crypto from "node:crypto"

import {
  CheckinResultStatus,
  type CheckinAccountResult,
  type CheckinRunRecord,
  type CheckinRunSummary,
  type SiteAccount,
} from "../models/types.js"
import {
  isAnyrouterSiteType,
  isSupportedCheckinSiteType,
  isWongSiteType,
} from "../models/siteTypes.js"
import { type StorageRepository } from "../storage/repository.js"
import { hasUsableAuth } from "../utils/auth.js"
import { runAnyrouterCheckin } from "./anyrouterProvider.js"
import {
  fetchNewApiSelf,
  markAccountCheckedIn,
  runNewApiCheckin,
} from "./newApiProvider.js"
import { runWongCheckin } from "./wongProvider.js"

export type CheckinExecutionMode = "scheduled" | "manual"

export interface CheckinExecutionProgress {
  phase: "started" | "account_started" | "account_completed" | "completed"
  total: number
  processed: number
  accountId?: string
  siteName?: string
  status?: CheckinResultStatus
  message?: string
  summary: CheckinRunSummary
}

export interface CheckinExecutionOptions {
  repository: StorageRepository
  initiatedBy: "cli" | "desktop" | "server"
  mode: CheckinExecutionMode
  targetAccountId?: string
  targetAccountIds?: string[]
  fetchImpl?: typeof fetch
  onProgress?: (
    progress: CheckinExecutionProgress,
  ) => void | Promise<void>
}

export interface CheckinAccountExecutionOptions {
  repository: StorageRepository
  account: SiteAccount
  mode: CheckinExecutionMode
  fetchImpl?: typeof fetch
}

export function summarizeCheckinResults(
  results: CheckinAccountResult[],
): CheckinRunSummary {
  return results.reduce<CheckinRunSummary>(
    (summary, result) => {
      summary.total += 1

      if (result.status === CheckinResultStatus.Success) summary.success += 1
      if (result.status === CheckinResultStatus.AlreadyChecked) {
        summary.alreadyChecked += 1
      }
      if (result.status === CheckinResultStatus.Failed) summary.failed += 1
      if (result.status === CheckinResultStatus.ManualActionRequired) {
        summary.manualActionRequired += 1
      }
      if (result.status === CheckinResultStatus.Skipped) summary.skipped += 1

      return summary
    },
    {
      total: 0,
      success: 0,
      alreadyChecked: 0,
      failed: 0,
      manualActionRequired: 0,
      skipped: 0,
    },
  )
}

function buildSkipResult(
  account: SiteAccount,
  code: string,
  message: string,
): CheckinAccountResult {
  const now = Date.now()
  return {
    accountId: account.id,
    siteName: account.site_name,
    siteUrl: account.site_url,
    siteType: account.site_type,
    status: CheckinResultStatus.Skipped,
    code,
    message,
    startedAt: now,
    completedAt: now,
  }
}

function hasUsableCheckinAuth(account: SiteAccount): boolean {
  if (isAnyrouterSiteType(account.site_type)) {
    return Boolean(account.cookieAuth?.sessionCookie?.trim())
  }

  return hasUsableAuth(account)
}

function evaluateEligibility(
  account: SiteAccount,
  mode: CheckinExecutionMode,
): CheckinAccountResult | null {
  if (account.disabled) {
    return buildSkipResult(account, "account_disabled", "账号已禁用")
  }

  if (!isSupportedCheckinSiteType(account.site_type)) {
    return buildSkipResult(account, "unsupported_site", "当前版本暂不支持该站点签到")
  }

  if (mode === "scheduled" && !account.checkIn.enableDetection) {
    return buildSkipResult(account, "checkin_detection_disabled", "未启用签到检测")
  }

  if (mode === "scheduled" && account.checkIn.autoCheckInEnabled === false) {
    return buildSkipResult(account, "auto_checkin_disabled", "已关闭自动签到")
  }

  if (!hasUsableCheckinAuth(account)) {
    return buildSkipResult(
      account,
      isAnyrouterSiteType(account.site_type) ? "missing_cookie_auth" : "missing_auth",
      isAnyrouterSiteType(account.site_type)
        ? "AnyRouter 需要登录会话 Cookie，请先打开站点登录"
        : "缺少可用认证信息，请重新登录",
    )
  }

  return null
}

async function executeProviderCheckin(
  account: SiteAccount,
  fetchImpl?: typeof fetch,
): Promise<CheckinAccountResult> {
  if (isAnyrouterSiteType(account.site_type)) {
    return await runAnyrouterCheckin({ account, fetchImpl })
  }

  if (isWongSiteType(account.site_type)) {
    return await runWongCheckin({ account, fetchImpl })
  }

  return await runNewApiCheckin({ account, fetchImpl })
}

async function runForAccount(
  account: SiteAccount,
  repository: StorageRepository,
  fetchImpl?: typeof fetch,
): Promise<CheckinAccountResult> {
  let effectiveAccount = account
  if (!effectiveAccount.account_info.id) {
    const synced = await fetchNewApiSelf({ account: effectiveAccount, fetchImpl })
    if (synced?.account_info.id) {
      effectiveAccount = synced
      await repository.saveAccount(effectiveAccount)
    }
  }

  const result = await executeProviderCheckin(effectiveAccount, fetchImpl)

  if (
    result.status === CheckinResultStatus.Success ||
    result.status === CheckinResultStatus.AlreadyChecked
  ) {
    let nextAccount = markAccountCheckedIn(effectiveAccount)
    const synced = await fetchNewApiSelf({ account: nextAccount, fetchImpl })
    if (synced) {
      nextAccount = synced
    }
    await repository.saveAccount(nextAccount)
  }

  await repository.setLatestAccountResult(effectiveAccount.id, result)
  return result
}

export async function executeCheckinAccount(
  options: CheckinAccountExecutionOptions,
): Promise<CheckinAccountResult> {
  const ineligible = evaluateEligibility(options.account, options.mode)
  if (ineligible) {
    return ineligible
  }

  return await runForAccount(
    options.account,
    options.repository,
    options.fetchImpl,
  )
}

export async function executeCheckinRun(
  options: CheckinExecutionOptions,
): Promise<CheckinRunRecord> {
  const allAccounts = await options.repository.getAccounts()
  const selectedAccountIds =
    options.targetAccountIds?.filter((accountId) => accountId.trim()) ??
    (options.targetAccountId ? [options.targetAccountId] : null)
  const selectedAccountIdSet = selectedAccountIds
    ? new Set(selectedAccountIds)
    : null
  const targetAccounts = selectedAccountIdSet
    ? allAccounts.filter((account) => selectedAccountIdSet.has(account.id))
    : allAccounts

  const startedAt = Date.now()
  const results: CheckinAccountResult[] = []
  const emptySummary = summarizeCheckinResults([])

  await options.onProgress?.({
    phase: "started",
    total: targetAccounts.length,
      processed: 0,
      summary: emptySummary,
    })

  for (const [index, account] of targetAccounts.entries()) {
    await options.onProgress?.({
      phase: "account_started",
      total: targetAccounts.length,
      processed: index,
      accountId: account.id,
      siteName: account.site_name,
      message: "正在执行签到",
      summary: summarizeCheckinResults(results),
    })

    const result = await executeCheckinAccount({
      repository: options.repository,
      account,
      mode: options.mode,
      fetchImpl: options.fetchImpl,
    })
    results.push(result)

    await options.onProgress?.({
      phase: "account_completed",
      total: targetAccounts.length,
      processed: index + 1,
      accountId: account.id,
      siteName: account.site_name,
      status: result.status,
      message: result.message,
      summary: summarizeCheckinResults(results),
    })
  }

  const completedAt = Date.now()
  const record: CheckinRunRecord = {
    id: crypto.randomUUID(),
    initiatedBy: options.initiatedBy,
    targetAccountIds: selectedAccountIds,
    startedAt,
    completedAt,
    summary: summarizeCheckinResults(results),
    results,
  }

  await options.repository.appendHistory(record)
  await options.onProgress?.({
    phase: "completed",
    total: targetAccounts.length,
    processed: targetAccounts.length,
    summary: record.summary,
  })
  return record
}
