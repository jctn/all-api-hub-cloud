import type { LocalWorkerTask } from "@all-api-hub/server"
import { LocalWorkerApiClient } from "./apiClient.js"
import type { WorkerConfig } from "./config.js"
import { LocalBrowserTaskProcessor } from "./processor.js"
import { initializeWorkerRuntime } from "./runtime.js"

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs))
}

function shouldWaitForManualAction(message: string): boolean {
  return /人工|手动|挑战|cloudflare|turnstile/iu.test(message)
}

export async function startLocalBrowserWorker(
  config: WorkerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const runtime = await initializeWorkerRuntime({
    privateDataDirectory: config.privateDataDirectory,
    dataDirectory: config.dataDirectory,
  })
  const apiClient = new LocalWorkerApiClient(
    config.serverUrl,
    config.workerToken,
    fetchImpl,
  )
  const processor = new LocalBrowserTaskProcessor(config, runtime, fetchImpl)

  for (;;) {
    const claimedTask = await apiClient
      .claimTask(config.workerId)
      .catch((error) => {
        console.error("[worker] claim task failed", error)
        return null
      })

    if (!claimedTask) {
      await delay(config.pollIntervalMs)
      continue
    }

    await executeClaimedTask({
      task: claimedTask,
      config,
      apiClient,
      processor,
    }).catch((error) => {
      console.error("[worker] execute task failed", error)
    })
  }
}

async function executeClaimedTask(params: {
  task: LocalWorkerTask
  config: WorkerConfig
  apiClient: LocalWorkerApiClient
  processor: LocalBrowserTaskProcessor
}): Promise<void> {
  const heartbeatTimer = setInterval(() => {
    void params.apiClient
      .heartbeat(params.task.id, params.config.workerId)
      .catch((error) => {
        console.error("[worker] heartbeat failed", error)
      })
  }, params.config.heartbeatIntervalMs)

  try {
    await params.apiClient.progress({
      taskId: params.task.id,
      workerId: params.config.workerId,
      status: "running",
      progressText: `开始执行本地浏览器任务：${params.task.kind}`,
    })

    const result = await params.processor.processTask(
      params.task,
      async (message) => {
        await params.apiClient.progress({
          taskId: params.task.id,
          workerId: params.config.workerId,
          status: shouldWaitForManualAction(message)
            ? "waiting_manual"
            : "running",
          progressText: message,
        })
      },
    )

    await params.apiClient.finish({
      taskId: params.task.id,
      workerId: params.config.workerId,
      status: "succeeded",
      resultJson: result,
    })
  } catch (error) {
    await params.apiClient.finish({
      taskId: params.task.id,
      workerId: params.config.workerId,
      status: "failed",
      errorCode: "worker_execution_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearInterval(heartbeatTimer)
  }
}
