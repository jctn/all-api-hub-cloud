const NEW_API_FAMILY = new Set([
  "new-api",
  "one-api",
  "one-hub",
  "done-hub",
  "voapi",
  "super-api",
  "rix-api",
  "neo-api",
])

const ANYROUTER_FAMILY = new Set(["anyrouter"])
const WONG_FAMILY = new Set(["wong-gongyi"])

const SUPPORTED_CHECKIN_SITE_TYPES = new Set([
  ...NEW_API_FAMILY,
  ...ANYROUTER_FAMILY,
  ...WONG_FAMILY,
])

const CHECKIN_PATHS = new Map<string, string>([
  ["new-api", "/console/personal"],
  ["one-api", "/console/personal"],
  ["one-hub", "/console/personal"],
  ["done-hub", "/console/personal"],
  ["voapi", "/console/personal"],
  ["super-api", "/console/personal"],
  ["rix-api", "/panel"],
  ["neo-api", "/console/personal"],
  ["anyrouter", "/console/topup"],
  ["wong-gongyi", "/console/topup"],
])

export function normalizeSiteType(siteType: string | null | undefined): string {
  return String(siteType ?? "")
    .trim()
    .toLowerCase()
}

export function isNewApiFamilySiteType(
  siteType: string | null | undefined,
): boolean {
  return NEW_API_FAMILY.has(normalizeSiteType(siteType))
}

export function isAnyrouterSiteType(
  siteType: string | null | undefined,
): boolean {
  return ANYROUTER_FAMILY.has(normalizeSiteType(siteType))
}

export function isWongSiteType(
  siteType: string | null | undefined,
): boolean {
  return WONG_FAMILY.has(normalizeSiteType(siteType))
}

export function isSupportedCheckinSiteType(
  siteType: string | null | undefined,
): boolean {
  return SUPPORTED_CHECKIN_SITE_TYPES.has(normalizeSiteType(siteType))
}

export function resolveCheckInPath(siteType: string | null | undefined): string {
  return CHECKIN_PATHS.get(normalizeSiteType(siteType)) ?? "/console/personal"
}
