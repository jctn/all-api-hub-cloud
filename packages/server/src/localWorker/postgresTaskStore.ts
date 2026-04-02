import type {
  DatabaseClient,
  DatabasePool,
} from "../storage/types.js"
import {
  type CreateLocalWorkerTaskInput,
  type ExpireLocalWorkerTasksInput,
  type FinishLocalWorkerTaskInput,
  type LocalWorkerTask,
  type LocalWorkerTaskStatus,
  type LocalWorkerTaskStore,
  type UpdateLocalWorkerTaskProgressInput,
} from "./taskStore.js"

interface LocalWorkerTaskRow {
  id: string
  kind: LocalWorkerTask["kind"]
  scope: LocalWorkerTask["scope"]
  account_ids: string[]
  payload: LocalWorkerTask["payload"]
  status: LocalWorkerTaskStatus
  requested_by: string
  chat_id: string | null
  verbose: boolean
  worker_id: string | null
  progress_text: string | null
  heartbeat_at: number | null
  requested_at: number
  claimed_at: number | null
  started_at: number | null
  finished_at: number | null
  result_json: unknown
  error_code: string | null
  error_message: string | null
}

function mapTaskRow(row: LocalWorkerTaskRow): LocalWorkerTask {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    accountIds: Array.isArray(row.account_ids) ? row.account_ids : [],
    payload: row.payload,
    status: row.status,
    requestedBy: row.requested_by,
    chatId: row.chat_id,
    verbose: row.verbose,
    workerId: row.worker_id ?? undefined,
    progressText: row.progress_text ?? undefined,
    heartbeatAt: row.heartbeat_at ?? undefined,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    resultJson: row.result_json ?? undefined,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
  }
}

async function withTransaction<T>(
  pool: DatabasePool,
  run: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const result = await run(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

export class PostgresLocalWorkerTaskStore implements LocalWorkerTaskStore {
  constructor(private readonly pool: DatabasePool) {}

  async enqueue(input: CreateLocalWorkerTaskInput): Promise<LocalWorkerTask> {
    const requestedAt = input.requestedAt ?? Date.now()
    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        INSERT INTO local_worker_tasks (
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose,
          requested_at
        ) VALUES (
          gen_random_uuid()::text,
          $1,
          $2,
          $3::jsonb,
          $4::jsonb,
          'queued',
          $5,
          $6,
          $7,
          $8
        )
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [
        input.kind,
        input.scope,
        JSON.stringify(input.payload.accountIds),
        JSON.stringify(input.payload),
        input.requestedBy,
        input.chatId ?? null,
        input.verbose,
        requestedAt,
      ],
    )

    return mapTaskRow(result.rows[0]!)
  }

  async claimNext(
    workerId: string,
    claimedAt = Date.now(),
  ): Promise<LocalWorkerTask | null> {
    return withTransaction(this.pool, async (client) => {
      const activeResult = await client.query<{ id: string }>(
        `
          SELECT id
          FROM local_worker_tasks
          WHERE status IN ('claimed', 'running', 'waiting_manual')
          ORDER BY requested_at ASC
          LIMIT 1
          FOR UPDATE
        `,
      )
      if (activeResult.rows[0]) {
        return null
      }

      const nextQueued = await client.query<LocalWorkerTaskRow>(
        `
          SELECT
            id,
            kind,
            scope,
            account_ids,
            payload,
            status,
            requested_by,
            chat_id,
            is_verbose AS verbose,
            worker_id,
            progress_text,
            heartbeat_at,
            requested_at,
            claimed_at,
            started_at,
            finished_at,
            result_json,
            error_code,
            error_message
          FROM local_worker_tasks
          WHERE status = 'queued'
          ORDER BY requested_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `,
      )
      const task = nextQueued.rows[0]
      if (!task) {
        return null
      }

      const claimed = await client.query<LocalWorkerTaskRow>(
        `
          UPDATE local_worker_tasks
          SET
            status = 'claimed',
            worker_id = $2,
            claimed_at = $3,
            heartbeat_at = $3
          WHERE id = $1
          RETURNING
            id,
            kind,
            scope,
            account_ids,
            payload,
            status,
            requested_by,
            chat_id,
            is_verbose AS verbose,
            worker_id,
            progress_text,
            heartbeat_at,
            requested_at,
            claimed_at,
            started_at,
            finished_at,
            result_json,
            error_code,
            error_message
        `,
        [task.id, workerId, claimedAt],
      )

      return claimed.rows[0] ? mapTaskRow(claimed.rows[0]) : null
    })
  }

  async heartbeat(
    taskId: string,
    workerId: string,
    heartbeatAt = Date.now(),
  ): Promise<LocalWorkerTask | null> {
    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        UPDATE local_worker_tasks
        SET
          status = CASE
            WHEN status = 'claimed' THEN 'running'
            ELSE status
          END,
          heartbeat_at = $3,
          started_at = CASE
            WHEN status = 'claimed' AND started_at IS NULL THEN $3
            ELSE started_at
          END
        WHERE id = $1
          AND worker_id = $2
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [taskId, workerId, heartbeatAt],
    )

    if (result.rows[0]) {
      return mapTaskRow(result.rows[0])
    }

    await this.assertOwnership(taskId, workerId)
    return null
  }

  async updateProgress(
    taskId: string,
    workerId: string,
    input: UpdateLocalWorkerTaskProgressInput,
  ): Promise<LocalWorkerTask | null> {
    const status = input.status ?? "running"
    const heartbeatAt = input.heartbeatAt ?? Date.now()
    const progressText = input.progressText ?? null

    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        UPDATE local_worker_tasks
        SET
          status = $3,
          progress_text = $4,
          heartbeat_at = $5,
          started_at = CASE
            WHEN $3 = 'running' AND started_at IS NULL THEN $5
            ELSE started_at
          END
        WHERE id = $1
          AND worker_id = $2
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [taskId, workerId, status, progressText, heartbeatAt],
    )

    if (result.rows[0]) {
      return mapTaskRow(result.rows[0])
    }

    await this.assertOwnership(taskId, workerId)
    return null
  }

  async finish(
    taskId: string,
    workerId: string,
    input: FinishLocalWorkerTaskInput,
  ): Promise<LocalWorkerTask | null> {
    const finishedAt = input.finishedAt ?? Date.now()
    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        UPDATE local_worker_tasks
        SET
          status = $3,
          finished_at = $4,
          heartbeat_at = $4,
          result_json = $5::jsonb,
          error_code = $6,
          error_message = $7,
          started_at = COALESCE(started_at, claimed_at, requested_at)
        WHERE id = $1
          AND worker_id = $2
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [
        taskId,
        workerId,
        input.status,
        finishedAt,
        JSON.stringify(input.resultJson ?? null),
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    )

    if (result.rows[0]) {
      return mapTaskRow(result.rows[0])
    }

    await this.assertOwnership(taskId, workerId)
    return null
  }

  async expireStaleTasks(
    input: ExpireLocalWorkerTasksInput,
  ): Promise<LocalWorkerTask[]> {
    const finishedAt = input.finishedAt ?? Date.now()
    const expiredTasks: LocalWorkerTask[] = []

    const claimedResult = await this.pool.query<LocalWorkerTaskRow>(
      `
        UPDATE local_worker_tasks
        SET
          status = 'expired',
          finished_at = $2,
          error_code = 'local_worker_offline',
          error_message = '本地浏览器 worker 未在领取超时内开始执行任务'
        WHERE status = 'claimed'
          AND COALESCE(claimed_at, requested_at) <= $1
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [input.claimTimeoutBefore, finishedAt],
    )
    expiredTasks.push(...claimedResult.rows.map(mapTaskRow))

    const heartbeatResult = await this.pool.query<LocalWorkerTaskRow>(
      `
        UPDATE local_worker_tasks
        SET
          status = 'expired',
          finished_at = $2,
          error_code = 'local_worker_offline',
          error_message = '本地浏览器 worker 心跳超时，任务已过期'
        WHERE status IN ('running', 'waiting_manual')
          AND COALESCE(heartbeat_at, claimed_at, requested_at) <= $1
        RETURNING
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
      `,
      [input.heartbeatTimeoutBefore, finishedAt],
    )
    expiredTasks.push(...heartbeatResult.rows.map(mapTaskRow))

    return expiredTasks
  }

  async getById(taskId: string): Promise<LocalWorkerTask | null> {
    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        SELECT
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          is_verbose AS verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
        FROM local_worker_tasks
        WHERE id = $1
      `,
      [taskId],
    )

    return result.rows[0] ? mapTaskRow(result.rows[0]) : null
  }

  async listActive(): Promise<LocalWorkerTask[]> {
    const result = await this.pool.query<LocalWorkerTaskRow>(
      `
        SELECT
          id,
          kind,
          scope,
          account_ids,
          payload,
          status,
          requested_by,
          chat_id,
          verbose,
          worker_id,
          progress_text,
          heartbeat_at,
          requested_at,
          claimed_at,
          started_at,
          finished_at,
          result_json,
          error_code,
          error_message
        FROM local_worker_tasks
        WHERE status IN ('claimed', 'running', 'waiting_manual')
        ORDER BY requested_at ASC, id ASC
      `,
    )

    return result.rows.map(mapTaskRow)
  }

  private async assertOwnership(taskId: string, workerId: string): Promise<void> {
    const result = await this.pool.query<{ worker_id: string | null }>(
      "SELECT worker_id FROM local_worker_tasks WHERE id = $1",
      [taskId],
    )
    const owner = result.rows[0]?.worker_id
    if (owner && owner !== workerId) {
      throw new Error("Task worker mismatch")
    }
  }
}
