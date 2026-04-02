import { fileURLToPath } from "node:url"

import { loadWorkerConfig } from "./config.js"
import {
  loadWorkerEnvironmentFiles,
  resolveWorkerPackageDirectory,
} from "./env.js"
import { startLocalBrowserWorker } from "./worker.js"

export * from "./config.js"
export * from "./runtime.js"
export * from "./apiClient.js"
export * from "./processor.js"
export * from "./worker.js"
export * from "./env.js"

async function main(): Promise<void> {
  loadWorkerEnvironmentFiles({
    packageDirectory: resolveWorkerPackageDirectory(import.meta.url),
  })
  const config = loadWorkerConfig()
  await startLocalBrowserWorker(config)
}

const entryFile = process.argv[1]
if (entryFile && fileURLToPath(import.meta.url) === entryFile) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
