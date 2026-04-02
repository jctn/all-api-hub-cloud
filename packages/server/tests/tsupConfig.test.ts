import { describe, expect, it } from "vitest"

import { resolveServerTsupConfig } from "../tsup.config"

describe("resolveServerTsupConfig", () => {
  it("enables dts by default", () => {
    expect(resolveServerTsupConfig().dts).toBe(true)
  })

  it("disables dts when requested for Zeabur builds", () => {
    expect(resolveServerTsupConfig({ disableDts: true }).dts).toBe(false)
  })
})
