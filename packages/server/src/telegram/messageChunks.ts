const TELEGRAM_MESSAGE_LIMIT = 3500

export function splitTelegramMessage(
  text: string,
  maxLength = TELEGRAM_MESSAGE_LIMIT,
): string[] {
  const normalized = text.trim()
  if (!normalized) {
    return [""]
  }

  const chunks: string[] = []
  let remaining = normalized

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength)
    if (splitIndex < Math.floor(maxLength / 2)) {
      splitIndex = remaining.lastIndexOf(" ", maxLength)
    }
    if (splitIndex < Math.floor(maxLength / 2)) {
      splitIndex = maxLength
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd())
    remaining = remaining.slice(splitIndex).trimStart()
  }

  chunks.push(remaining)
  return chunks
}

export function truncateTelegramLine(
  value: string,
  maxLength = 180,
): string {
  const normalized = value.trim()
  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}
