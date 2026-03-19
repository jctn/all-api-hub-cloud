import { describe, expect, it } from "vitest"

import {
  CheckinResultStatus,
  summarizeCheckinResults,
  type CheckinAccountResult,
} from "../src/index.js"

describe("summarizeCheckinResults", () => {
  it("aggregates all result categories", () => {
    const now = Date.now()
    const results: CheckinAccountResult[] = [
      {
        accountId: "a1",
        siteName: "One",
        siteUrl: "https://one.example.com",
        siteType: "new-api",
        status: CheckinResultStatus.Success,
        message: "ok",
        startedAt: now,
        completedAt: now,
      },
      {
        accountId: "a2",
        siteName: "Two",
        siteUrl: "https://two.example.com",
        siteType: "new-api",
        status: CheckinResultStatus.AlreadyChecked,
        message: "already",
        startedAt: now,
        completedAt: now,
      },
      {
        accountId: "a3",
        siteName: "Three",
        siteUrl: "https://three.example.com",
        siteType: "new-api",
        status: CheckinResultStatus.Failed,
        message: "failed",
        startedAt: now,
        completedAt: now,
      },
      {
        accountId: "a4",
        siteName: "Four",
        siteUrl: "https://four.example.com",
        siteType: "new-api",
        status: CheckinResultStatus.ManualActionRequired,
        message: "manual",
        startedAt: now,
        completedAt: now,
      },
      {
        accountId: "a5",
        siteName: "Five",
        siteUrl: "https://five.example.com",
        siteType: "new-api",
        status: CheckinResultStatus.Skipped,
        message: "skip",
        startedAt: now,
        completedAt: now,
      },
    ]

    expect(summarizeCheckinResults(results)).toEqual({
      total: 5,
      success: 1,
      alreadyChecked: 1,
      failed: 1,
      manualActionRequired: 1,
      skipped: 1,
    })
  })
})
