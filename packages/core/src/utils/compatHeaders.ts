export const COMPAT_USER_ID_HEADER_NAMES = [
  "New-API-User",
  "Veloera-User",
  "voapi-user",
  "User-id",
  "Rix-Api-User",
  "neo-api-user",
] as const

export type CompatUserIdHeaderName =
  (typeof COMPAT_USER_ID_HEADER_NAMES)[number]

export function buildCompatUserIdHeaders(
  userId: number | string | null | undefined,
): Partial<Record<CompatUserIdHeaderName, string>> {
  if (!userId) {
    return {}
  }

  const value = String(userId).trim()
  if (!value) {
    return {}
  }

  const headers: Partial<Record<CompatUserIdHeaderName, string>> = {}
  for (const headerName of COMPAT_USER_ID_HEADER_NAMES) {
    headers[headerName] = value
  }

  return headers
}
