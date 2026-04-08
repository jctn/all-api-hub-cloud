import {
  importBackupIntoRepository,
  type BackupImportResult,
  type StorageRepository,
} from "@all-api-hub/core"

import type { ImportRepoConfig } from "../config.js"
import {
  fetchGitHubRepoTextFile,
  GitHubRepoFileHttpError,
} from "../github/repoFile.js"

export interface GitHubImportSyncResult {
  skipped: boolean
  sha: string
  source: string
  importedAt: number
  result?: BackupImportResult
}

export interface GitHubImportSyncOptions {
  force?: boolean
}

export class GitHubBackupImporter {
  constructor(
    private readonly repository: StorageRepository,
    private readonly config: ImportRepoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async syncFromRepo(
    options: GitHubImportSyncOptions = {},
  ): Promise<GitHubImportSyncResult> {
    const settings = await this.repository.getSettings()
    let sourceFile
    try {
      sourceFile = await fetchGitHubRepoTextFile(this.config, this.fetchImpl)
    } catch (error) {
      if (error instanceof GitHubRepoFileHttpError) {
        throw new Error(`GitHub 导入失败，HTTP ${error.status}`)
      }
      throw error
    }

    if (
      !options.force &&
      settings.lastImportedCommitSha &&
      settings.lastImportedCommitSha === sourceFile.sha
    ) {
      return {
        skipped: true,
        sha: sourceFile.sha,
        source: sourceFile.source,
        importedAt: settings.lastImportedAt ?? Date.now(),
      }
    }

    const result = await importBackupIntoRepository({
      repository: this.repository,
      raw: sourceFile.raw,
      sourcePath: sourceFile.source,
    })
    const importedAt = Date.now()
    await this.repository.saveSettings({
      lastImportPath: sourceFile.source,
      lastImportedAt: importedAt,
      lastImportedCommitSha: sourceFile.sha,
    })

    return {
      skipped: false,
      sha: sourceFile.sha,
      source: sourceFile.source,
      importedAt,
      result,
    }
  }
}
