import { AuthType, type SiteAccount } from "../models/types.js"
import { isAnyrouterSiteType } from "../models/siteTypes.js"
import {
  normalizeCookieHeaderValue,
  normalizeHeaderValue,
} from "../utils/auth.js"
import { buildCompatUserIdHeaders } from "../utils/compatHeaders.js"

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
  if (typeof data === "number" && data > 0) return `获得 ${data} 积分`
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>
    const quota = obj.quota ?? obj.reward ?? obj.amount
    if (typeof quota === "number" && quota > 0) return `获得 ${quota} 积分`
  }
  return ""
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
