export interface TaskSnapshot {
  active: boolean
  kind?: string
  label?: string
  startedAt?: number
  finishedAt?: number
}

export interface TaskLockHandle {
  release(): Promise<void>
}

export interface TaskLockProvider {
  acquire(): Promise<TaskLockHandle | null>
}

const REMOTE_TASK_SNAPSHOT: TaskSnapshot = {
  active: true,
  kind: "distributed-lock",
  label: "另一实例中的任务",
}

export class BusyTaskError extends Error {
  constructor(readonly task: TaskSnapshot) {
    super(`已有任务执行中：${task.label ?? task.kind ?? "unknown"}`)
  }
}

export class TaskCoordinator {
  private currentTask: TaskSnapshot | null = null

  private lastCompletedTask: TaskSnapshot | null = null

  constructor(private readonly lockProvider?: TaskLockProvider) {}

  startExclusive<T>(
    kind: string,
    label: string,
    task: () => Promise<T>,
  ): Promise<T> {
    if (this.currentTask) {
      throw new BusyTaskError(this.getState())
    }

    const startedAt = Date.now()
    const pendingTask: TaskSnapshot = {
      active: true,
      kind,
      label,
      startedAt,
    }
    this.currentTask = pendingTask

    let lockHandle: TaskLockHandle | null = null
    return Promise.resolve()
      .then(async () => {
        lockHandle = this.lockProvider ? await this.lockProvider.acquire() : null
        if (this.lockProvider && !lockHandle) {
          throw new BusyTaskError(REMOTE_TASK_SNAPSHOT)
        }
        return await task()
      })
      .catch((error) => {
        if (this.currentTask === pendingTask) {
          this.currentTask = null
        }
        throw error
      })
      .finally(async () => {
        try {
          await lockHandle?.release()
        } finally {
          this.lastCompletedTask = {
            active: false,
            kind,
            label,
            startedAt,
            finishedAt: Date.now(),
          }
          this.currentTask = null
        }
      })
  }

  async runExclusive<T>(
    kind: string,
    label: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return await this.startExclusive(kind, label, task)
  }

  getState(): TaskSnapshot {
    if (this.currentTask) {
      return { ...this.currentTask }
    }

    if (this.lastCompletedTask) {
      return { ...this.lastCompletedTask }
    }

    return { active: false }
  }
}
