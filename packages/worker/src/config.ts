import os from "node:os"
import fs from "node:fs"
import path from "node:path"

import { resolveProfilesDirectory } from "@all-api-hub/core"

export interface WorkerConfig {
  serverUrl: string
  workerToken: string
  workerId: string
  privateDataDirectory: string
  dataDirectory: string
  diagnosticsDirectory: string
  logsDirectory: string
  profilesDirectory: string
  chromiumExecutablePath?: string
  github: {
    username: string
    password: string
    totpSecret: string
    linuxdoBaseUrl: string
  }
  pollIntervalMs: number
  heartbeatIntervalMs: number
  claimTimeoutMs: number
  heartbeatTimeoutMs: number
}

const WINDOWS_CHROMIUM_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
] as const

interface ResolveChromiumExecutablePathOptions {
  platform?: NodeJS.Platform
  pathExists?: (candidatePath: string) => boolean
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig {
  const dataDirectory =
    env.ALL_API_HUB_DATA_DIR?.trim() ||
    resolveWorkerDataDirectory(env)
  const profilesDirectory = resolveProfilesDirectory(dataDirectory)

  return {
    serverUrl: requiredEnv(env, "ALL_API_HUB_SERVER_URL"),
    workerToken: requiredEnv(env, "LOCAL_WORKER_TOKEN"),
    workerId: env.LOCAL_WORKER_ID?.trim() || "local-browser-1",
    privateDataDirectory: requiredEnv(env, "ALL_API_HUB_PRIVATE_DATA_DIR"),
    dataDirectory,
    diagnosticsDirectory: path.join(dataDirectory, "diagnostics"),
    logsDirectory: path.join(dataDirectory, "logs"),
    profilesDirectory,
    chromiumExecutablePath: resolveChromiumExecutablePath(env),
    github: {
      username: requiredEnv(env, "GITHUB_USERNAME"),
      password: requiredEnv(env, "GITHUB_PASSWORD"),
      totpSecret: requiredEnv(env, "GITHUB_TOTP_SECRET"),
      linuxdoBaseUrl: env.LINUXDO_BASE_URL?.trim() || "https://linux.do",
    },
    pollIntervalMs: parseInteger(env.LOCAL_WORKER_POLL_INTERVAL_MS, 15_000),
    heartbeatIntervalMs: parseInteger(
      env.LOCAL_WORKER_HEARTBEAT_INTERVAL_MS,
      15_000,
    ),
    claimTimeoutMs: parseInteger(env.LOCAL_WORKER_CLAIM_TIMEOUT_MS, 45_000),
    heartbeatTimeoutMs: parseInteger(
      env.LOCAL_WORKER_HEARTBEAT_TIMEOUT_MS,
      90_000,
    ),
  }
}

export function resolveChromiumExecutablePath(
  env: NodeJS.ProcessEnv,
  options: ResolveChromiumExecutablePathOptions = {},
): string | undefined {
  const configuredPath = env.CHROMIUM_PATH?.trim()
  if (configuredPath) {
    return configuredPath
  }

  const platform = options.platform ?? process.platform
  const pathExists = options.pathExists ?? fs.existsSync

  if (platform === "win32") {
    for (const candidatePath of WINDOWS_CHROMIUM_CANDIDATES) {
      if (pathExists(candidatePath)) {
        return candidatePath
      }
    }
  }

  return undefined
}

function resolveWorkerDataDirectory(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || os.homedir()
    return path.join(base, "all-api-hub-worker")
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "all-api-hub-worker",
    )
  }

  return path.join(os.homedir(), ".config", "all-api-hub-worker")
}
