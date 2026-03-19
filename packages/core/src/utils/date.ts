export function toLocalDayKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function formatTimestamp(timestamp: unknown): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "unknown"
  }

  return new Date(timestamp).toLocaleString()
}
