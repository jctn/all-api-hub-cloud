import {
  CheckinResultStatus,
  type CheckinAccountResult,
  type SiteAccount,
} from "../models/types.js"
import { resolveCheckInPath } from "../models/siteTypes.js"
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
  const normalized = normalizeMessage(message).trim().toLowerCase()
  return ["今天已经签到", "已经签到", "已签到", "already"].some((snippet) =>
    normalized.includes(snippet.toLowerCase()),
  )
}

function isManualActionRequired(message: string): boolean {
  const normalized = normalizeMessage(message).trim().toLowerCase()
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

export async function runWongCheckin(params: {
  account: SiteAccount
  fetchImpl?: typeof fetch
}): Promise<CheckinAccountResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const account = params.account
  const startedAt = Date.now()
  const checkInUrl = joinUrl(account.site_url, resolveCheckInPath(account.site_type))

  try {
    const response = await fetchImpl(
      joinUrl(normalizeBaseUrl(account.site_url), "/api/user/checkin"),
      {
        method: "POST",
        headers: buildAccountHeaders(account),
        body: "{}",
      },
    )

    const parsed = await parseJsonResponse(response)
    const payload = parsed.payload
    const payloadData =
      payload && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : null
    const success = payload?.success === true
    const message = resolvePayloadMessage(payload, parsed.rawText)
    const checkedIn = payloadData?.checked_in === true
    const checkinEnabled = payloadData?.enabled !== false

    if (!checkinEnabled) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.Failed,
        code: "checkin_disabled",
        message: message || "当前站点未启用签到",
        rawMessage: message || parsed.rawText || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

    if ((message && isAlreadyCheckedMessage(message)) || checkedIn) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.AlreadyChecked,
        message: message || "今天已经签到",
        rawMessage: message || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

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
        rawMessage: message || undefined,
        completedAt: Date.now(),
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
