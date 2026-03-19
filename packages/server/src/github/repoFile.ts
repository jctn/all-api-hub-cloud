export interface GitHubRepoFileConfig {
  owner: string
  name: string
  path: string
  ref: string
  githubPat: string
}

interface GitHubContentsResponse {
  sha: string
  content?: string
  encoding?: string
  download_url?: string
}

export interface GitHubRepoFileResult {
  sha: string
  raw: string
  source: string
}

export class GitHubRepoFileHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub 文件下载失败，HTTP ${status}`)
  }
}

export async function fetchGitHubRepoTextFile(
  config: GitHubRepoFileConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubRepoFileResult> {
  const response = await fetchContents(config, fetchImpl)
  const raw = await resolveRawContent(response, config, fetchImpl)

  return {
    sha: response.sha,
    raw,
    source: `github://${config.owner}/${config.name}/${config.path}@${config.ref}`,
  }
}

async function fetchContents(
  config: GitHubRepoFileConfig,
  fetchImpl: typeof fetch,
): Promise<GitHubContentsResponse> {
  const url = new URL(
    `https://api.github.com/repos/${config.owner}/${config.name}/contents/${config.path}`,
  )
  url.searchParams.set("ref", config.ref)

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubPat}`,
      "User-Agent": "all-api-hub-server",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  })

  if (!response.ok) {
    throw new GitHubRepoFileHttpError(response.status)
  }

  return (await response.json()) as GitHubContentsResponse
}

async function resolveRawContent(
  response: GitHubContentsResponse,
  config: GitHubRepoFileConfig,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (response.content && response.encoding === "base64") {
    return Buffer.from(response.content.replace(/\s+/gu, ""), "base64").toString(
      "utf8",
    )
  }

  if (!response.download_url) {
    throw new Error(
      `GitHub 返回内容缺少 content/download_url: ${config.owner}/${config.name}/${config.path}@${config.ref}`,
    )
  }

  const rawResponse = await fetchImpl(response.download_url, {
    headers: {
      Authorization: `Bearer ${config.githubPat}`,
      "User-Agent": "all-api-hub-server",
    },
  })

  if (!rawResponse.ok) {
    throw new GitHubRepoFileHttpError(rawResponse.status)
  }

  return await rawResponse.text()
}
