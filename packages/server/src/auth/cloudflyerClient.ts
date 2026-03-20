import { setTimeout as delay } from "node:timers/promises"

import type { CloudflyerConfig } from "../config.js"

interface CreateTaskResponse {
  taskId?: string | number
}

interface GetTaskResultResponse {
  status?: string
  result?: {
    success?: boolean
    response?: {
      cookies?: { cf_clearance?: string }
      headers?: Record<string, string>
    }
  }
}

export interface CloudflyerSolveResult {
  cfClearance: string
}

const POLL_INTERVAL_MS = 3_000
const MAX_POLL_ATTEMPTS = 20
const REQUEST_TIMEOUT_MS = 15_000

export async function solveCloudflareChallenge(
  config: CloudflyerConfig,
  targetUrl: string,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
  onLog?: (msg: string) => void,
): Promise<CloudflyerSolveResult | null> {
  const log = onLog ?? (() => {})

  log(`createTask → ${config.serviceUrl} url=${targetUrl}`)
  const { data: taskRes, error: createErr } = await postJson<CreateTaskResponse>(
    config, "createTask",
    { clientKey: config.clientKey, type: "CloudflareChallenge", url: targetUrl, userAgent },
    fetchImpl,
  )
  if (createErr) {
    log(`createTask 失败: ${createErr}`)
    return null
  }
  const taskId = taskRes?.taskId != null ? String(taskRes.taskId) : null
  if (!taskId) {
    log(`createTask 未返回 taskId，响应: ${JSON.stringify(taskRes)}`)
    return null
  }
  log(`taskId=${taskId}，开始轮询`)

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await delay(POLL_INTERVAL_MS)
    const { data: result, error: pollErr } = await postJson<GetTaskResultResponse>(
      config, "getTaskResult",
      { clientKey: config.clientKey, taskId },
      fetchImpl,
    )
    if (pollErr) {
      log(`getTaskResult #${i + 1} 失败: ${pollErr}`)
      continue
    }
    if (!result) continue

    log(`getTaskResult #${i + 1} status=${result.status}`)

    if (result.status === "completed") {
      const cfClearance =
        result.result?.success
          ? result.result.response?.cookies?.cf_clearance?.trim()
          : undefined
      if (cfClearance) {
        log(`获取 cf_clearance 成功 (${cfClearance.slice(0, 16)}...)`)
        return { cfClearance }
      }
      log(`任务完成但无 cf_clearance，响应: ${JSON.stringify(result.result)}`)
      return null
    }
    if (result.status === "failed") {
      log(`任务失败，响应: ${JSON.stringify(result.result)}`)
      return null
    }
  }
  log(`轮询超时 (${MAX_POLL_ATTEMPTS} 次)`)
  return null
}

interface PostJsonResult<T> {
  data: T | null
  error: string | null
}

async function postJson<T>(
  config: CloudflyerConfig,
  pathname: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<PostJsonResult<T>> {
  try {
    const base = config.serviceUrl.endsWith("/")
      ? config.serviceUrl
      : `${config.serviceUrl}/`
    const res = await fetchImpl(new URL(pathname, base), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      return { data: null, error: `HTTP ${res.status} ${text.slice(0, 200)}` }
    }
    return { data: (await res.json()) as T, error: null }
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : String(err) }
  }
}
