import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify"
import { FileSystemRepository, type StorageRepository } from "@all-api-hub/core"
import type { UserFromGetMe } from "grammy/types"
import { Pool } from "pg"

import { PlaywrightSiteSessionService } from "./auth/playwrightSessionService.js"
import { CheckinOrchestrator } from "./checkin/orchestrator.js"
import {
  loadServerConfig,
  resolveServerConfig,
  type ServerConfig,
} from "./config.js"
import { GitHubBackupImporter } from "./importing/githubRepoImporter.js"
import { BusyTaskError, TaskCoordinator } from "./taskCoordinator.js"
import { createTelegramBot } from "./telegram/bot.js"
import { runMigrations, type MigrationResult } from "./storage/migrations.js"
import { PostgresRepository } from "./storage/postgresRepository.js"
import { PostgresAdvisoryLockProvider } from "./storage/advisoryLock.js"
import { PollingLocalWorkerExecutionGateway } from "./localWorker/gateway.js"
import { HybridCheckinOrchestrator } from "./localWorker/hybridOrchestrator.js"
import {
  InMemoryLocalWorkerTaskStore,
  type CreateLocalWorkerTaskInput,
  type FinishLocalWorkerTaskInput,
  type LocalWorkerTaskStore,
  type UpdateLocalWorkerTaskProgressInput,
} from "./localWorker/taskStore.js"
import { PostgresLocalWorkerTaskStore } from "./localWorker/postgresTaskStore.js"

interface InternalRequestBody {
  accountId?: string
}

interface LocalWorkerClaimBody {
  workerId?: string
  claimedAt?: number
}

interface LocalWorkerHeartbeatBody {
  workerId?: string
  heartbeatAt?: number
}

interface LocalWorkerProgressBody extends LocalWorkerHeartbeatBody {
  status?: "running" | "waiting_manual"
  progressText?: string
}

interface LocalWorkerFinishBody {
  workerId?: string
  status?: "succeeded" | "failed" | "expired"
  finishedAt?: number
  resultJson?: unknown
  errorCode?: string
  errorMessage?: string
}

export interface BuildServerOptions {
  config?: ServerConfig
  repository?: StorageRepository
  fetchImpl?: typeof fetch
  taskCoordinator?: TaskCoordinator
  localWorkerTaskStore?: LocalWorkerTaskStore
  telegramBotInfo?: UserFromGetMe
}

function parseBearerToken(header: string | undefined): string {
  if (!header) {
    return ""
  }

  const match = header.match(/^Bearer\s+(.+)$/iu)
  return match?.[1]?.trim() ?? ""
}

export async function buildServer(
  options: BuildServerOptions = {},
): Promise<FastifyInstance> {
  const fetchImpl = options.fetchImpl ?? fetch
  const config = await resolveServerConfig(
    options.config ?? loadServerConfig(),
    fetchImpl,
  )
  let repository = options.repository
  let taskCoordinator = options.taskCoordinator
  let localWorkerTaskStore = options.localWorkerTaskStore
  let storageMode = "filesystem"
  let migrationResult: MigrationResult = {
    appliedMigrationIds: [],
    latestMigrationId: null,
  }
  let ownedPool: Pool | null = null

  if (!repository) {
    ownedPool = new Pool({
      connectionString: config.databaseUrl,
    })
    migrationResult = await runMigrations(ownedPool)
    repository = new PostgresRepository(ownedPool)
    storageMode = "postgres"
  } else if (repository instanceof FileSystemRepository) {
    storageMode = "filesystem"
  } else if (repository instanceof PostgresRepository) {
    storageMode = "postgres"
  } else {
    storageMode = "custom"
  }

  if (!taskCoordinator) {
    taskCoordinator = ownedPool
      ? new TaskCoordinator(new PostgresAdvisoryLockProvider(ownedPool))
      : new TaskCoordinator()
  }

  if (!localWorkerTaskStore) {
    localWorkerTaskStore = ownedPool
      ? new PostgresLocalWorkerTaskStore(ownedPool)
      : new InMemoryLocalWorkerTaskStore()
  }

  if (!repository) {
    throw new Error("Repository initialization failed")
  }

  if (!taskCoordinator) {
    throw new Error("Task coordinator initialization failed")
  }

  if (!localWorkerTaskStore) {
    throw new Error("Local worker task store initialization failed")
  }

  await repository.initialize()

  const importer = new GitHubBackupImporter(repository, config.importRepo, fetchImpl)
  const sessionRefresher = new PlaywrightSiteSessionService(
    repository,
    config,
    fetchImpl,
  )
  const cloudOrchestrator = new CheckinOrchestrator(
    repository,
    config,
    sessionRefresher,
    fetchImpl,
  )
  const localWorkerGateway = new PollingLocalWorkerExecutionGateway({
    taskStore: localWorkerTaskStore,
    pollIntervalMs: 1_000,
    claimTimeoutMs: 45_000,
    heartbeatTimeoutMs: 90_000,
  })
  const orchestrator = new HybridCheckinOrchestrator({
    repository,
    siteLoginProfiles: config.siteLoginProfiles,
    cloud: cloudOrchestrator,
    localWorker: localWorkerGateway,
  })

  const app = Fastify({
    logger: true,
  })

  if (ownedPool) {
    app.addHook("onClose", async () => {
      await ownedPool?.end()
    })
  }

  const bot = await createTelegramBot({
    config,
    repository,
    taskCoordinator,
    importer,
    orchestrator,
    botInfo: options.telegramBotInfo,
    logger: {
      error(error, message) {
        app.log.error({ err: error }, message)
      },
    },
  })

  const requireInternalAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const token = parseBearerToken(request.headers.authorization)
    if (token !== config.internalAdminToken) {
      return await reply.code(401).send({
        ok: false,
        error: "unauthorized",
      })
    }
  }

  const requireLocalWorkerAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const token = parseBearerToken(request.headers.authorization)
    if (token !== config.localWorkerToken) {
      return await reply.code(401).send({
        ok: false,
        error: "unauthorized",
      })
    }
  }

  app.get("/internal/healthz", async () => ({
    ok: true,
    version: config.deploymentVersion,
    appVersion: config.appVersion,
    gitCommitSha: config.gitCommitSha ?? null,
    gitCommitShortSha: config.gitCommitShortSha ?? null,
    gitBranch: config.gitBranch ?? null,
    gitCommitMessage: config.gitCommitMessage ?? null,
    siteLoginProfilesSource: config.siteLoginProfilesSource,
    siteLoginProfilesCount: config.siteLoginProfilesCount,
    storageMode,
    dataDirectory: config.dataDirectory,
    latestMigrationId: migrationResult.latestMigrationId,
    appliedMigrationIds: migrationResult.appliedMigrationIds,
    task: taskCoordinator.getState(),
  }))

  app.post("/telegram/webhook", async (request, reply) => {
    const secretToken = request.headers["x-telegram-bot-api-secret-token"]
    if (secretToken !== config.telegram.webhookSecret) {
      return await reply.code(403).send({
        ok: false,
        error: "invalid_telegram_secret",
      })
    }

    await bot.handleUpdate(
      request.body as Parameters<typeof bot.handleUpdate>[0],
    )
    return await reply.send({ ok: true })
  })

  app.post(
    "/internal/worker/tasks/enqueue",
    { preHandler: requireInternalAuth },
    async (request, reply) => {
      const body = (request.body ?? {}) as Partial<CreateLocalWorkerTaskInput>
      const payload = body.payload
      if (
        !body.kind ||
        !body.scope ||
        !body.requestedBy ||
        !payload ||
        !Array.isArray(payload.accountIds) ||
        !Array.isArray(payload.accounts)
      ) {
        return await reply.code(400).send({
          ok: false,
          error: "invalid_local_worker_task",
        })
      }

      const task = await localWorkerTaskStore.enqueue({
        kind: body.kind,
        scope: body.scope,
        requestedBy: body.requestedBy,
        chatId: body.chatId,
        verbose: Boolean(body.verbose),
        requestedAt: body.requestedAt,
        payload: {
          ...payload,
          accountIds: payload.accountIds,
          accounts: payload.accounts,
        },
      })

      return await reply.send({ ok: true, task })
    },
  )

  app.post(
    "/internal/worker/tasks/claim",
    { preHandler: requireLocalWorkerAuth },
    async (request, reply) => {
      const body = (request.body ?? {}) as LocalWorkerClaimBody
      const workerId = body.workerId?.trim()
      if (!workerId) {
        return await reply.code(400).send({
          ok: false,
          error: "missing_worker_id",
        })
      }

      const task = await localWorkerTaskStore.claimNext(workerId, body.claimedAt)
      return await reply.send({ ok: true, task })
    },
  )

  app.post(
    "/internal/worker/tasks/:taskId/heartbeat",
    { preHandler: requireLocalWorkerAuth },
    async (request, reply) => {
      const taskId = String((request.params as { taskId?: string }).taskId ?? "")
      const body = (request.body ?? {}) as LocalWorkerHeartbeatBody
      const workerId = body.workerId?.trim()
      if (!taskId || !workerId) {
        return await reply.code(400).send({
          ok: false,
          error: "missing_task_or_worker_id",
        })
      }

      try {
        const task = await localWorkerTaskStore.heartbeat(
          taskId,
          workerId,
          body.heartbeatAt,
        )
        if (!task) {
          return await reply.code(404).send({ ok: false, error: "task_not_found" })
        }
        return await reply.send({ ok: true, task })
      } catch (error) {
        return await reply.code(409).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  app.post(
    "/internal/worker/tasks/:taskId/progress",
    { preHandler: requireLocalWorkerAuth },
    async (request, reply) => {
      const taskId = String((request.params as { taskId?: string }).taskId ?? "")
      const body = (request.body ?? {}) as LocalWorkerProgressBody
      const workerId = body.workerId?.trim()
      if (!taskId || !workerId) {
        return await reply.code(400).send({
          ok: false,
          error: "missing_task_or_worker_id",
        })
      }

      const input: UpdateLocalWorkerTaskProgressInput = {
        status: body.status,
        progressText: body.progressText,
        heartbeatAt: body.heartbeatAt,
      }

      try {
        const task = await localWorkerTaskStore.updateProgress(
          taskId,
          workerId,
          input,
        )
        if (!task) {
          return await reply.code(404).send({ ok: false, error: "task_not_found" })
        }
        return await reply.send({ ok: true, task })
      } catch (error) {
        return await reply.code(409).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  app.post(
    "/internal/worker/tasks/:taskId/finish",
    { preHandler: requireLocalWorkerAuth },
    async (request, reply) => {
      const taskId = String((request.params as { taskId?: string }).taskId ?? "")
      const body = (request.body ?? {}) as LocalWorkerFinishBody
      const workerId = body.workerId?.trim()
      if (!taskId || !workerId || !body.status) {
        return await reply.code(400).send({
          ok: false,
          error: "missing_task_worker_or_status",
        })
      }

      const input: FinishLocalWorkerTaskInput = {
        status: body.status,
        finishedAt: body.finishedAt,
        resultJson: body.resultJson,
        errorCode: body.errorCode,
        errorMessage: body.errorMessage,
      }

      try {
        const task = await localWorkerTaskStore.finish(taskId, workerId, input)
        if (!task) {
          return await reply.code(404).send({ ok: false, error: "task_not_found" })
        }
        return await reply.send({ ok: true, task })
      } catch (error) {
        return await reply.code(409).send({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  app.post(
    "/internal/import/sync",
    { preHandler: requireInternalAuth },
    async (_request, reply) => {
      try {
        const result = await taskCoordinator.runExclusive(
          "sync_import",
          "从 GitHub 仓库同步账号 JSON",
          () => importer.syncFromRepo(),
        )
        return await reply.send({ ok: true, result })
      } catch (error) {
        if (error instanceof BusyTaskError) {
          return await reply.code(409).send({
            ok: false,
            error: error.message,
            task: error.task,
          })
        }

        throw error
      }
    },
  )

  app.post(
    "/internal/checkin/run",
    { preHandler: requireInternalAuth },
    async (request, reply) => {
      const body = (request.body ?? {}) as InternalRequestBody
      const accountId = body.accountId?.trim() || undefined

      try {
        const result = await taskCoordinator.runExclusive(
          accountId ? "checkin_one" : "checkin_all",
          accountId ? `执行单账号签到: ${accountId}` : "执行全部可签到账号",
          () =>
            orchestrator.runCheckinBatch({
              accountId,
              mode: accountId ? "manual" : "scheduled",
            }),
        )

        return await reply.send({ ok: true, result })
      } catch (error) {
        if (error instanceof BusyTaskError) {
          return await reply.code(409).send({
            ok: false,
            error: error.message,
            task: error.task,
          })
        }

        throw error
      }
    },
  )

  app.post(
    "/internal/auth/refresh",
    { preHandler: requireInternalAuth },
    async (request, reply) => {
      const body = (request.body ?? {}) as InternalRequestBody
      const normalizedAccountId = body.accountId?.trim()
      const accountId =
        normalizedAccountId && normalizedAccountId.toLowerCase() !== "all"
          ? normalizedAccountId
          : undefined

      try {
        const result = await taskCoordinator.runExclusive(
          "auth_refresh",
          accountId ? `刷新账号会话: ${accountId}` : "刷新全部账号会话",
          () => orchestrator.refreshSessions(accountId),
        )

        return await reply.send({ ok: true, result })
      } catch (error) {
        if (error instanceof BusyTaskError) {
          return await reply.code(409).send({
            ok: false,
            error: error.message,
            task: error.task,
          })
        }

        throw error
      }
    },
  )

  return app
}
