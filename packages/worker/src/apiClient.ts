import type { LocalWorkerTask } from "@all-api-hub/server"

interface JsonResponse<T> {
  ok: boolean
  task?: T | null
  error?: string
}

function normalizeBaseUrl(serverUrl: string): string {
  return serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl
}

export class LocalWorkerApiClient {
  private readonly baseUrl: string

  constructor(
    serverUrl: string,
    private readonly workerToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(serverUrl)
  }

  async claimTask(workerId: string): Promise<LocalWorkerTask | null> {
    const payload = await this.post<JsonResponse<LocalWorkerTask>>(
      "/internal/worker/tasks/claim",
      { workerId },
    )
    return payload.task ?? null
  }

  async heartbeat(taskId: string, workerId: string): Promise<LocalWorkerTask | null> {
    const payload = await this.post<JsonResponse<LocalWorkerTask>>(
      `/internal/worker/tasks/${taskId}/heartbeat`,
      {
        workerId,
        heartbeatAt: Date.now(),
      },
    )
    return payload.task ?? null
  }

  async progress(params: {
    taskId: string
    workerId: string
    status: "running" | "waiting_manual"
    progressText: string
  }): Promise<LocalWorkerTask | null> {
    const payload = await this.post<JsonResponse<LocalWorkerTask>>(
      `/internal/worker/tasks/${params.taskId}/progress`,
      {
        workerId: params.workerId,
        status: params.status,
        progressText: params.progressText,
        heartbeatAt: Date.now(),
      },
    )
    return payload.task ?? null
  }

  async finish(params: {
    taskId: string
    workerId: string
    status: "succeeded" | "failed"
    resultJson?: unknown
    errorCode?: string
    errorMessage?: string
  }): Promise<LocalWorkerTask | null> {
    const payload = await this.post<JsonResponse<LocalWorkerTask>>(
      `/internal/worker/tasks/${params.taskId}/finish`,
      {
        workerId: params.workerId,
        status: params.status,
        finishedAt: Date.now(),
        resultJson: params.resultJson,
        errorCode: params.errorCode,
        errorMessage: params.errorMessage,
      },
    )
    return payload.task ?? null
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.workerToken}`,
      },
      body: JSON.stringify(body),
    })

    const payload = (await response.json()) as T & { ok?: boolean; error?: string }
    if (!response.ok) {
      throw new Error(payload.error || `Worker API request failed: ${response.status}`)
    }

    return payload
  }
}
