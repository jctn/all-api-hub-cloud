import crypto from "node:crypto"

import type { SiteAccount } from "@all-api-hub/core"

export type LocalWorkerTaskKind = "checkin" | "auth_refresh"

export type LocalWorkerTaskScope = "single" | "batch"

export type LocalWorkerTaskStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_manual"
  | "succeeded"
  | "failed"
  | "expired"

export interface LocalWorkerTaskAccountSnapshot {
  id: string
  siteName: string
  siteUrl: string
  siteType: string
  rawAccount?: SiteAccount
}

export interface LocalWorkerTaskPayload {
  requestId?: string
  accountIds: string[]
  accounts: LocalWorkerTaskAccountSnapshot[]
  accountId?: string
  mode?: "scheduled" | "manual"
}

export interface LocalWorkerTask {
  id: string
  kind: LocalWorkerTaskKind
  scope: LocalWorkerTaskScope
  accountIds: string[]
  payload: LocalWorkerTaskPayload
  status: LocalWorkerTaskStatus
  requestedBy: string
  chatId: string | null
  verbose: boolean
  workerId?: string
  progressText?: string
  heartbeatAt?: number
  requestedAt: number
  claimedAt?: number
  startedAt?: number
  finishedAt?: number
  resultJson?: unknown
  errorCode?: string
  errorMessage?: string
}

export interface CreateLocalWorkerTaskInput {
  kind: LocalWorkerTaskKind
  scope: LocalWorkerTaskScope
  requestedBy: string
  chatId?: string | null
  verbose: boolean
  payload: LocalWorkerTaskPayload
  requestedAt?: number
}

export interface UpdateLocalWorkerTaskProgressInput {
  status?: Extract<LocalWorkerTaskStatus, "running" | "waiting_manual">
  progressText?: string
  heartbeatAt?: number
}

export interface FinishLocalWorkerTaskInput {
  status: Extract<LocalWorkerTaskStatus, "succeeded" | "failed" | "expired">
  finishedAt?: number
  resultJson?: unknown
  errorCode?: string
  errorMessage?: string
}

export interface ExpireLocalWorkerTasksInput {
  claimTimeoutBefore: number
  heartbeatTimeoutBefore: number
  finishedAt?: number
}

export interface LocalWorkerTaskStore {
  enqueue(input: CreateLocalWorkerTaskInput): Promise<LocalWorkerTask>
  claimNext(workerId: string, claimedAt?: number): Promise<LocalWorkerTask | null>
  heartbeat(
    taskId: string,
    workerId: string,
    heartbeatAt?: number,
  ): Promise<LocalWorkerTask | null>
  updateProgress(
    taskId: string,
    workerId: string,
    input: UpdateLocalWorkerTaskProgressInput,
  ): Promise<LocalWorkerTask | null>
  finish(
    taskId: string,
    workerId: string,
    input: FinishLocalWorkerTaskInput,
  ): Promise<LocalWorkerTask | null>
  expireStaleTasks(input: ExpireLocalWorkerTasksInput): Promise<LocalWorkerTask[]>
  getById(taskId: string): Promise<LocalWorkerTask | null>
  listActive(): Promise<LocalWorkerTask[]>
}

function cloneTask(task: LocalWorkerTask): LocalWorkerTask {
  return JSON.parse(JSON.stringify(task)) as LocalWorkerTask
}

function isActiveTaskStatus(status: LocalWorkerTaskStatus): boolean {
  return (
    status === "claimed" ||
    status === "running" ||
    status === "waiting_manual"
  )
}

function ensureWorkerOwnership(task: LocalWorkerTask, workerId: string): void {
  if (task.workerId && task.workerId !== workerId) {
    throw new Error("Task worker mismatch")
  }
}

export class InMemoryLocalWorkerTaskStore implements LocalWorkerTaskStore {
  private readonly tasks = new Map<string, LocalWorkerTask>()

  async enqueue(input: CreateLocalWorkerTaskInput): Promise<LocalWorkerTask> {
    const requestedAt = input.requestedAt ?? Date.now()
    const task: LocalWorkerTask = {
      id: crypto.randomUUID(),
      kind: input.kind,
      scope: input.scope,
      accountIds: [...input.payload.accountIds],
      payload: {
        ...input.payload,
        accountIds: [...input.payload.accountIds],
        accounts: input.payload.accounts.map((account) => ({ ...account })),
      },
      status: "queued",
      requestedBy: input.requestedBy,
      chatId: input.chatId ?? null,
      verbose: input.verbose,
      requestedAt,
    }
    this.tasks.set(task.id, task)
    return cloneTask(task)
  }

  async claimNext(
    workerId: string,
    claimedAt = Date.now(),
  ): Promise<LocalWorkerTask | null> {
    const hasActiveTask = [...this.tasks.values()].some((task) =>
      isActiveTaskStatus(task.status),
    )
    if (hasActiveTask) {
      return null
    }

    const queuedTask = [...this.tasks.values()]
      .filter((task) => task.status === "queued")
      .sort((left, right) => left.requestedAt - right.requestedAt)[0]
    if (!queuedTask) {
      return null
    }

    queuedTask.status = "claimed"
    queuedTask.workerId = workerId
    queuedTask.claimedAt = claimedAt
    queuedTask.heartbeatAt = claimedAt
    return cloneTask(queuedTask)
  }

  async heartbeat(
    taskId: string,
    workerId: string,
    heartbeatAt = Date.now(),
  ): Promise<LocalWorkerTask | null> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return null
    }

    ensureWorkerOwnership(task, workerId)
    task.workerId = workerId
    task.heartbeatAt = heartbeatAt
    if (task.status === "claimed") {
      task.status = "running"
      task.startedAt ??= heartbeatAt
    }
    return cloneTask(task)
  }

  async updateProgress(
    taskId: string,
    workerId: string,
    input: UpdateLocalWorkerTaskProgressInput,
  ): Promise<LocalWorkerTask | null> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return null
    }

    ensureWorkerOwnership(task, workerId)
    task.workerId = workerId
    if (input.status) {
      task.status = input.status
      if (input.status === "running") {
        task.startedAt ??= input.heartbeatAt ?? Date.now()
      }
    }
    if (typeof input.progressText === "string") {
      task.progressText = input.progressText
    }
    if (typeof input.heartbeatAt === "number") {
      task.heartbeatAt = input.heartbeatAt
      if (task.status === "claimed") {
        task.status = "running"
        task.startedAt ??= input.heartbeatAt
      }
    }
    return cloneTask(task)
  }

  async finish(
    taskId: string,
    workerId: string,
    input: FinishLocalWorkerTaskInput,
  ): Promise<LocalWorkerTask | null> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return null
    }

    ensureWorkerOwnership(task, workerId)
    task.workerId = workerId
    task.status = input.status
    task.finishedAt = input.finishedAt ?? Date.now()
    task.resultJson = input.resultJson
    task.errorCode = input.errorCode
    task.errorMessage = input.errorMessage
    task.heartbeatAt = task.finishedAt
    task.startedAt ??= task.claimedAt ?? task.requestedAt
    return cloneTask(task)
  }

  async expireStaleTasks(
    input: ExpireLocalWorkerTasksInput,
  ): Promise<LocalWorkerTask[]> {
    const expired: LocalWorkerTask[] = []

    for (const task of this.tasks.values()) {
      if (task.status === "claimed") {
        const claimedAt = task.claimedAt ?? task.requestedAt
        if (claimedAt <= input.claimTimeoutBefore) {
          task.status = "expired"
          task.finishedAt = input.finishedAt ?? Date.now()
          task.errorCode = "local_worker_offline"
          task.errorMessage = "本地浏览器 worker 未在领取超时内开始执行任务"
          expired.push(cloneTask(task))
        }
        continue
      }

      if (
        (task.status === "running" || task.status === "waiting_manual") &&
        (task.heartbeatAt ?? task.claimedAt ?? task.requestedAt) <=
          input.heartbeatTimeoutBefore
      ) {
        task.status = "expired"
        task.finishedAt = input.finishedAt ?? Date.now()
        task.errorCode = "local_worker_offline"
        task.errorMessage = "本地浏览器 worker 心跳超时，任务已过期"
        expired.push(cloneTask(task))
      }
    }

    return expired
  }

  async getById(taskId: string): Promise<LocalWorkerTask | null> {
    const task = this.tasks.get(taskId)
    return task ? cloneTask(task) : null
  }

  async listActive(): Promise<LocalWorkerTask[]> {
    return [...this.tasks.values()]
      .filter((task) => isActiveTaskStatus(task.status))
      .sort((left, right) => left.requestedAt - right.requestedAt)
      .map(cloneTask)
  }
}

export function isActiveLocalWorkerTask(task: Pick<LocalWorkerTask, "status">): boolean {
  return isActiveTaskStatus(task.status)
}
