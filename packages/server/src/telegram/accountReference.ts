import type { SiteAccount } from "@all-api-hub/core"

export type AccountReferenceResolution =
  | { status: "resolved"; account: SiteAccount; matchedBy: "id" | "site_name" }
  | { status: "ambiguous"; input: string; candidates: SiteAccount[] }
  | { status: "missing"; input: string }

function normalizeAccountReference(input: string): string {
  const trimmed = input.trim()
  const unquoted =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed
  return unquoted.toLowerCase()
}

export function resolveAccountReference(
  accounts: SiteAccount[],
  input: string,
): AccountReferenceResolution {
  const normalized = normalizeAccountReference(input)
  if (!normalized) {
    return { status: "missing", input: input.trim() }
  }

  const idMatch = accounts.find((account) => account.id.trim().toLowerCase() === normalized)
  if (idMatch) {
    return {
      status: "resolved",
      account: idMatch,
      matchedBy: "id",
    }
  }

  const siteNameMatches = accounts.filter(
    (account) => account.site_name.trim().toLowerCase() === normalized,
  )
  if (siteNameMatches.length === 1) {
    return {
      status: "resolved",
      account: siteNameMatches[0],
      matchedBy: "site_name",
    }
  }

  if (siteNameMatches.length > 1) {
    return {
      status: "ambiguous",
      input: input.trim(),
      candidates: siteNameMatches,
    }
  }

  return {
    status: "missing",
    input: input.trim(),
  }
}

export function formatAccountReferenceCandidates(accounts: SiteAccount[]): string {
  return accounts
    .map((account) => `- ${account.site_name} (${account.id})`)
    .join("\n")
}
