import { isAnyrouterSiteType, isNewApiFamilySiteType } from "@all-api-hub/core"

export interface SiteLoginProfile {
  hostname: string
  loginPath: string
  loginButtonSelectors: string[]
  successUrlPatterns: string[]
  tokenStorageKeys: string[]
  postLoginSelectors: string[]
}

export type SiteLoginProfileMap = Record<string, SiteLoginProfile>

const DEFAULT_TOKEN_STORAGE_KEYS = [
  "access_token",
  "token",
  "api_token",
  "authorization",
]

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase()
}

function normalizeProfile(
  hostname: string,
  candidate: unknown,
): SiteLoginProfile | null {
  if (!candidate || typeof candidate !== "object") {
    return null
  }

  const record = candidate as Record<string, unknown>
  const loginButtonSelectors = normalizeStringArray(record.loginButtonSelectors)
  if (loginButtonSelectors.length === 0) {
    return null
  }

  const loginPath =
    typeof record.loginPath === "string" && record.loginPath.trim()
      ? record.loginPath.trim()
      : "/"

  return {
    hostname: normalizeHostname(hostname),
    loginPath,
    loginButtonSelectors,
    successUrlPatterns: normalizeStringArray(record.successUrlPatterns),
    tokenStorageKeys:
      normalizeStringArray(record.tokenStorageKeys).length > 0
        ? normalizeStringArray(record.tokenStorageKeys)
        : [...DEFAULT_TOKEN_STORAGE_KEYS],
    postLoginSelectors: normalizeStringArray(record.postLoginSelectors),
  }
}

export function parseSiteLoginProfiles(
  rawValue: string | null | undefined,
): SiteLoginProfileMap {
  if (!rawValue?.trim()) {
    return {}
  }

  const parsed = JSON.parse(rawValue) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SITE_LOGIN_PROFILES_JSON 必须是以 hostname 为 key 的 JSON 对象")
  }

  const profiles: SiteLoginProfileMap = {}
  for (const [hostname, value] of Object.entries(parsed)) {
    const profile = normalizeProfile(hostname, value)
    if (profile) {
      profiles[profile.hostname] = profile
    }
  }

  return profiles
}

export function matchSiteLoginProfile(
  siteUrl: string,
  profiles: SiteLoginProfileMap,
): SiteLoginProfile | null {
  let hostname = ""
  try {
    hostname = new URL(siteUrl).hostname.toLowerCase()
  } catch {
    return null
  }

  if (profiles[hostname]) {
    return profiles[hostname]
  }

  for (const [pattern, profile] of Object.entries(profiles)) {
    if (!pattern.startsWith("*.")) {
      continue
    }

    const suffix = pattern.slice(1).toLowerCase()
    if (hostname.endsWith(suffix)) {
      return profile
    }
  }

  return null
}

const DEFAULT_NEW_API_LOGIN_PROFILE: SiteLoginProfile = {
  hostname: "__default_new_api__",
  loginPath: "/login",
  loginButtonSelectors: [
    "button:has-text('使用 LinuxDO 继续')",
    "button:has-text('LinuxDO')",
    "a:has-text('LinuxDO')",
    "button:has-text('Sign in')",
    "a:has-text('Sign in')",
  ],
  successUrlPatterns: ["/token", "/dashboard", "/panel", "/console"],
  tokenStorageKeys: ["access_token", "token", "api_token", "authorization"],
  postLoginSelectors: [],
}

export function matchOrDefaultSiteLoginProfile(
  siteUrl: string,
  profiles: SiteLoginProfileMap,
  siteType?: string,
): SiteLoginProfile | null {
  const explicit = matchSiteLoginProfile(siteUrl, profiles)
  if (explicit) return explicit
  if (siteType && (isNewApiFamilySiteType(siteType) || isAnyrouterSiteType(siteType))) {
    try {
      return {
        ...DEFAULT_NEW_API_LOGIN_PROFILE,
        hostname: new URL(siteUrl).hostname.toLowerCase(),
      }
    } catch {
      return null
    }
  }
  return null
}
