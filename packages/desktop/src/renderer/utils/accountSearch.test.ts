import { describe, expect, it } from "vitest"

import type { SiteAccount } from "@all-api-hub/core"

import { filterAccountsByQuery, matchesAccountSearch } from "./accountSearch"

const baseAccount: SiteAccount = {
  id: "acc-1",
  site_name: "WONG公益站",
  site_url: "https://wong.example.com",
  site_type: "wong-gongyi",
  health: { status: "healthy" },
  exchange_rate: 7.2,
  account_info: {
    id: 1,
    access_token: "token",
    username: "alice",
    quota: 0,
    today_prompt_tokens: 0,
    today_completion_tokens: 0,
    today_quota_consumption: 0,
    today_requests_count: 0,
    today_income: 0,
  },
  last_sync_time: 0,
  updated_at: 0,
  created_at: 0,
  notes: "公益站主账号",
  tagIds: [],
  disabled: false,
  excludeFromTotalBalance: false,
  authType: "access_token",
  checkIn: {
    enableDetection: true,
    autoCheckInEnabled: true,
  },
}

describe("matchesAccountSearch", () => {
  it("matches site name, url, site type, username, notes, and id", () => {
    expect(matchesAccountSearch(baseAccount, "wong")).toBe(true)
    expect(matchesAccountSearch(baseAccount, "example.com")).toBe(true)
    expect(matchesAccountSearch(baseAccount, "gongyi")).toBe(true)
    expect(matchesAccountSearch(baseAccount, "alice")).toBe(true)
    expect(matchesAccountSearch(baseAccount, "主账号")).toBe(true)
    expect(matchesAccountSearch(baseAccount, "acc-1")).toBe(true)
  })

  it("returns false when no searchable field matches", () => {
    expect(matchesAccountSearch(baseAccount, "not-found")).toBe(false)
  })
})

describe("filterAccountsByQuery", () => {
  it("returns all accounts for an empty query", () => {
    expect(filterAccountsByQuery([baseAccount], "  ")).toHaveLength(1)
  })

  it("returns only matching accounts for a non-empty query", () => {
    const filtered = filterAccountsByQuery(
      [
        baseAccount,
        {
          ...baseAccount,
          id: "acc-2",
          site_name: "AnyRouter",
          site_url: "https://anyrouter.example.com",
          site_type: "anyrouter",
          account_info: {
            ...baseAccount.account_info,
            username: "bob",
          },
          notes: "备用账号",
        },
      ],
      "alice",
    )

    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.id).toBe("acc-1")
  })
})
