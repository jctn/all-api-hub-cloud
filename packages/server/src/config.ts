import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  resolveDefaultDataDirectory,
  resolveProfilesDirectory,
} from "@all-api-hub/core"

import {
  parseSiteLoginProfiles,
  type SiteLoginProfileMap,
} from "./auth/siteLoginProfiles.js"
import {
  fetchGitHubRepoTextFile,
  GitHubRepoFileHttpError,
} from "./github/repoFile.js"

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
  flareSolverrUrl: string | null
  siteLoginProfiles: SiteLoginProfileMap
  siteLoginProfilesRepo?: ImportRepoConfig | null
  timeZone: string
  appVersion: string
  deploymentVersion: string
  gitCommitSha?: string
  gitCommitShortSha?: string
  gitBranch?: string
  gitCommitMessage?: string
  siteLoginProfilesSource: string
  siteLoginProfilesCount: number
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    )
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      version?: string
    }
    return packageJson.version?.trim() || "0.0.0"
  } catch {
    return "0.0.0"
  }
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
  const appVersion = readPackageVersion()
  const gitCommitSha =
    env.ZEABUR_GIT_COMMIT_SHA?.trim() || env.GIT_COMMIT_SHA?.trim() || undefined
  const gitCommitShortSha = gitCommitSha?.slice(0, 7)
  const gitBranch =
    env.ZEABUR_GIT_BRANCH?.trim() || env.GIT_BRANCH?.trim() || undefined
  const gitCommitMessage =
    env.ZEABUR_GIT_COMMIT_MESSAGE?.trim() ||
    env.GIT_COMMIT_MESSAGE?.trim() ||
    undefined
  const deploymentVersion = gitCommitShortSha
    ? `${appVersion}+${gitCommitShortSha}`
    : appVersion

  if (!databaseUrl) {
    throw new Error(
      "Missing required environment variable: DATABASE_URL or POSTGRES_CONNECTION_STRING",
    )
  }

  const importRepo: ImportRepoConfig = {
    owner: requiredEnv(env, "IMPORT_REPO_OWNER"),
    name: requiredEnv(env, "IMPORT_REPO_NAME"),
    path: requiredEnv(env, "IMPORT_REPO_PATH"),
    ref: requiredEnv(env, "IMPORT_REPO_REF"),
    githubPat: requiredEnv(env, "IMPORT_GITHUB_PAT"),
  }

  const siteLoginProfilesRepoPath = env.SITE_LOGIN_PROFILES_REPO_PATH?.trim()
  const siteLoginProfilesRepo = siteLoginProfilesRepoPath
    ? {
        owner:
          env.SITE_LOGIN_PROFILES_REPO_OWNER?.trim() || importRepo.owner,
        name: env.SITE_LOGIN_PROFILES_REPO_NAME?.trim() || importRepo.name,
        path: siteLoginProfilesRepoPath,
        ref: env.SITE_LOGIN_PROFILES_REPO_REF?.trim() || importRepo.ref,
        githubPat:
          env.SITE_LOGIN_PROFILES_GITHUB_PAT?.trim() || importRepo.githubPat,
      }
    : null

  const flareSolverrUrl = env.FLARESOLVERR_URL?.trim() || null

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
    importRepo,
    github: {
      username: requiredEnv(env, "GITHUB_USERNAME"),
      password: requiredEnv(env, "GITHUB_PASSWORD"),
      totpSecret: requiredEnv(env, "GITHUB_TOTP_SECRET"),
      linuxdoBaseUrl: env.LINUXDO_BASE_URL?.trim() || "https://linux.do",
    },
    flareSolverrUrl,
    siteLoginProfiles: parseSiteLoginProfiles(env.SITE_LOGIN_PROFILES_JSON),
    siteLoginProfilesRepo,
    timeZone: env.TZ?.trim() || "Asia/Shanghai",
    appVersion,
    deploymentVersion,
    gitCommitSha,
    gitCommitShortSha,
    gitBranch,
    gitCommitMessage,
    siteLoginProfilesSource: siteLoginProfilesRepo
      ? `github://${siteLoginProfilesRepo.owner}/${siteLoginProfilesRepo.name}/${siteLoginProfilesRepo.path}@${siteLoginProfilesRepo.ref}`
      : "env:SITE_LOGIN_PROFILES_JSON",
    siteLoginProfilesCount: parseSiteLoginProfiles(env.SITE_LOGIN_PROFILES_JSON)
      ? Object.keys(parseSiteLoginProfiles(env.SITE_LOGIN_PROFILES_JSON)).length
      : 0,
  }
}

export async function resolveServerConfig(
  config: ServerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerConfig> {
  if (!config.siteLoginProfilesRepo) {
    return config
  }

  try {
    const remoteProfiles = await fetchGitHubRepoTextFile(
      config.siteLoginProfilesRepo,
      fetchImpl,
    )

    return {
      ...config,
      siteLoginProfiles: parseSiteLoginProfiles(remoteProfiles.raw),
      siteLoginProfilesRepo: null,
      siteLoginProfilesSource: remoteProfiles.source,
      siteLoginProfilesCount: Object.keys(
        parseSiteLoginProfiles(remoteProfiles.raw),
      ).length,
    }
  } catch (error) {
    if (error instanceof GitHubRepoFileHttpError) {
      throw new Error(`GitHub 登录 profile 下载失败，HTTP ${error.status}`)
    }
    throw error
  }
}
