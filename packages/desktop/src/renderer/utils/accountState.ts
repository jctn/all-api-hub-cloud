import { type SiteAccount, isSupportedCheckinSiteType } from "@all-api-hub/core"

const QUOTA_PER_USD = 500000

export function deriveAccountAuthState(account: SiteAccount) {
  if (account.account_info.access_token.trim()) {
    return "has_access_token" as const
  }

  if (account.cookieAuth?.sessionCookie?.trim()) {
    return "has_cookie" as const
  }

  return "needs_login" as const
}

export function deriveAccountSupportState(account: SiteAccount) {
  return isSupportedCheckinSiteType(account.site_type)
    ? ("supported" as const)
    : ("unsupported" as const)
}

function toLocalDayKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, "0")
  const day = String(value.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function isTimestampToday(timestamp: number | undefined): boolean {
  if (!timestamp || !Number.isFinite(timestamp)) {
    return false
  }

  return toLocalDayKey(new Date(timestamp)) === toLocalDayKey(new Date())
}

export function deriveAccountTodayCheckinState(account: SiteAccount) {
  if (deriveAccountSupportState(account) !== "supported") {
    return "unsupported" as const
  }

  const siteStatus = account.checkIn.siteStatus
  const today = toLocalDayKey(new Date())

  if (siteStatus?.lastCheckInDate === today) {
    return "checked_today" as const
  }

  if (siteStatus?.isCheckedInToday && isTimestampToday(siteStatus.lastDetectedAt)) {
    return "checked_today" as const
  }

  return "not_checked_today" as const
}

export function formatAccountLastCheckinDate(account: SiteAccount): string {
  return account.checkIn.siteStatus?.lastCheckInDate?.trim() || "暂无"
}

export function formatAccountLastDetectedAt(account: SiteAccount): string {
  const timestamp = account.checkIn.siteStatus?.lastDetectedAt
  if (!timestamp || !Number.isFinite(timestamp)) {
    return "暂无"
  }

  return new Date(timestamp).toLocaleString()
}

function parseManualBalanceUsd(value: string | undefined): number | null {
  const normalized = value?.trim()
  if (!normalized) {
    return null
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

export function deriveAccountBalanceUsd(account: SiteAccount): number {
  const manualBalanceUsd = parseManualBalanceUsd(account.manualBalanceUsd)
  if (manualBalanceUsd !== null) {
    return manualBalanceUsd
  }

  return account.account_info.quota / QUOTA_PER_USD
}

export function deriveAccountBalanceCny(account: SiteAccount): number {
  return deriveAccountBalanceUsd(account) * (account.exchange_rate || 0)
}

export function formatAccountBalanceUsd(account: SiteAccount): string {
  return `$${deriveAccountBalanceUsd(account).toFixed(2)}`
}

export function formatAccountBalanceCny(account: SiteAccount): string {
  return `¥${deriveAccountBalanceCny(account).toFixed(2)}`
}

export function formatAccountLastSyncTime(account: SiteAccount): string {
  if (!account.last_sync_time || !Number.isFinite(account.last_sync_time)) {
    return "未同步"
  }

  return new Date(account.last_sync_time).toLocaleString()
}
