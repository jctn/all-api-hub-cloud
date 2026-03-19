import {
  deriveAccountAuthState,
  deriveAccountSupportState,
  type AppSettings,
  type CheckinRunRecord,
  type SiteAccount,
} from "@all-api-hub/core"

import type {
  BatchCheckinRunResult,
  SessionRefreshRunResult,
} from "../checkin/orchestrator.js"
import type { GitHubImportSyncResult } from "../importing/githubRepoImporter.js"
import type { TaskSnapshot } from "../taskCoordinator.js"
import { formatTimestamp } from "../utils/text.js"

function formatAccount(account: SiteAccount): string {
  const authState = deriveAccountAuthState(account)
  const supportState = deriveAccountSupportState(account)
  return [
    `- ${account.site_name} (${account.id})`,
    `  ${account.site_url}`,
    `  auth=${authState} support=${supportState} disabled=${account.disabled ? "yes" : "no"}`,
  ].join("\n")
}

export function formatImportMessage(
  result: GitHubImportSyncResult,
  timeZone: string,
): string {
  if (result.skipped) {
    return [
      "导入跳过：GitHub JSON 没有新 commit。",
      `sha: ${result.sha}`,
      `上次导入时间: ${formatTimestamp(result.importedAt, timeZone)}`,
    ].join("\n")
  }

  const summary = result.result?.summary
  return [
    "导入完成。",
    `sha: ${result.sha}`,
    `总账号: ${summary?.importableAccounts ?? 0}`,
    `可签到: ${summary?.checkinCapableAccounts ?? 0}`,
    `不支持: ${summary?.unsupportedAccounts ?? 0}`,
    `缺字段: ${summary?.missingFieldAccounts ?? 0}`,
    `导入时间: ${formatTimestamp(result.importedAt, timeZone)}`,
  ].join("\n")
}

export function formatCheckinMessage(
  result: BatchCheckinRunResult,
  timeZone: string,
): string {
  const summary = result.record.summary
  const issues = result.record.results.filter(
    (item) => item.status !== "success" && item.status !== "already_checked",
  )

  const lines = [
    "批量签到完成。",
    `开始: ${formatTimestamp(result.record.startedAt, timeZone)}`,
    `结束: ${formatTimestamp(result.record.completedAt, timeZone)}`,
    `success=${summary.success} already=${summary.alreadyChecked} failed=${summary.failed} manual=${summary.manualActionRequired} skipped=${summary.skipped}`,
  ]

  if (result.refreshedAccountIds.length > 0) {
    lines.push(`自动续期账号: ${result.refreshedAccountIds.join(", ")}`)
  }

  if (issues.length > 0) {
    lines.push("问题账号:")
    for (const issue of issues.slice(0, 10)) {
      lines.push(`- ${issue.siteName}: ${issue.message}`)
    }
  }

  return lines.join("\n")
}

export function formatRefreshMessage(
  result: SessionRefreshRunResult,
  timeZone: string,
): string {
  const lines = [
    "会话刷新完成。",
    `开始: ${formatTimestamp(result.startedAt, timeZone)}`,
    `结束: ${formatTimestamp(result.completedAt, timeZone)}`,
    `refreshed=${result.summary.refreshed} manual=${result.summary.manualActionRequired} unsupported=${result.summary.unsupportedAutoReauth} failed=${result.summary.failed}`,
  ]

  for (const item of result.results.filter((entry) => entry.status !== "refreshed").slice(0, 10)) {
    lines.push(`- ${item.siteName}: ${item.message}`)
  }

  return lines.join("\n")
}

export function formatAccountsMessage(accounts: SiteAccount[]): string {
  if (accounts.length === 0) {
    return "当前没有账号。"
  }

  return [`当前账号数: ${accounts.length}`, ...accounts.map(formatAccount)].join("\n")
}

export function formatStatusMessage(params: {
  task: TaskSnapshot
  latestRecord?: CheckinRunRecord
  settings: AppSettings
  timeZone: string
}): string {
  const lines = [
    `当前任务: ${params.task.active ? params.task.label ?? params.task.kind : "空闲"}`,
  ]

  if (params.task.startedAt) {
    lines.push(`任务开始: ${formatTimestamp(params.task.startedAt, params.timeZone)}`)
  }

  if (params.settings.lastImportedCommitSha) {
    lines.push(`最近导入 SHA: ${params.settings.lastImportedCommitSha}`)
  }

  if (params.settings.lastImportedAt) {
    lines.push(
      `最近导入时间: ${formatTimestamp(params.settings.lastImportedAt, params.timeZone)}`,
    )
  }

  if (params.latestRecord) {
    lines.push(
      `最近签到: success=${params.latestRecord.summary.success} already=${params.latestRecord.summary.alreadyChecked} failed=${params.latestRecord.summary.failed} manual=${params.latestRecord.summary.manualActionRequired}`,
    )
    lines.push(
      `最近签到完成: ${formatTimestamp(params.latestRecord.completedAt, params.timeZone)}`,
    )
  }

  return lines.join("\n")
}
