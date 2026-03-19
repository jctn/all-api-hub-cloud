export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/u, "")
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`
}
