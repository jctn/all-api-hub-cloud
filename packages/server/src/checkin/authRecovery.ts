import { CheckinResultStatus, type CheckinAccountResult } from "@all-api-hub/core"

export type CheckinAuthRecoveryType =
  | "auth_invalid"
  | "missing_auth"
  | "html_interstitial"
  | "manual_action_required"
  | "unsupported_auto_reauth"
  | "not_auth_related"

export interface CheckinAuthRecoveryClassification {
  type: CheckinAuthRecoveryType
  retryable: boolean
}

export function classifyCheckinResultForReauth(
  result: CheckinAccountResult,
  hasLoginProfile: boolean,
): CheckinAuthRecoveryClassification {
  if (result.status === CheckinResultStatus.ManualActionRequired) {
    return { type: "manual_action_required", retryable: false }
  }

  if (result.status === CheckinResultStatus.Failed && result.code === "auth_invalid") {
    return hasLoginProfile
      ? { type: "auth_invalid", retryable: true }
      : { type: "unsupported_auto_reauth", retryable: false }
  }

  if (
    result.status === CheckinResultStatus.Failed &&
    result.code === "html_interstitial"
  ) {
    return hasLoginProfile
      ? { type: "html_interstitial", retryable: true }
      : { type: "not_auth_related", retryable: false }
  }

  if (
    result.status === CheckinResultStatus.Skipped &&
    (result.code === "missing_auth" || result.code === "missing_cookie_auth")
  ) {
    return hasLoginProfile
      ? { type: "missing_auth", retryable: true }
      : { type: "unsupported_auto_reauth", retryable: false }
  }

  return { type: "not_auth_related", retryable: false }
}
