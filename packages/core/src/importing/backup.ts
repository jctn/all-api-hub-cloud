import crypto from "node:crypto"

import {
  type BackupImportPreview,
  type BackupImportResult,
  type ParsedBackupSummary,
  AuthType,
  type SiteAccount,
  HealthState,
} from "../models/types.js"
import {
  isAnyrouterSiteType,
  isSupportedCheckinSiteType,
} from "../models/siteTypes.js"
import { type StorageRepository } from "../storage/repository.js"
import { hasUsableAuth, normalizeAuthType } from "../utils/auth.js"
import { formatTimestamp } from "../utils/date.js"
import {
  asBoolean,
  asNumber,
  asString,
  asTrimmedString,
  isRecord,
} from "../utils/object.js"

type RawBackupData = Record<string, unknown>

export function parseBackupSummary(
  importData: string,
): ParsedBackupSummary | { valid: false } | null {
  if (!importData.trim()) {
    return null
  }

  try {
    const data = JSON.parse(importData) as RawBackupData
    return {
      valid: true,
      hasAccounts: Boolean(
        Array.isArray(data.accounts) ||
          (isRecord(data.accounts) && Array.isArray(data.accounts.accounts)) ||
          (isRecord(data.data) && Array.isArray(data.data.accounts)),
      ),
      hasPreferences: Boolean(data.preferences || data.type === "preferences"),
      hasChannelConfigs: Boolean(data.channelConfigs),
      hasTagStore: Boolean(data.tagStore),
      hasApiCredentialProfiles: Boolean(data.apiCredentialProfiles),
      timestamp: formatTimestamp(asNumber(data.timestamp, 0)),
    }
  } catch {
    return { valid: false }
  }
}

function extractRawAccounts(data: RawBackupData): unknown[] {
  if (Array.isArray(data.accounts)) {
    return data.accounts
  }

  if (isRecord(data.accounts) && Array.isArray(data.accounts.accounts)) {
    return data.accounts.accounts
  }

  if (isRecord(data.data) && Array.isArray(data.data.accounts)) {
    return data.data.accounts
  }

  return []
}

function normalizeHealthStatus(value: unknown): HealthState {
  const normalized = asTrimmedString(value).toLowerCase()
  if (
    normalized === HealthState.Healthy ||
    normalized === HealthState.Warning ||
    normalized === HealthState.Error ||
    normalized === HealthState.Unknown
  ) {
    return normalized as HealthState
  }

  return HealthState.Healthy
}

function normalizeImportedAccount(candidate: unknown, now: number): {
  account?: SiteAccount
  missingRequired: boolean
} {
  if (!isRecord(candidate)) {
    return { missingRequired: true }
  }

  const siteUrl = asTrimmedString(candidate.site_url)
  if (!siteUrl) {
    return { missingRequired: true }
  }

  const rawAccountInfo = isRecord(candidate.account_info)
    ? candidate.account_info
    : {}
  const rawCheckIn = isRecord(candidate.checkIn) ? candidate.checkIn : {}
  const rawCookieAuth = isRecord(candidate.cookieAuth) ? candidate.cookieAuth : {}
  const rawSub2ApiAuth = isRecord(candidate.sub2apiAuth)
    ? candidate.sub2apiAuth
    : undefined

  const accessToken = asTrimmedString(rawAccountInfo.access_token)
  const sessionCookie = asTrimmedString(rawCookieAuth.sessionCookie)
  const authType = normalizeAuthType(candidate.authType)

  const normalizedAuthType =
    accessToken && authType === AuthType.None
      ? AuthType.AccessToken
      : sessionCookie && authType === AuthType.None
        ? AuthType.Cookie
        : accessToken
          ? authType
          : sessionCookie
            ? AuthType.Cookie
            : authType

  const account: SiteAccount = {
    id: asTrimmedString(candidate.id) || crypto.randomUUID(),
    site_name:
      asTrimmedString(candidate.site_name) ||
      asTrimmedString(rawAccountInfo.username) ||
      siteUrl,
    site_url: siteUrl,
    health: {
      status: normalizeHealthStatus(
        isRecord(candidate.health) ? candidate.health.status : undefined,
      ),
      reason: isRecord(candidate.health)
        ? asTrimmedString(candidate.health.reason)
        : undefined,
    },
    site_type: asTrimmedString(candidate.site_type) || "unknown",
    exchange_rate: asNumber(candidate.exchange_rate, 7.2),
    account_info: {
      id: asNumber(rawAccountInfo.id, 0),
      access_token: accessToken,
      username: asTrimmedString(rawAccountInfo.username),
      quota: asNumber(rawAccountInfo.quota, 0),
      today_prompt_tokens: asNumber(rawAccountInfo.today_prompt_tokens, 0),
      today_completion_tokens: asNumber(rawAccountInfo.today_completion_tokens, 0),
      today_quota_consumption: asNumber(
        rawAccountInfo.today_quota_consumption,
        0,
      ),
      today_requests_count: asNumber(rawAccountInfo.today_requests_count, 0),
      today_income: asNumber(rawAccountInfo.today_income, 0),
    },
    last_sync_time: asNumber(candidate.last_sync_time, now),
    updated_at: asNumber(candidate.updated_at, now),
    created_at: asNumber(candidate.created_at, now),
    notes: asString(candidate.notes, ""),
    tagIds: Array.isArray(candidate.tagIds)
      ? candidate.tagIds.filter((item): item is string => typeof item === "string")
      : [],
    disabled: asBoolean(candidate.disabled, false),
    excludeFromTotalBalance: asBoolean(candidate.excludeFromTotalBalance, false),
    authType: normalizedAuthType,
    cookieAuth: sessionCookie ? { sessionCookie } : undefined,
    sub2apiAuth:
      rawSub2ApiAuth && asTrimmedString(rawSub2ApiAuth.refreshToken)
        ? {
            refreshToken: asTrimmedString(rawSub2ApiAuth.refreshToken),
            tokenExpiresAt: asNumber(rawSub2ApiAuth.tokenExpiresAt, 0) || undefined,
          }
        : undefined,
    checkIn: {
      enableDetection: Boolean(
        rawCheckIn.enableDetection ??
          candidate.can_check_in ??
          candidate.supports_check_in ??
          false,
      ),
      autoCheckInEnabled:
        typeof rawCheckIn.autoCheckInEnabled === "boolean"
          ? rawCheckIn.autoCheckInEnabled
          : true,
      siteStatus: isRecord(rawCheckIn.siteStatus)
        ? {
            isCheckedInToday:
              typeof rawCheckIn.siteStatus.isCheckedInToday === "boolean"
                ? rawCheckIn.siteStatus.isCheckedInToday
                : undefined,
            lastCheckInDate: asTrimmedString(
              rawCheckIn.siteStatus.lastCheckInDate,
            ),
            lastDetectedAt:
              asNumber(rawCheckIn.siteStatus.lastDetectedAt, 0) || undefined,
          }
        : undefined,
      customCheckIn: isRecord(rawCheckIn.customCheckIn)
        ? {
            url: asTrimmedString(rawCheckIn.customCheckIn.url),
            redeemUrl: asTrimmedString(rawCheckIn.customCheckIn.redeemUrl),
            openRedeemWithCheckIn:
              typeof rawCheckIn.customCheckIn.openRedeemWithCheckIn === "boolean"
                ? rawCheckIn.customCheckIn.openRedeemWithCheckIn
                : undefined,
          }
        : undefined,
    },
    manualBalanceUsd: asTrimmedString(candidate.manualBalanceUsd),
  }

  return { account, missingRequired: false }
}

function hasUsableImportedCheckinAuth(account: SiteAccount): boolean {
  if (isAnyrouterSiteType(account.site_type)) {
    return Boolean(account.cookieAuth?.sessionCookie?.trim())
  }

  return hasUsableAuth(account)
}

export function previewBackupImport(raw: string): BackupImportPreview {
  const payload = JSON.parse(raw) as RawBackupData
  const rawAccounts = extractRawAccounts(payload)
  const now = Date.now()

  let missingFieldAccounts = 0
  const accounts: SiteAccount[] = []

  for (const rawAccount of rawAccounts) {
    const normalized = normalizeImportedAccount(rawAccount, now)
    if (!normalized.account) {
      missingFieldAccounts += 1
      continue
    }
    accounts.push(normalized.account)
  }

  const unsupportedAccounts = accounts.filter(
    (account) => !isSupportedCheckinSiteType(account.site_type),
  ).length
  const checkinCapableAccounts = accounts.filter(
    (account) =>
      isSupportedCheckinSiteType(account.site_type) &&
      hasUsableImportedCheckinAuth(account),
  ).length

  return {
    accounts,
    summary: {
      totalAccountNodes: rawAccounts.length,
      importableAccounts: accounts.length,
      checkinCapableAccounts,
      unsupportedAccounts,
      missingFieldAccounts,
      skippedAccounts: rawAccounts.length - accounts.length,
    },
  }
}

export async function importBackupIntoRepository(params: {
  repository: StorageRepository
  raw: string
  sourcePath?: string
}): Promise<BackupImportResult> {
  const preview = previewBackupImport(params.raw)
  const existingAccounts = await params.repository.getAccounts()

  await params.repository.replaceAccounts(preview.accounts)
  await params.repository.saveSettings({
    lastImportPath: params.sourcePath,
    lastImportedAt: Date.now(),
  })

  return {
    ...preview,
    replacedExistingCount: existingAccounts.length,
  }
}
