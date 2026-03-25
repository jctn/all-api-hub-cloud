import { fileURLToPath } from "node:url"

import { loadServerConfig, resolveServerConfig } from "./config.js"
import { buildServer } from "./server.js"
import { notifyRuntimeDeploymentStage } from "./telegram/deployNotifier.js"

async function main() {
  const baseConfig = loadServerConfig()
  await notifyRuntimeDeploymentStage({
    config: baseConfig,
    stage: "starting",
    logger: {
      error(error, message) {
        console.warn(message, error)
      },
    },
  })
  const config = await resolveServerConfig(baseConfig)
  const server = await buildServer({ config })
  const address = await server.listen({
    host: "0.0.0.0",
    port: config.port,
  })
  await notifyRuntimeDeploymentStage({
    config,
    stage: "running",
    address,
    logger: {
      error(error, message) {
        server.log.warn({ err: error }, message)
      },
    },
  })

  server.log.info(`All API Hub server listening at ${address}`)
}

const entryFile = process.argv[1]
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export * from "./server.js"
export * from "./config.js"
export * from "./taskCoordinator.js"
export * from "./importing/githubRepoImporter.js"
export * from "./checkin/orchestrator.js"
export * from "./checkin/authRecovery.js"
export * from "./auth/siteLoginProfiles.js"
export * from "./auth/githubTotp.js"
export * from "./auth/playwrightSessionService.js"
export * from "./storage/migrations.js"
export * from "./storage/postgresRepository.js"
export * from "./storage/advisoryLock.js"
