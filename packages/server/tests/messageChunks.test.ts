import { describe, expect, it } from "vitest"

import {
  splitTelegramMessage,
  truncateTelegramLine,
} from "../src/telegram/messageChunks.js"

describe("splitTelegramMessage", () => {
  it("keeps short messages as a single chunk", () => {
    expect(splitTelegramMessage("hello world")).toEqual(["hello world"])
  })

  it("splits long messages into telegram-safe chunks", () => {
    const text = Array.from({ length: 1200 }, (_, index) => `line-${index}`)
      .join("\n")
    const chunks = splitTelegramMessage(text, 300)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true)
    expect(chunks.join("\n")).toContain("line-0")
    expect(chunks.join("\n")).toContain("line-1199")
  })
})

describe("truncateTelegramLine", () => {
  it("shortens long lines with an ellipsis", () => {
    expect(truncateTelegramLine("x".repeat(20), 10)).toBe("xxxxxxxxx…")
  })
})
