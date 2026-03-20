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

const POLL_INTERVAL_MS = 3_000
const MAX_POLL_ATTEMPTS = 20
const REQUEST_TIMEOUT_MS = 15_000

export async function solveCloudflareChallenge(
  config: CloudflyerConfig,
  targetUrl: string,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ cfClearance: string } | null> {
  const taskId = await createTask(config, targetUrl, userAgent, fetchImpl)
  if (!taskId) return null

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await delay(POLL_INTERVAL_MS)
    const result = await getTaskResult(config, taskId, fetchImpl)
    if (!result) continue
    if (result.status === "completed") {
      const cfClearance =
        result.result?.success
          ? result.result.response?.cookies?.cf_clearance?.trim()
          : undefined
      return cfClearance ? { cfClearance } : null
    }
    if (result.status === "failed") return null
  }
  return null
}

async function createTask(
  config: CloudflyerConfig,
  targetUrl: string,
  userAgent: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const res = await postJson<CreateTaskResponse>(config, "createTask", {
    clientKey: config.clientKey,
    type: "CloudflareChallenge",
    url: targetUrl,
    userAgent,
  }, fetchImpl)
  return res?.taskId != null ? String(res.taskId) : null
}

async function getTaskResult(
  config: CloudflyerConfig,
  taskId: string,
  fetchImpl: typeof fetch,
): Promise<GetTaskResultResponse | null> {
  return postJson<GetTaskResultResponse>(config, "getTaskResult", {
    clientKey: config.clientKey,
    taskId,
  }, fetchImpl)
}

async function postJson<T>(
  config: CloudflyerConfig,
  pathname: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<T | null> {
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
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}
