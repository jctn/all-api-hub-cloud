import { AuthType, type SiteAccount } from "../models/types.js"
import { isAnyrouterSiteType } from "../models/siteTypes.js"
import {
  normalizeCookieHeaderValue,
  normalizeHeaderValue,
} from "../utils/auth.js"
import { buildCompatUserIdHeaders } from "../utils/compatHeaders.js"

const QUOTA_PER_USD = 500_000

export function normalizeMessage(message: unknown): string {
  return typeof message === "string" ? message : ""
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.message]

    const cause = error.cause
    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      parts.push(cause.message)
    } else if (
      cause &&
      typeof cause === "object" &&
      "message" in cause &&
      typeof cause.message === "string" &&
      cause.message &&
      cause.message !== error.message
    ) {
      parts.push(cause.message)
    } else if (typeof cause === "string" && cause && cause !== error.message) {
      parts.push(cause)
    }

    return parts.filter(Boolean).join(" | ")
  }

  return String(error)
}

export async function parseJsonResponse(response: Response): Promise<{
  statusCode: number
  payload: Record<string, unknown> | null
  rawText: string
}> {
  const rawText = await response.text()
  if (!rawText.trim()) {
    return { statusCode: response.status, payload: null, rawText }
  }

  try {
    return {
      statusCode: response.status,
      payload: JSON.parse(rawText) as Record<string, unknown>,
      rawText,
    }
  } catch {
    return {
      statusCode: response.status,
      payload: null,
      rawText,
    }
  }
}

export function resolvePayloadMessage(
  payload: Record<string, unknown> | null,
  rawText: string,
): string {
  if (payload && Object.prototype.hasOwnProperty.call(payload, "message")) {
    return normalizeMessage(payload.message)
  }

  return normalizeMessage(rawText)
}

export function resolveRewardFromData(data: unknown): string {
  const rewardKeys = [
    "quota",
    "reward",
    "amount",
    "bonus",
    "points",
    "score",
    "credit",
    "credits",
    "increaseQuota",
    "rewardAmount",
  ]

  const normalizeRewardValue = (value: unknown): string => {
    if (typeof value === "number" && value > 0) {
      return `获得 ${value} 积分`
    }

    if (typeof value !== "string") {
      return ""
    }

    const trimmed = value.trim()
    if (!trimmed) {
      return ""
    }

    if (/^\+?\d+(?:\.\d+)?$/u.test(trimmed)) {
      return `获得 ${trimmed.replace(/^\+/u, "")} 积分`
    }

    if (/(获得|奖励|赠送|积分|点|额度|余额|元|刀|usd|￥|¥)/iu.test(trimmed)) {
      return trimmed
    }

    return ""
  }

  if (typeof data === "number" || typeof data === "string") {
    return normalizeRewardValue(data)
  }

  if (!data || typeof data !== "object") {
    return ""
  }

  const obj = data as Record<string, unknown>
  for (const key of rewardKeys) {
    const reward = normalizeRewardValue(obj[key])
    if (reward) {
      return reward
    }
  }

  for (const key of rewardKeys) {
    const nested = obj[key]
    if (nested && typeof nested === "object") {
      const nestedObj = nested as Record<string, unknown>
      for (const nestedKey of rewardKeys) {
        const reward = normalizeRewardValue(nestedObj[nestedKey])
        if (reward) {
          return reward
        }
      }
    }
  }

  return ""
}

function formatQuotaDeltaAsReward(deltaQuota: number): string {
  const deltaUsd = deltaQuota / QUOTA_PER_USD
  const precision = deltaUsd >= 1 ? 2 : deltaUsd >= 0.1 ? 3 : 4
  const normalized = Number(deltaUsd.toFixed(precision)).toString()
  return `获得 ${normalized} 刀`
}

function formatQuotaAsSignedIncome(quota: number): string {
  const deltaUsd = quota / QUOTA_PER_USD
  const precision = deltaUsd >= 1 ? 2 : deltaUsd >= 0.1 ? 3 : 4
  const normalized = Number(Math.abs(deltaUsd).toFixed(precision)).toString()
  const sign = deltaUsd >= 0 ? "+" : "-"
  return `今日收入 ${sign}${normalized} 刀`
}

export function resolveRewardFromAccountDiff(
  before: SiteAccount,
  after: SiteAccount,
): string {
  const incomeDelta =
    (after.account_info.today_income || 0) - (before.account_info.today_income || 0)
  if (incomeDelta > 0) {
    return formatQuotaDeltaAsReward(incomeDelta)
  }

  const quotaDelta =
    (after.account_info.quota || 0) - (before.account_info.quota || 0)
  if (quotaDelta > 0) {
    return formatQuotaDeltaAsReward(quotaDelta)
  }

  return ""
}

export function resolveTodayIncomeDetail(account: SiteAccount): string {
  return formatQuotaAsSignedIncome(account.account_info.today_income || 0)
}

export function buildAccountHeaders(
  account: SiteAccount,
  options?: {
    preferCookie?: boolean
    extraHeaders?: Record<string, string>
  },
): HeadersInit {
  const accessToken = normalizeHeaderValue(account.account_info.access_token.trim())
  const sessionCookie = account.cookieAuth?.sessionCookie
    ? normalizeCookieHeaderValue(account.cookieAuth.sessionCookie)
    : ""
  const preferCookie =
    options?.preferCookie ?? (isAnyrouterSiteType(account.site_type) && Boolean(sessionCookie))

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Pragma: "no-cache",
    ...buildCompatUserIdHeaders(account.account_info.id),
    ...(options?.extraHeaders ?? {}),
  }

  if (
    accessToken &&
    !preferCookie &&
    (account.authType === AuthType.AccessToken || !sessionCookie)
  ) {
    headers.Authorization = `Bearer ${accessToken}`
  }

  if (
    sessionCookie &&
    (preferCookie || account.authType === AuthType.Cookie || !accessToken)
  ) {
    headers.Cookie = sessionCookie
  }

  return headers
}
