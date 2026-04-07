import { isAnyrouterSiteType, isNewApiFamilySiteType } from "@all-api-hub/core"

export type SiteExecutionMode = "cloud" | "local-browser"
export type LocalBrowserCloudflareMode = "off" | "prewarm"
export type LocalBrowserFlareSolverrScope = "root" | "login" | "checkin"
export type LocalBrowserManualFallbackPolicy = "disabled" | "last-resort"

export interface LocalBrowserProfile {
  cloudflareMode: LocalBrowserCloudflareMode
  flareSolverrScope: LocalBrowserFlareSolverrScope
  flareSolverrTargetPath?: string
  allowRetryAfterBrowserChallenge: boolean
  openRootBeforeCheckin: boolean
  manualFallbackPolicy: LocalBrowserManualFallbackPolicy
}

export interface SiteLoginProfile {
  hostname: string
  loginPath: string
  loginButtonSelectors: string[]
  successUrlPatterns: string[]
  tokenStorageKeys: string[]
  postLoginSelectors: string[]
  executionMode?: SiteExecutionMode
  localBrowser?: LocalBrowserProfile
}

export type SiteLoginProfileMap = Record<string, SiteLoginProfile>

const DEFAULT_TOKEN_STORAGE_KEYS = [
  "access_token",
  "token",
  "api_token",
  "authorization",
]
const DEFAULT_LOCAL_BROWSER_CLOUDFLARE_MODE: LocalBrowserCloudflareMode = "off"
const DEFAULT_LOCAL_BROWSER_FLARESOLVERR_SCOPE: LocalBrowserFlareSolverrScope = "login"
const DEFAULT_LOCAL_BROWSER_MANUAL_FALLBACK_POLICY: LocalBrowserManualFallbackPolicy =
  "last-resort"

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

function normalizeExecutionMode(value: unknown): SiteExecutionMode {
  return value === "local-browser" ? "local-browser" : "cloud"
}

function normalizeLocalBrowserCloudflareMode(value: unknown): LocalBrowserCloudflareMode {
  return value === "prewarm" ? "prewarm" : DEFAULT_LOCAL_BROWSER_CLOUDFLARE_MODE
}

function normalizeLocalBrowserFlareSolverrScope(
  value: unknown,
): LocalBrowserFlareSolverrScope {
  return value === "root" || value === "checkin"
    ? value
    : DEFAULT_LOCAL_BROWSER_FLARESOLVERR_SCOPE
}

function normalizeLocalBrowserManualFallbackPolicy(
  value: unknown,
): LocalBrowserManualFallbackPolicy {
  return value === "disabled" ? "disabled" : DEFAULT_LOCAL_BROWSER_MANUAL_FALLBACK_POLICY
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const normalized = value.trim()
  return normalized || undefined
}

function normalizeLocalBrowserProfile(value: unknown): LocalBrowserProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const record = value as Record<string, unknown>
  return {
    cloudflareMode: normalizeLocalBrowserCloudflareMode(record.cloudflareMode),
    flareSolverrScope: normalizeLocalBrowserFlareSolverrScope(record.flareSolverrScope),
    flareSolverrTargetPath: normalizeOptionalString(record.flareSolverrTargetPath),
    allowRetryAfterBrowserChallenge: record.allowRetryAfterBrowserChallenge === true,
    openRootBeforeCheckin: record.openRootBeforeCheckin === true,
    manualFallbackPolicy: normalizeLocalBrowserManualFallbackPolicy(
      record.manualFallbackPolicy,
    ),
  }
}

function normalizeProfile(
  hostname: string,
  value: unknown,
): SiteLoginProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const record = value as Record<string, unknown>
  const loginPath =
    typeof record.loginPath === "string" && record.loginPath.trim()
      ? record.loginPath.trim()
      : "/"
  const loginButtonSelectors = normalizeStringArray(record.loginButtonSelectors)
  if (loginButtonSelectors.length === 0) {
    return null
  }
  const localBrowser = normalizeLocalBrowserProfile(record.localBrowser)

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
    executionMode: normalizeExecutionMode(record.executionMode),
    ...(localBrowser ? { localBrowser } : {}),
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
  executionMode: "cloud",
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

export function requiresLocalBrowserExecution(
  profile: Pick<SiteLoginProfile, "executionMode"> | null | undefined,
): boolean {
  return profile?.executionMode === "local-browser"
}
