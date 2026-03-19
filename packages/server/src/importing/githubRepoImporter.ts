import {
  importBackupIntoRepository,
  type BackupImportResult,
  type StorageRepository,
} from "@all-api-hub/core"

import type { ImportRepoConfig } from "../config.js"

interface GitHubContentsResponse {
  sha: string
  content?: string
  encoding?: string
  download_url?: string
}

export interface GitHubImportSyncResult {
  skipped: boolean
  sha: string
  source: string
  importedAt: number
  result?: BackupImportResult
}

export class GitHubBackupImporter {
  constructor(
    private readonly repository: StorageRepository,
    private readonly config: ImportRepoConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async syncFromRepo(): Promise<GitHubImportSyncResult> {
    const settings = await this.repository.getSettings()
    const response = await this.fetchContents()
    const source = `github://${this.config.owner}/${this.config.name}/${this.config.path}@${this.config.ref}`

    if (
      settings.lastImportedCommitSha &&
      settings.lastImportedCommitSha === response.sha
    ) {
      return {
        skipped: true,
        sha: response.sha,
        source,
        importedAt: settings.lastImportedAt ?? Date.now(),
      }
    }

    const raw = await this.resolveRawContent(response)
    const result = await importBackupIntoRepository({
      repository: this.repository,
      raw,
      sourcePath: source,
    })
    const importedAt = Date.now()
    await this.repository.saveSettings({
      lastImportPath: source,
      lastImportedAt: importedAt,
      lastImportedCommitSha: response.sha,
    })

    return {
      skipped: false,
      sha: response.sha,
      source,
      importedAt,
      result,
    }
  }

  private async fetchContents(): Promise<GitHubContentsResponse> {
    const url = new URL(
      `https://api.github.com/repos/${this.config.owner}/${this.config.name}/contents/${this.config.path}`,
    )
    url.searchParams.set("ref", this.config.ref)

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.githubPat}`,
        "User-Agent": "all-api-hub-server",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    })

    if (!response.ok) {
      throw new Error(`GitHub 导入失败，HTTP ${response.status}`)
    }

    return (await response.json()) as GitHubContentsResponse
  }

  private async resolveRawContent(
    response: GitHubContentsResponse,
  ): Promise<string> {
    if (response.content && response.encoding === "base64") {
      return Buffer.from(response.content.replace(/\s+/gu, ""), "base64").toString(
        "utf8",
      )
    }

    if (!response.download_url) {
      throw new Error("GitHub 返回内容缺少 content/download_url")
    }

    const rawResponse = await this.fetchImpl(response.download_url, {
      headers: {
        Authorization: `Bearer ${this.config.githubPat}`,
        "User-Agent": "all-api-hub-server",
      },
    })

    if (!rawResponse.ok) {
      throw new Error(`GitHub raw 下载失败，HTTP ${rawResponse.status}`)
    }

    return await rawResponse.text()
  }
}
