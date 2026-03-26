import { CheckinResultStatus, type CheckinAccountResult } from "@all-api-hub/core"

import type {
  BatchCheckinRunResult,
  CheckinOrchestrator,
} from "../checkin/orchestrator.js"

function isAuthInvalidFailure(result: CheckinAccountResult | undefined): boolean {
  return (
    result?.status === CheckinResultStatus.Failed &&
    result.code === "auth_invalid"
  )
}

export async function runSingleAccountCheckinWithAuthFallback(
  account: Pick<{ id: string; site_name: string }, "id" | "site_name">,
  orchestrator: Pick<CheckinOrchestrator, "runCheckinBatch" | "refreshSessions">,
): Promise<BatchCheckinRunResult> {
  const firstRun = await orchestrator.runCheckinBatch({
    accountId: account.id,
    mode: "manual",
  })
  const firstResult = firstRun.record.results[0]

  if (!isAuthInvalidFailure(firstResult)) {
    return firstRun
  }

  const refreshRun = await orchestrator.refreshSessions(account.id)
  const refreshResult = refreshRun.results[0]
  if (refreshResult?.status === "refreshed") {
    const retryRun = await orchestrator.runCheckinBatch({
      accountId: account.id,
      mode: "manual",
    })
    const retryResult = retryRun.record.results[0]
    if (retryResult?.status === CheckinResultStatus.Success) {
      return {
        ...retryRun,
        record: {
          ...retryRun.record,
          results: retryRun.record.results.map((entry) =>
            entry.accountId === account.id
              ? {
                  ...entry,
                  message: `${entry.message}；已自动刷新会话后重试成功`,
                }
              : entry,
          ),
        },
      }
    }

    if (retryResult?.message) {
      return {
        ...retryRun,
        record: {
          ...retryRun.record,
          results: retryRun.record.results.map((entry) =>
            entry.accountId === account.id
              ? {
                  ...entry,
                  message: `${entry.message}；已自动刷新会话后重试仍失败`,
                }
              : entry,
          ),
        },
      }
    }

    return retryRun
  }

  if (refreshResult?.message) {
    return {
      ...firstRun,
      record: {
        ...firstRun.record,
        results: firstRun.record.results.map((entry) =>
          entry.accountId === account.id
            ? {
                ...entry,
                message: `${entry.message}；已尝试自动刷新会话：${refreshResult.message}`,
              }
            : entry,
        ),
      },
    }
  }

  return firstRun
}
