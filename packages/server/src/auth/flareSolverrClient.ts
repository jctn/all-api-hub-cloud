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

const REQUEST_TIMEOUT_MS = 90_000

export async function solveCloudflareChallenge(
  serviceUrl: string,
  targetUrl: string,
  fetchImpl: typeof fetch = fetch,
  onLog?: (msg: string) => void,
): Promise<FlareSolverrCookie[] | null> {
  const log = onLog ?? (() => {})
  const endpoint = `${serviceUrl.replace(/\/+$/, "")}/v1`

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
        maxTimeout: 60_000,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    return cookies
  } catch (err) {
    log(`请求失败: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
