import { describe, expect, it } from "vitest"

import { generateGitHubTotp } from "../src/auth/githubTotp.js"

describe("generateGitHubTotp", () => {
  it("returns a six digit code", () => {
    const code = generateGitHubTotp("JBSWY3DPEHPK3PXP")
    expect(code).toMatch(/^\d{6}$/u)
  })
})
