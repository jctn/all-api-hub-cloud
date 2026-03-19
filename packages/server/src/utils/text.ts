export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

export function formatTimestamp(
  value: number | null | undefined,
  timeZone = "Asia/Shanghai",
): string {
  if (!value) {
    return "未记录"
  }

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value))
}

export function sanitizeFileName(value: string): string {
  return value.replace(/[^a-z0-9-_]+/giu, "-").replace(/-+/gu, "-")
}
