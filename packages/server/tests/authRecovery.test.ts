import { describe, expect, it } from "vitest"

import { CheckinResultStatus, type CheckinAccountResult } from "@all-api-hub/core"

import { classifyCheckinResultForReauth } from "../src/checkin/authRecovery.js"

function makeResult(
  status: CheckinResultStatus,
  code?: string,
): CheckinAccountResult {
  const now = Date.now()
  return {
    accountId: "acc-1",
    siteName: "Demo",
    siteUrl: "https://demo.example.com",
    siteType: "new-api",
    status,
    code,
    message: "message",
    startedAt: now,
    completedAt: now,
  }
}

describe("classifyCheckinResultForReauth", () => {
  it("classifies auth invalid as retryable when profile exists", () => {
    expect(
      classifyCheckinResultForReauth(
        makeResult(CheckinResultStatus.Failed, "auth_invalid"),
        true,
      ),
    ).toEqual({
      type: "auth_invalid",
      retryable: true,
    })
  })

  it("classifies missing auth without profile as unsupported auto reauth", () => {
    expect(
      classifyCheckinResultForReauth(
        makeResult(CheckinResultStatus.Skipped, "missing_auth"),
        false,
      ),
    ).toEqual({
      type: "unsupported_auto_reauth",
      retryable: false,
    })
  })

  it("classifies manual action required directly", () => {
    expect(
      classifyCheckinResultForReauth(
        makeResult(CheckinResultStatus.ManualActionRequired, "turnstile_required"),
        true,
      ),
    ).toEqual({
      type: "manual_action_required",
      retryable: false,
    })
  })
})
