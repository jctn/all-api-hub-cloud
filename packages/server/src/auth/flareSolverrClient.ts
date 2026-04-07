export interface FlareSolverrCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: string
}

interface FlareSolverrResponse {
  status?: string
  message?: string
  solution?: {
    url?: string
    status?: number
    cookies?: FlareSolverrCookie[]
    userAgent?: string
  }
}

export interface FlareSolverrResult {
  cookies: FlareSolverrCookie[]
  userAgent: string
}

export interface SolveCloudflareChallengeOptions {
  maxTimeoutMs?: number
  requestTimeoutMs?: number
}

const DEFAULT_REQUEST_TIMEOUT_MS = 90_000
const DEFAULT_MAX_TIMEOUT_MS = 60_000

export async function solveCloudflareChallenge(
  serviceUrl: string,
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
  onLog?: (msg: string) => void,
  options?: SolveCloudflareChallengeOptions,
): Promise<FlareSolverrResult | null> {
  const log = onLog ?? (() => {})
  const endpoint = `${serviceUrl.replace(/\/+$/, "")}/v1`
  const maxTimeoutMs = options?.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS
  const requestTimeoutMs =
    options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  log(`POST ${endpoint} url=${targetUrl}`)
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cmd: "request.get",
        url: targetUrl,
        maxTimeout: maxTimeoutMs,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      log(`HTTP ${res.status} ${text.slice(0, 200)}`)
      return null
    }

    const data = (await res.json()) as FlareSolverrResponse

    if (data.status !== "ok") {
      log(`状态异常: status=${data.status} message=${data.message}`)
      return null
    }

    const cookies = data.solution?.cookies
    if (!cookies?.length) {
      log("求解成功但未返回 cookie")
      return null
    }

    log(`获取 ${cookies.length} 个 cookie`)
    return { cookies, userAgent: data.solution?.userAgent ?? "" }
  } catch (err) {
    log(`请求失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
