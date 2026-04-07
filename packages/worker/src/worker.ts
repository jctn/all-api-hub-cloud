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

type WorkerTaskResult = Awaited<
  ReturnType<LocalBrowserTaskProcessor["processTask"]>
>

type WorkerObservedPhase =
  | "local_prewarm_strategy_hit"
  | "local_flaresolverr_check_start"
  | "local_flaresolverr_check_passed"
  | "local_flaresolverr_check_failed"
  | "local_prewarm_succeeded"
  | "local_prewarm_failed"
  | "root_navigation"
  | "auto_login_started"
  | "auto_login_completed"
  | "final_code"

function appendLogFields(
  fields: Record<string, number | string | boolean | null | undefined>,
): string {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ")
}

function logTaskPhase(
  task: LocalWorkerTask,
  phase: WorkerObservedPhase,
  fields: Record<string, number | string | boolean | null | undefined> = {},
): void {
  const suffix = appendLogFields({
    taskId: task.id,
    kind: task.kind,
    scope: task.scope,
    phase,
    ...fields,
  })
  console.log(`[worker] observed ${suffix}`)
}

function logObservedProgress(task: LocalWorkerTask, message: string): void {
  if (message.includes("命中本地 FlareSolverr 预热策略")) {
    logTaskPhase(task, "local_prewarm_strategy_hit", { message })
    return
  }

  if (
    message.includes("[本地 FlareSolverr] POST ") ||
    message.includes("开始本地 FlareSolverr 预热")
  ) {
    logTaskPhase(task, "local_flaresolverr_check_start", { message })
    return
  }

  if (
    message.includes("[本地 FlareSolverr] 获取 ") ||
    message.includes("本地 FlareSolverr 注入 ")
  ) {
    logTaskPhase(task, "local_flaresolverr_check_passed", { message })
    if (message.includes("本地 FlareSolverr 注入 ")) {
      logTaskPhase(task, "local_prewarm_succeeded", { message })
    }
    return
  }

  if (
    message.includes("[本地 FlareSolverr] HTTP ") ||
    message.includes("[本地 FlareSolverr] 请求失败") ||
    message.includes("[本地 FlareSolverr] 状态异常")
  ) {
    logTaskPhase(task, "local_flaresolverr_check_failed", { message })
    return
  }

  if (
    message.includes("本地 FlareSolverr 预热失败") ||
    message.includes("本地 FlareSolverr 预热异常")
  ) {
    logTaskPhase(task, "local_prewarm_failed", { message })
    return
  }

  if (message.includes("先打开站点根页")) {
    logTaskPhase(task, "root_navigation", { message })
    return
  }

  if (
    message.includes("打开站点登录页") ||
    message.includes("完整 SSO 自动登录") ||
    message.includes("准备点击 Continue with LinuxDO")
  ) {
    logTaskPhase(task, "auto_login_started", { message })
    return
  }

  if (message.includes("目标站点已登录，开始提取会话信息")) {
    logTaskPhase(task, "auto_login_completed", { message })
  }
}

function extractFinalCodes(result: WorkerTaskResult): string[] {
  const entries = "record" in result ? result.record.results : result.results
  const codes = entries
    .map((entry) => ("code" in entry ? entry.code : undefined))
    .filter((code): code is string => typeof code === "string" && code.length > 0)
  return [...new Set(codes)]
}

function summarizeStatuses(result: WorkerTaskResult): string {
  const entries = "record" in result ? result.record.results : result.results
  const counts = new Map<string, number>()

  for (const entry of entries) {
    const next = (counts.get(entry.status) ?? 0) + 1
    counts.set(entry.status, next)
  }

  return [...counts.entries()]
    .map(([status, count]) => `${status}:${count}`)
    .join(",")
}

export async function startLocalBrowserWorker(
  config: WorkerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  console.log(
    `[worker] start workerId=${config.workerId} server=${config.serverUrl} runAnytimeDebugRootOnlyPause=${config.runAnytimeDebugRootOnlyPause}`,
  )
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

    console.log(
      `[worker] claimed task id=${claimedTask.id} kind=${claimedTask.kind} scope=${claimedTask.scope}`,
    )

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
        console.log(`[worker] progress task=${params.task.id} ${message}`)
        logObservedProgress(params.task, message)
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

    const finalCodes = extractFinalCodes(result)
    logTaskPhase(params.task, "final_code", {
      finalCode: finalCodes.length > 0 ? finalCodes.join(",") : "none",
      statusSummary: summarizeStatuses(result) || "none",
    })
    console.log(`[worker] finish task=${params.task.id} status=succeeded`)
    await params.apiClient.finish({
      taskId: params.task.id,
      workerId: params.config.workerId,
      status: "succeeded",
      resultJson: result,
    })
  } catch (error) {
    logTaskPhase(params.task, "final_code", {
      finalCode: "worker_execution_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    console.error(
      `[worker] finish task=${params.task.id} status=failed`,
      error,
    )
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
