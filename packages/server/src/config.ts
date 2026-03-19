import path from "node:path"

import {
  resolveDefaultDataDirectory,
  resolveProfilesDirectory,
} from "@all-api-hub/core"

import {
  parseSiteLoginProfiles,
  type SiteLoginProfileMap,
} from "./auth/siteLoginProfiles.js"

export interface TelegramConfig {
  botToken: string
  webhookSecret: string
  adminChatId: string
}

export interface ImportRepoConfig {
  owner: string
  name: string
  path: string
  ref: string
  githubPat: string
}

export interface GitHubSsoConfig {
  username: string
  password: string
  totpSecret: string
  linuxdoBaseUrl: string
}

export interface ServerConfig {
  port: number
  databaseUrl: string
  dataDirectory: string
  diagnosticsDirectory: string
  sharedSsoProfileDirectory: string
  chromiumExecutablePath?: string
  internalAdminToken: string
  telegram: TelegramConfig
  importRepo: ImportRepoConfig
  github: GitHubSsoConfig
  siteLoginProfiles: SiteLoginProfileMap
  timeZone: string
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const databaseUrl =
    env.DATABASE_URL?.trim() || env.POSTGRES_CONNECTION_STRING?.trim()
  const dataDirectory =
    env.ALL_API_HUB_DATA_DIR?.trim() ||
    resolveDefaultDataDirectory("all-api-hub-server")
  const profilesDirectory = resolveProfilesDirectory(dataDirectory)
  const port = Number.parseInt(env.PORT ?? "3000", 10)

  if (!databaseUrl) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL or POSTGRES_CONNECTION_STRING",
    )
  }

  return {
    port: Number.isFinite(port) ? port : 3000,
    databaseUrl,
    dataDirectory,
    diagnosticsDirectory: path.join(dataDirectory, "diagnostics"),
    sharedSsoProfileDirectory: path.join(
      profilesDirectory,
      "cloud",
      "linuxdo-github",
    ),
    chromiumExecutablePath: env.CHROMIUM_PATH?.trim() || undefined,
    internalAdminToken: requiredEnv(env, "INTERNAL_ADMIN_TOKEN"),
    telegram: {
      botToken: requiredEnv(env, "TG_BOT_TOKEN"),
      webhookSecret: requiredEnv(env, "TG_WEBHOOK_SECRET"),
      adminChatId: requiredEnv(env, "TG_ADMIN_CHAT_ID"),
    },
    importRepo: {
      owner: requiredEnv(env, "IMPORT_REPO_OWNER"),
      name: requiredEnv(env, "IMPORT_REPO_NAME"),
      path: requiredEnv(env, "IMPORT_REPO_PATH"),
      ref: requiredEnv(env, "IMPORT_REPO_REF"),
      githubPat: requiredEnv(env, "IMPORT_GITHUB_PAT"),
    },
    github: {
      username: requiredEnv(env, "GITHUB_USERNAME"),
      password: requiredEnv(env, "GITHUB_PASSWORD"),
      totpSecret: requiredEnv(env, "GITHUB_TOTP_SECRET"),
      linuxdoBaseUrl: env.LINUXDO_BASE_URL?.trim() || "https://linux.do",
    },
    siteLoginProfiles: parseSiteLoginProfiles(env.SITE_LOGIN_PROFILES_JSON),
    timeZone: env.TZ?.trim() || "Asia/Shanghai",
  }
}
