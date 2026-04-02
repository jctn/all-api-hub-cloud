import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import * as workerModule from "../src/index.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

function getEnvLoader(): undefined | ((options: {
  packageDirectory: string
  env?: NodeJS.ProcessEnv
}) => void) {
  return (workerModule as Record<string, unknown>)
    .loadWorkerEnvironmentFiles as
    | ((options: { packageDirectory: string; env?: NodeJS.ProcessEnv }) => void)
    | undefined
}

describe("loadWorkerEnvironmentFiles", () => {
  it("loads environment variables from .env", async () => {
    const packageDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "aah-worker-env-"),
    )
    tempDirectories.push(packageDirectory)
    await fs.writeFile(
      path.join(packageDirectory, ".env"),
      [
        "ALL_API_HUB_SERVER_URL=https://server.example.com",
        "LOCAL_WORKER_TOKEN=worker-token",
      ].join("\n"),
      "utf8",
    )

    const env: NodeJS.ProcessEnv = {}
    const loadWorkerEnvironmentFiles = getEnvLoader()

    expect(loadWorkerEnvironmentFiles).toBeTypeOf("function")

    loadWorkerEnvironmentFiles?.({ packageDirectory, env })

    expect(env.ALL_API_HUB_SERVER_URL).toBe("https://server.example.com")
    expect(env.LOCAL_WORKER_TOKEN).toBe("worker-token")
  })

  it("allows .env.local to override values from .env", async () => {
    const packageDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "aah-worker-env-"),
    )
    tempDirectories.push(packageDirectory)
    await fs.writeFile(
      path.join(packageDirectory, ".env"),
      "LOCAL_WORKER_ID=from-env\n",
      "utf8",
    )
    await fs.writeFile(
      path.join(packageDirectory, ".env.local"),
      "LOCAL_WORKER_ID=from-local\n",
      "utf8",
    )

    const env: NodeJS.ProcessEnv = {}
    const loadWorkerEnvironmentFiles = getEnvLoader()

    expect(loadWorkerEnvironmentFiles).toBeTypeOf("function")

    loadWorkerEnvironmentFiles?.({ packageDirectory, env })

    expect(env.LOCAL_WORKER_ID).toBe("from-local")
  })

  it("does not override an already provided environment variable", async () => {
    const packageDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "aah-worker-env-"),
    )
    tempDirectories.push(packageDirectory)
    await fs.writeFile(
      path.join(packageDirectory, ".env"),
      "LOCAL_WORKER_TOKEN=file-token\n",
      "utf8",
    )

    const env: NodeJS.ProcessEnv = {
      LOCAL_WORKER_TOKEN: "process-token",
    }
    const loadWorkerEnvironmentFiles = getEnvLoader()

    expect(loadWorkerEnvironmentFiles).toBeTypeOf("function")

    loadWorkerEnvironmentFiles?.({ packageDirectory, env })

    expect(env.LOCAL_WORKER_TOKEN).toBe("process-token")
  })

  it("silently skips missing env files", () => {
    const packageDirectory = path.join(os.tmpdir(), "aah-worker-env-missing")
    const env: NodeJS.ProcessEnv = {}
    const loadWorkerEnvironmentFiles = getEnvLoader()

    expect(loadWorkerEnvironmentFiles).toBeTypeOf("function")

    expect(() =>
      loadWorkerEnvironmentFiles?.({ packageDirectory, env }),
    ).not.toThrow()
    expect(env).toEqual({})
  })
})
