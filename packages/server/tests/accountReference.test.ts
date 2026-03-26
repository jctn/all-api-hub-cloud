import { describe, expect, it } from "vitest"

import { AuthType, HealthState, type SiteAccount } from "@all-api-hub/core"

import {
  formatAccountReferenceCandidates,
  resolveAccountReference,
} from "../src/telegram/accountReference.js"

const baseAccount: SiteAccount = {
  id: "account-1",
  site_name: "Demo",
  site_url: "https://demo.example.com",
  health: { status: HealthState.Healthy },
  site_type: "new-api",
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
  notes: "",
  tagIds: [],
  disabled: false,
  excludeFromTotalBalance: false,
  authType: AuthType.AccessToken,
  checkIn: {
    enableDetection: true,
    autoCheckInEnabled: true,
  },
}

describe("resolveAccountReference", () => {
  it("resolves an exact account id first", () => {
    const result = resolveAccountReference([baseAccount], "account-1")

    expect(result).toMatchObject({
      status: "resolved",
      matchedBy: "id",
    })
  })

  it("resolves site names case-insensitively", () => {
    const result = resolveAccountReference(
      [
        {
          ...baseAccount,
          id: "account-ouu",
          site_name: "OuuAPI",
        },
      ],
      "ouuapi",
    )

    expect(result).toMatchObject({
      status: "resolved",
      matchedBy: "site_name",
      account: {
        id: "account-ouu",
      },
    })
  })

  it("reports ambiguous site names with candidate ids", () => {
    const result = resolveAccountReference(
      [
        {
          ...baseAccount,
          id: "account-ouu-1",
          site_name: "OuuAPI",
          account_info: {
            ...baseAccount.account_info,
            username: "alice",
          },
        },
        {
          ...baseAccount,
          id: "account-ouu-2",
          site_name: "OuuAPI",
          account_info: {
            ...baseAccount.account_info,
            username: "bob",
          },
        },
      ],
      "OuuAPI",
    )

    expect(result.status).toBe("ambiguous")
    if (result.status !== "ambiguous") {
      throw new Error("expected ambiguous result")
    }
    expect(formatAccountReferenceCandidates(result.candidates)).toContain("account-ouu-1")
    expect(formatAccountReferenceCandidates(result.candidates)).toContain("account-ouu-2")
  })

  it("returns missing when neither id nor site name matches", () => {
    const result = resolveAccountReference([baseAccount], "missing-site")

    expect(result).toMatchObject({
      status: "missing",
      input: "missing-site",
    })
  })
})
