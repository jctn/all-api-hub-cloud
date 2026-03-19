import type { TaskLockHandle, TaskLockProvider } from "../taskCoordinator.js"
import type { DatabasePool } from "./types.js"

export const DEFAULT_TASK_ADVISORY_LOCK_KEY = 101_327

class PostgresTaskLockHandle implements TaskLockHandle {
  constructor(
    private readonly lockKey: number,
    private readonly client: {
      query(queryText: string, values?: unknown[]): Promise<unknown>
      release(): void
    },
  ) {}

  async release(): Promise<void> {
    try {
      await this.client.query("SELECT pg_advisory_unlock($1)", [this.lockKey])
    } finally {
      this.client.release()
    }
  }
}

export class PostgresAdvisoryLockProvider implements TaskLockProvider {
  constructor(
    private readonly pool: DatabasePool,
    private readonly lockKey = DEFAULT_TASK_ADVISORY_LOCK_KEY,
  ) {}

  async acquire(): Promise<TaskLockHandle | null> {
    const client = await this.pool.connect()
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [this.lockKey],
      )
      if (!result.rows[0]?.locked) {
        client.release()
        return null
      }

      return new PostgresTaskLockHandle(this.lockKey, client)
    } catch (error) {
      client.release()
      throw error
    }
  }
}
