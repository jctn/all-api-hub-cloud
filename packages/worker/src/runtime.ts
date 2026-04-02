import fs from "node:fs/promises"
import path from "node:path"

import {
  FileSystemRepository,
  importBackupIntoRepository,
} from "@all-api-hub/core"
import {
  parseSiteLoginProfiles,
  type SiteLoginProfileMap,
} from "@all-api-hub/browser"

export interface WorkerRuntimePaths {
  dataDirectory: string
  diagnosticsDirectory: string
  logsDirectory: string
  profilesDirectory: string
  siteProfilesRoot: string
  siteProfileDirectory(accountId: string): string
}

export interface WorkerRuntime {
  repository: FileSystemRepository
  siteLoginProfiles: SiteLoginProfileMap
  paths: WorkerRuntimePaths
}

async function readJsonFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null
    }
    throw error
  }
}

export async function initializeWorkerRuntime(params: {
  privateDataDirectory: string
  dataDirectory: string
}): Promise<WorkerRuntime> {
  const diagnosticsDirectory = path.join(params.dataDirectory, "diagnostics")
  const logsDirectory = path.join(params.dataDirectory, "logs")
  const profilesDirectory = path.join(params.dataDirectory, "profiles")
  const siteProfilesRoot = path.join(profilesDirectory, "sites")

  await Promise.all([
    fs.mkdir(params.dataDirectory, { recursive: true }),
    fs.mkdir(diagnosticsDirectory, { recursive: true }),
    fs.mkdir(logsDirectory, { recursive: true }),
    fs.mkdir(siteProfilesRoot, { recursive: true }),
  ])

  const repository = new FileSystemRepository(params.dataDirectory)
  await repository.initialize()

  const backupFilePath = path.join(
    params.privateDataDirectory,
    "all-api-hub-backup.json",
  )
  const siteLoginProfilesPath = path.join(
    params.privateDataDirectory,
    "site-login-profiles.json",
  )

  const [backupRaw, siteLoginProfilesRaw, existingAccounts] = await Promise.all([
    readJsonFileIfExists(backupFilePath),
    readJsonFileIfExists(siteLoginProfilesPath),
    repository.getAccounts(),
  ])

  if (backupRaw && existingAccounts.length === 0) {
    await importBackupIntoRepository({
      repository,
      raw: backupRaw,
      sourcePath: backupFilePath,
    })
  }

  return {
    repository,
    siteLoginProfiles: parseSiteLoginProfiles(siteLoginProfilesRaw),
    paths: {
      dataDirectory: params.dataDirectory,
      diagnosticsDirectory,
      logsDirectory,
      profilesDirectory,
      siteProfilesRoot,
      siteProfileDirectory(accountId: string) {
        return path.join(siteProfilesRoot, accountId)
      },
    },
  }
}
