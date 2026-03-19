export enum AuthType {
  None = "none",
  AccessToken = "access_token",
  Cookie = "cookie",
}

export enum HealthState {
  Healthy = "healthy",
  Warning = "warning",
  Error = "error",
  Unknown = "unknown",
}

export interface AccountInfo {
  id: number
  access_token: string
  username: string
  quota: number
  today_prompt_tokens: number
  today_completion_tokens: number
  today_quota_consumption: number
  today_requests_count: number
  today_income: number
}

export interface CookieAuthConfig {
  sessionCookie: string
}

export interface Sub2ApiAuthConfig {
  refreshToken: string
  tokenExpiresAt?: number
}

export interface CheckInConfig {
  enableDetection: boolean
  autoCheckInEnabled?: boolean
  siteStatus?: {
    isCheckedInToday?: boolean
    lastCheckInDate?: string
    lastDetectedAt?: number
  }
  customCheckIn?: {
    url?: string
    redeemUrl?: string
    openRedeemWithCheckIn?: boolean
  }
}

export interface SiteAccount {
  id: string
  site_name: string
  site_url: string
  health: {
    status: HealthState
    reason?: string
  }
  site_type: string
  exchange_rate: number
  account_info: AccountInfo
  last_sync_time: number
  updated_at: number
  created_at: number
  notes: string
  tagIds: string[]
  disabled: boolean
  excludeFromTotalBalance: boolean
  authType: AuthType
  cookieAuth?: CookieAuthConfig
  sub2apiAuth?: Sub2ApiAuthConfig
  checkIn: CheckInConfig
  manualBalanceUsd?: string
}

export interface AppSettings {
  version: 1
  lastImportPath?: string
  lastImportedAt?: number
  lastImportedCommitSha?: string
}

export enum CheckinResultStatus {
  Success = "success",
  AlreadyChecked = "already_checked",
  Failed = "failed",
  ManualActionRequired = "manual_action_required",
  Skipped = "skipped",
}

export interface CheckinAccountResult {
  accountId: string
  siteName: string
  siteUrl: string
  siteType: string
  status: CheckinResultStatus
  message: string
  code?: string
  rawMessage?: string
  checkInUrl?: string
  startedAt: number
  completedAt: number
}

export interface CheckinRunSummary {
  total: number
  success: number
  alreadyChecked: number
  failed: number
  manualActionRequired: number
  skipped: number
}

export interface CheckinRunRecord {
  id: string
  initiatedBy: "cli" | "desktop" | "server"
  targetAccountIds: string[] | null
  startedAt: number
  completedAt: number
  summary: CheckinRunSummary
  results: CheckinAccountResult[]
}

export interface AccountCheckinState {
  lastRunAt?: number
  lastStatus?: CheckinResultStatus
  lastMessage?: string
  requiresManualAction?: boolean
}

export interface CheckinHistoryDocument {
  version: 1
  updatedAt: number
  records: CheckinRunRecord[]
  accountStates: Record<string, AccountCheckinState>
}

export interface AccountsDocument {
  version: 1
  updatedAt: number
  accounts: SiteAccount[]
}

export interface ParsedBackupSummary {
  valid: boolean
  hasAccounts: boolean
  hasPreferences: boolean
  hasChannelConfigs: boolean
  hasTagStore: boolean
  hasApiCredentialProfiles: boolean
  timestamp: string
}

export interface BackupImportSummary {
  totalAccountNodes: number
  importableAccounts: number
  checkinCapableAccounts: number
  unsupportedAccounts: number
  missingFieldAccounts: number
  skippedAccounts: number
}

export interface BackupImportPreview {
  summary: BackupImportSummary
  accounts: SiteAccount[]
}

export interface BackupImportResult extends BackupImportPreview {
  replacedExistingCount: number
}

export type AccountAuthState =
  | "has_access_token"
  | "has_cookie"
  | "needs_login"

export type AccountSupportState = "supported" | "unsupported"
