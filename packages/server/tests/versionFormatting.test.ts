import { describe, expect, it } from "vitest"

import { formatVersionMessage } from "../src/telegram/formatting.js"

describe("formatVersionMessage", () => {
  it("renders deployment and profile source details", () => {
    const message = formatVersionMessage({
      deploymentVersion: "0.1.0+abc1234",
      appVersion: "0.1.0",
      gitCommitShortSha: "abc1234",
      gitBranch: "main",
      gitCommitMessage: "Ship version command",
      siteLoginProfilesSource:
        "github://jctn/all-api-hub-private-data/site-login-profiles.json@main",
      siteLoginProfilesCount: 2,
    })

    expect(message).toContain("服务版本: 0.1.0+abc1234")
    expect(message).toContain("部署提交: main@abc1234")
    expect(message).toContain("提交说明: Ship version command")
    expect(message).toContain(
      "登录 profile 来源: github://jctn/all-api-hub-private-data/site-login-profiles.json@main",
    )
    expect(message).toContain("登录 profile 数量: 2")
  })
})
