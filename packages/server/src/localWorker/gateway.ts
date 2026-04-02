import type { SiteAccount } from "@all-api-hub/core"

import type {
  BatchCheckinRunOptions,
  BatchCheckinRunResult,
  SessionRefreshRunOptions,
  SessionRefreshRunResult,
} from "../checkin/orchestrator.js"
import {
  isActiveLocalWorkerTask,
  type LocalWorkerTask,
  type LocalWorkerTaskStore,
} from "./taskStore.js"
import type { LocalWorkerExecutionGateway } from "./hybridOrchestrator.js"

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

export class PollingLocalWorkerExecutionGateway
  implements LocalWorkerExecutionGateway
{
  constructor(private readonly params: {
    taskStore: LocalWorkerTaskStore
    pollIntervalMs?: number
    claimTimeoutMs?: number
    heartbeatTimeoutMs?: number
  }) {}

  async runCheckinTask(
    accounts: SiteAccount[],
    options: BatchCheckinRunOptions,
  ): Promise<BatchCheckinRunResult> {
    const task = await this.params.taskStore.enqueue({
      kind: "checkin",
      scope: options.accountId ? "single" : "batch",
      requestedBy: "server",
      verbose: false,
      payload: {
        accountId: options.accountId,
        mode: options.mode,
        accountIds: accounts.map((account) => account.id),
        accounts: accounts.map((account) => ({
          id: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          rawAccount: account,
        })),
      },
    })
    await options.onProgress?.(`本地浏览器任务已入队：${task.id}`)
    return this.waitForTaskResult<BatchCheckinRunResult>(task.id, options.onProgress)
  }

  async runRefreshTask(
    accounts: SiteAccount[],
    options: SessionRefreshRunOptions = {},
  ): Promise<SessionRefreshRunResult> {
    const task = await this.params.taskStore.enqueue({
      kind: "auth_refresh",
      scope: accounts.length === 1 ? "single" : "batch",
      requestedBy: "server",
      verbose: false,
      payload: {
        accountIds: accounts.map((account) => account.id),
        accounts: accounts.map((account) => ({
          id: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          rawAccount: account,
        })),
      },
    })
    await options.onProgress?.(`本地浏览器任务已入队：${task.id}`)
    return this.waitForTaskResult<SessionRefreshRunResult>(task.id, options.onProgress)
  }

  async getActiveTask(): Promise<LocalWorkerTask | null> {
    const tasks = await this.params.taskStore.listActive()
    return tasks[0] ?? null
  }

  private async waitForTaskResult<TResult>(
    taskId: string,
    onProgress?: (message: string) => Promise<void> | void,
  ): Promise<TResult> {
    const pollIntervalMs = this.params.pollIntervalMs ?? 1_000
    const claimTimeoutMs = this.params.claimTimeoutMs ?? 45_000
    const heartbeatTimeoutMs = this.params.heartbeatTimeoutMs ?? 90_000
    let lastProgressText: string | undefined
    let lastStatus: LocalWorkerTask["status"] | undefined

    for (;;) {
      await this.params.taskStore.expireStaleTasks({
        claimTimeoutBefore: Date.now() - claimTimeoutMs,
        heartbeatTimeoutBefore: Date.now() - heartbeatTimeoutMs,
      })

      const task = await this.params.taskStore.getById(taskId)
      if (!task) {
        throw new Error(`Local worker task not found: ${taskId}`)
      }

      if (task.progressText && task.progressText !== lastProgressText) {
        lastProgressText = task.progressText
        await onProgress?.(task.progressText)
      } else if (task.status !== lastStatus && isActiveLocalWorkerTask(task)) {
        lastStatus = task.status
        await onProgress?.(`本地浏览器任务状态：${task.status}`)
      }

      if (task.status === "succeeded") {
        return task.resultJson as TResult
      }

      if (
        task.status === "failed" ||
        task.status === "expired"
      ) {
        throw new Error(
          task.errorMessage || task.errorCode || `Local worker task failed: ${task.status}`,
        )
      }

      await delay(pollIntervalMs)
    }
  }
}
