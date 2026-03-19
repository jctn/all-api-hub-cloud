import {
  type AccountAuthState,
  type AccountSupportState,
  AuthType,
  type SiteAccount,
} from "../models/types.js"
import { isSupportedCheckinSiteType } from "../models/siteTypes.js"

export function normalizeAuthType(value: unknown): AuthType {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()

  if (
    normalized === "cookie" ||
    normalized === "cookieauth" ||
    normalized === "cookie_auth"
  ) {
    return AuthType.Cookie
  }

  if (
    normalized === "accesstoken" ||
    normalized === "access_token" ||
    normalized === "token" ||
    normalized === "bearer"
  ) {
    return AuthType.AccessToken
  }

  if (normalized === "none") {
    return AuthType.None
  }

  return AuthType.AccessToken
}

export function deriveAccountAuthState(account: SiteAccount): AccountAuthState {
  if (account.account_info.access_token.trim()) {
    return "has_access_token"
  }

  if (account.cookieAuth?.sessionCookie?.trim()) {
    return "has_cookie"
  }

  return "needs_login"
}

export function hasUsableAuth(account: SiteAccount): boolean {
  return deriveAccountAuthState(account) !== "needs_login"
}

export function deriveAccountSupportState(
  account: Pick<SiteAccount, "site_type">,
): AccountSupportState {
  return isSupportedCheckinSiteType(account.site_type) ? "supported" : "unsupported"
}

export function buildCookieHeader(
  cookies: Array<{ name: string; value: string }>,
): string {
  return cookies
    .filter(
      (cookie) =>
        typeof cookie.name === "string" &&
        cookie.name.trim() &&
        typeof cookie.value === "string",
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ")
}

export function normalizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim()
}

export function normalizeCookieHeaderValue(value: string): string {
  const normalized = normalizeHeaderValue(value).replace(/^cookie:\s*/iu, "")
  if (!normalized) {
    return ""
  }

  const cookieAttributes = new Set([
    "path",
    "expires",
    "max-age",
    "domain",
    "secure",
    "httponly",
    "samesite",
    "priority",
    "partitioned",
  ])

  return normalized
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => {
      const separatorIndex = segment.indexOf("=")
      if (separatorIndex <= 0) {
        return false
      }

      const key = segment.slice(0, separatorIndex).trim().toLowerCase()
      return !cookieAttributes.has(key)
    })
    .join("; ")
}
