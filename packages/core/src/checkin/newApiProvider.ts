import {
  AuthType,
  CheckinResultStatus,
  type CheckinAccountResult,
  type SiteAccount,
} from "../models/types.js"
import { resolveCheckInPath } from "../models/siteTypes.js"
import { toLocalDayKey } from "../utils/date.js"
import { joinUrl, normalizeBaseUrl } from "../utils/url.js"
import {
  buildAccountHeaders,
  describeError,
  normalizeMessage,
  parseJsonResponse,
  resolvePayloadMessage,
  resolveRewardFromData,
} from "./shared.js"

function isAlreadyCheckedMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return ["已经签到", "已签到", "今天已经签到", "already"].some((snippet) =>
    normalized.includes(snippet.toLowerCase()),
  )
}

function isManualActionRequired(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes("turnstile") ||
    normalized.includes("cloudflare") ||
    normalized.includes("captcha") ||
    normalized.includes("校验") ||
    normalized.includes("验证")
  )
}

function buildBaseResult(
  account: SiteAccount,
  startedAt: number,
): Omit<
  CheckinAccountResult,
  "status" | "message" | "code" | "rawMessage" | "completedAt" | "checkInUrl"
> {
  return {
    accountId: account.id,
    siteName: account.site_name,
    siteUrl: account.site_url,
    siteType: account.site_type,
    startedAt,
  }
}

export async function runNewApiCheckin(params: {
  account: SiteAccount
  fetchImpl?: typeof fetch
}): Promise<CheckinAccountResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const account = params.account
  const startedAt = Date.now()
  const checkInUrl = joinUrl(account.site_url, resolveCheckInPath(account.site_type))

  try {
    const response = await fetchImpl(joinUrl(normalizeBaseUrl(account.site_url), "/api/user/checkin"), {
      method: "POST",
      headers: buildAccountHeaders(account),
      body: "{}",
    })
    const parsed = await parseJsonResponse(response)
    const payload = parsed.payload
    const success = payload?.success === true
    const message = resolvePayloadMessage(payload, parsed.rawText)

    if (success) {
      const rewardFromData = resolveRewardFromData(payload?.data)
      const fullMessage =
        rewardFromData && !message.includes(rewardFromData)
          ? `${message || "签到成功"}，${rewardFromData}`
          : message || "签到成功"
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.Success,
        message: fullMessage,
        completedAt: Date.now(),
        rawMessage: message || undefined,
        checkInUrl,
      }
    }

    if (message && isAlreadyCheckedMessage(message)) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.AlreadyChecked,
        message,
        completedAt: Date.now(),
        rawMessage: message,
        checkInUrl,
      }
    }

    if (
      isManualActionRequired(message) ||
      parsed.rawText.toLowerCase().includes("cloudflare")
    ) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.ManualActionRequired,
        code: "turnstile_required",
        message: message || "需要人工完成 Turnstile / Cloudflare 验证后重试",
        rawMessage: message || parsed.rawText || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

    if (parsed.statusCode === 401 || parsed.statusCode === 403) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.Failed,
        code: "auth_invalid",
        message: message || "认证失效，请重新登录",
        rawMessage: message || parsed.rawText || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

    return {
      ...buildBaseResult(account, startedAt),
      status: CheckinResultStatus.Failed,
      code: "checkin_failed",
      message: message || `签到失败，HTTP ${parsed.statusCode}`,
      rawMessage: message || parsed.rawText || undefined,
      completedAt: Date.now(),
      checkInUrl,
    }
  } catch (error) {
    const message = describeError(error)
    return {
      ...buildBaseResult(account, startedAt),
      status: CheckinResultStatus.Failed,
      code: "network_error",
      message: message || "网络请求失败",
      rawMessage: message || undefined,
      completedAt: Date.now(),
      checkInUrl,
    }
  }
}

export async function fetchNewApiSelf(params: {
  account: SiteAccount
  fetchImpl?: typeof fetch
}): Promise<SiteAccount | null> {
  const fetchImpl = params.fetchImpl ?? fetch
  const account = params.account
  const toNumberOrFallback = (value: unknown, fallback: number): number => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
    return fallback
  }

  try {
    const response = await fetchImpl(
      joinUrl(normalizeBaseUrl(account.site_url), "/api/user/self"),
      {
        method: "GET",
        headers: buildAccountHeaders(account),
      },
    )

    const parsed = await parseJsonResponse(response)
    const payloadData =
      parsed.payload && typeof parsed.payload.data === "object"
        ? (parsed.payload.data as Record<string, unknown>)
        : parsed.payload

    if (!payloadData || !response.ok) {
      return null
    }

    return {
      ...account,
      last_sync_time: Date.now(),
      updated_at: Date.now(),
      account_info: {
        ...account.account_info,
        id:
          typeof payloadData.id === "number" ? payloadData.id : account.account_info.id,
        username:
          typeof payloadData.username === "string"
            ? payloadData.username
            : account.account_info.username,
        access_token:
          typeof payloadData.access_token === "string" &&
          payloadData.access_token.trim()
            ? payloadData.access_token
            : account.account_info.access_token,
        quota:
          toNumberOrFallback(payloadData.quota, account.account_info.quota),
        today_prompt_tokens: toNumberOrFallback(
          payloadData.today_prompt_tokens,
          account.account_info.today_prompt_tokens,
        ),
        today_completion_tokens: toNumberOrFallback(
          payloadData.today_completion_tokens,
          account.account_info.today_completion_tokens,
        ),
        today_quota_consumption: toNumberOrFallback(
          payloadData.today_quota_consumption,
          account.account_info.today_quota_consumption,
        ),
        today_requests_count: toNumberOrFallback(
          payloadData.today_requests_count,
          account.account_info.today_requests_count,
        ),
        today_income: toNumberOrFallback(
          payloadData.today_income,
          account.account_info.today_income,
        ),
      },
    }
  } catch {
    return null
  }
}

export function markAccountCheckedIn(account: SiteAccount): SiteAccount {
  const today = toLocalDayKey()
  return {
    ...account,
    updated_at: Date.now(),
    checkIn: {
      ...account.checkIn,
      siteStatus: {
        ...account.checkIn.siteStatus,
        isCheckedInToday: true,
        lastCheckInDate: today,
        lastDetectedAt: Date.now(),
      },
    },
  }
}
