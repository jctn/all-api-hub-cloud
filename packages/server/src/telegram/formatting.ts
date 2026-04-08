import {
  CheckinResultStatus,
  deriveAccountAuthState,
  deriveAccountSupportState,
  type CheckinAccountResult,
  type AppSettings,
  type CheckinRunRecord,
  type SiteAccount,
} from "@all-api-hub/core"

import type {
  AccountSnapshotRefreshRunResult,
  BatchCheckinRunResult,
  SessionRefreshRunResult,
} from "../checkin/orchestrator.js"
import type { GitHubImportSyncResult } from "../importing/githubRepoImporter.js"
import type { TaskSnapshot } from "../taskCoordinator.js"
import { formatTimestamp } from "../utils/text.js"
import { truncateTelegramLine } from "./messageChunks.js"

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
  const refreshedAccountIds = new Set(result.refreshedAccountIds)

  const lines = [
    "批量签到完成。",
    `开始: ${formatTimestamp(result.record.startedAt, timeZone)}`,
    `结束: ${formatTimestamp(result.record.completedAt, timeZone)}`,
    `success=${summary.success} already=${summary.alreadyChecked} failed=${summary.failed} manual=${summary.manualActionRequired} skipped=${summary.skipped}`,
  ]

  if (result.record.results.length === 0) {
    lines.push("本次没有可执行的账号。")
    return lines.join("\n")
  }

  lines.push("账号明细:")
  for (const entry of result.record.results) {
    lines.push(
      `- "${entry.siteName || entry.accountId}"，签到情况：${formatCheckinEntry(entry, refreshedAccountIds)}`,
    )
  }

  return lines.join("\n")
}

function formatCheckinEntry(
  entry: CheckinAccountResult,
  refreshedAccountIds: Set<string>,
): string {
  switch (entry.status) {
    case CheckinResultStatus.AlreadyChecked: {
      const todayIncomeDetail = extractTodayIncomeDetail(entry)
      return todayIncomeDetail ? `已签到（${todayIncomeDetail}）` : "已签到"
    }
    case CheckinResultStatus.Success: {
      const rewardDetail = extractRewardDetail(entry)
      const todayIncomeDetail = extractTodayIncomeDetail(entry)
      const refreshDetail = refreshedAccountIds.has(entry.accountId)
        ? "；已自动续期会话"
        : ""
      const detailParts = [rewardDetail, todayIncomeDetail].filter(
        (value, index, array): value is string =>
          typeof value === "string" && value.length > 0 && array.indexOf(value) === index,
      )
      return detailParts.length > 0
        ? `签到成功（${detailParts.join("；")}）${refreshDetail}`
        : `签到成功${refreshDetail}`
    }
    case CheckinResultStatus.Skipped:
      return "已跳过"
    case CheckinResultStatus.Failed:
    case CheckinResultStatus.ManualActionRequired:
    default:
      return `签到失败；失败原因：${truncateTelegramLine(entry.message || entry.rawMessage || "未知错误")}`
  }
}

function extractRewardDetail(entry: CheckinAccountResult): string | null {
  const candidates = [entry.message, entry.rawMessage].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )

  for (const candidate of candidates) {
    const todayIncomeDetail = extractTodayIncomeDetail({
      ...entry,
      message: candidate,
      rawMessage: undefined,
    })
    const rewardCandidate = todayIncomeDetail
      ? candidate.replace(todayIncomeDetail, "")
      : candidate
    for (const pattern of [
      /(获得[^，。；\n]*)/u,
      /(奖励[^，。；\n]*)/u,
      /(赠送[^，。；\n]*)/u,
      /([+\-]?\d+(?:\.\d+)?\s*(?:元|刀|积分|金币|点|额度|余额|USD|usd|￥|¥))/u,
    ]) {
      const match = rewardCandidate.match(pattern)
      const reward = match?.[1]?.trim()
      if (reward) {
        return reward
      }
    }
  }

  return null
}

function extractTodayIncomeDetail(entry: CheckinAccountResult): string | null {
  const candidates = [entry.message, entry.rawMessage].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  )

  for (const candidate of candidates) {
    const match = candidate.match(/(今日收入[^，。；\n]*)/u)
    const detail = match?.[1]?.trim()
    if (detail) {
      return detail
    }
  }

  return null
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
    lines.push(`- ${item.siteName}: ${truncateTelegramLine(item.message)}`)
  }

  return lines.join("\n")
}

export function formatAccountRefreshMessage(
  result: AccountSnapshotRefreshRunResult,
  timeZone: string,
): string {
  const lines = [
    "账号数据刷新完成。",
    `开始: ${formatTimestamp(result.startedAt, timeZone)}`,
    `结束: ${formatTimestamp(result.completedAt, timeZone)}`,
    `updated=${result.summary.updated} failed=${result.summary.failed} skipped=${result.summary.skipped}`,
  ]

  if (result.results.length === 0) {
    lines.push("本次没有可执行的账号。")
    return lines.join("\n")
  }

  for (const item of result.results.filter((entry) => entry.status !== "updated").slice(0, 10)) {
    lines.push(`- ${item.siteName}: ${truncateTelegramLine(item.message)}`)
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
  deploymentVersion: string
  appVersion: string
  gitCommitShortSha?: string
  gitBranch?: string
  gitCommitMessage?: string
}): string {
  const lines = [
    `服务版本: ${params.deploymentVersion}`,
    `当前任务: ${params.task.active ? params.task.label ?? params.task.kind : "空闲"}`,
  ]

  if (params.gitBranch || params.gitCommitShortSha) {
    lines.push(
      `部署提交: ${params.gitBranch ?? "unknown"}@${params.gitCommitShortSha ?? "unknown"}`,
    )
  }

  if (params.gitCommitMessage) {
    lines.push(`提交说明: ${truncateTelegramLine(params.gitCommitMessage, 120)}`)
  }

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

  if (params.deploymentVersion !== params.appVersion) {
    lines.push(`基础版本: ${params.appVersion}`)
  }

  return lines.join("\n")
}

export function formatVersionMessage(params: {
  deploymentVersion: string
  appVersion: string
  gitCommitShortSha?: string
  gitBranch?: string
  gitCommitMessage?: string
  siteLoginProfilesSource: string
  siteLoginProfilesCount: number
}): string {
  const lines = [`服务版本: ${params.deploymentVersion}`]

  if (params.gitBranch || params.gitCommitShortSha) {
    lines.push(
      `部署提交: ${params.gitBranch ?? "unknown"}@${params.gitCommitShortSha ?? "unknown"}`,
    )
  }

  if (params.gitCommitMessage) {
    lines.push(`提交说明: ${truncateTelegramLine(params.gitCommitMessage, 120)}`)
  }

  if (params.deploymentVersion !== params.appVersion) {
    lines.push(`基础版本: ${params.appVersion}`)
  }

  lines.push(`登录 profile 来源: ${truncateTelegramLine(params.siteLoginProfilesSource, 180)}`)
  lines.push(`登录 profile 数量: ${params.siteLoginProfilesCount}`)

  return lines.join("\n")
}
