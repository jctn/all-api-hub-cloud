import type { SiteAccount } from "@all-api-hub/core"

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

export function matchesAccountSearch(
  account: SiteAccount,
  query: string,
): boolean {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) {
    return true
  }

  const haystacks = [
    account.site_name,
    account.site_url,
    account.site_type,
    account.account_info.username,
    account.notes,
    account.id,
  ]

  return haystacks.some((value) =>
    normalizeSearchText(String(value ?? "")).includes(normalizedQuery),
  )
}

export function filterAccountsByQuery(
  accounts: SiteAccount[],
  query: string,
): SiteAccount[] {
  return accounts.filter((account) => matchesAccountSearch(account, query))
}
