import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify"
import { FileSystemRepository, type StorageRepository } from "@all-api-hub/core"
import { Pool } from "pg"

import { PlaywrightSiteSessionService } from "./auth/playwrightSessionService.js"
import { CheckinOrchestrator } from "./checkin/orchestrator.js"
import { loadServerConfig, type ServerConfig } from "./config.js"
import { GitHubBackupImporter } from "./importing/githubRepoImporter.js"
import { BusyTaskError, TaskCoordinator } from "./taskCoordinator.js"
import { createTelegramBot } from "./telegram/bot.js"
import { runMigrations, type MigrationResult } from "./storage/migrations.js"
import { PostgresRepository } from "./storage/postgresRepository.js"
import { PostgresAdvisoryLockProvider } from "./storage/advisoryLock.js"

interface InternalRequestBody {
  accountId?: string
}

export interface BuildServerOptions {
  config?: ServerConfig
  repository?: StorageRepository
  fetchImpl?: typeof fetch
  taskCoordinator?: TaskCoordinator
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
  const config = options.config ?? loadServerConfig()
  const fetchImpl = options.fetchImpl ?? fetch
  let repository = options.repository
  let taskCoordinator = options.taskCoordinator
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

  if (!repository) {
    throw new Error("Repository initialization failed")
  }

  if (!taskCoordinator) {
    throw new Error("Task coordinator initialization failed")
  }

  await repository.initialize()

  const importer = new GitHubBackupImporter(repository, config.importRepo, fetchImpl)
  const sessionRefresher = new PlaywrightSiteSessionService(
    repository,
    config,
    fetchImpl,
  )
  const orchestrator = new CheckinOrchestrator(
    repository,
    config,
    sessionRefresher,
    fetchImpl,
  )

  const app = Fastify({
    logger: true,
  })

  if (ownedPool) {
    app.addHook("onClose", async () => {
      await ownedPool?.end()
    })
  }

  const bot = createTelegramBot({
    config,
    repository,
    taskCoordinator,
    importer,
    orchestrator,
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

  app.get("/internal/healthz", async () => ({
    ok: true,
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
