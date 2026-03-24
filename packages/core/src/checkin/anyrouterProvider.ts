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
  if (!normalized) {
    return true
  }

  return ["已经签到", "已签到", "今天已经签到", "already"].some((snippet) =>
    normalized.includes(snippet.toLowerCase()),
  )
}

function isSuccessMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("success") || normalized.includes("签到成功")
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

export async function runAnyrouterCheckin(params: {
  account: SiteAccount
  fetchImpl?: typeof fetch
}): Promise<CheckinAccountResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const account = params.account
  const startedAt = Date.now()
  const checkInUrl = joinUrl(account.site_url, resolveCheckInPath(account.site_type))

  try {
    const response = await fetchImpl(
      joinUrl(normalizeBaseUrl(account.site_url), "/api/user/sign_in"),
      {
        method: "POST",
        headers: buildAccountHeaders(account, {
          preferCookie: true,
          extraHeaders: {
            "X-Requested-With": "XMLHttpRequest",
          },
        }),
        body: "{}",
      },
    )

    const parsed = await parseJsonResponse(response)
    const payload = parsed.payload
    const success = payload?.success === true
    const message = resolvePayloadMessage(payload, parsed.rawText)

    if (!success) {
      const isHtmlResponse = parsed.rawText.trimStart().startsWith("<")
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.Failed,
        code:
          parsed.statusCode === 401 || parsed.statusCode === 403 || isHtmlResponse
            ? "auth_invalid"
            : "checkin_failed",
        message: isHtmlResponse
          ? "站点返回 HTML（可能被 Cloudflare 拦截），需通过浏览器登录"
          : message || "签到失败，请检查站点登录状态",
        rawMessage: isHtmlResponse ? undefined : message || parsed.rawText || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

    if (isAlreadyCheckedMessage(message)) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.AlreadyChecked,
        message: message || "今天已经签到",
        rawMessage: message || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

    if (isSuccessMessage(message)) {
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

    return {
      ...buildBaseResult(account, startedAt),
      status: CheckinResultStatus.Failed,
      code: "checkin_failed",
      message: message || "签到失败，请检查站点返回结果",
      rawMessage: message || parsed.rawText || undefined,
      completedAt: Date.now(),
      checkInUrl,
    }
  } catch (error) {
    const message = describeError(error)
    if (isAlreadyCheckedMessage(message)) {
      return {
        ...buildBaseResult(account, startedAt),
        status: CheckinResultStatus.AlreadyChecked,
        message: message || "今天已经签到",
        rawMessage: message || undefined,
        completedAt: Date.now(),
        checkInUrl,
      }
    }

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
