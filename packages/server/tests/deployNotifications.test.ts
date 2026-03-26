import { describe, expect, it, vi } from "vitest"

describe("deployment notifications", () => {
  it("sends runtime stage notifications to the current admin private chat", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const errorMock = vi.fn()

    const { notifyRuntimeDeploymentStage } = await import("../src/telegram/deployNotifier.js")

    await notifyRuntimeDeploymentStage({
      config: {
        telegram: {
          botToken: "123456:token",
          adminChatId: "10001",
        },
        timeZone: "Asia/Shanghai",
        deploymentVersion: "0.1.0+abcdef0",
        gitBranch: "main",
        gitCommitShortSha: "abcdef0",
        gitCommitMessage: "Deploy server",
      },
      stage: "running",
      address: "http://0.0.0.0:3000",
      fetchImpl: fetchMock,
      logger: {
        error: errorMock,
      },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe("https://api.telegram.org/bot123456:token/sendMessage")

    const body = JSON.parse(String(init?.body)) as {
      chat_id: string
      text: string
    }
    expect(body.chat_id).toBe("10001")
    expect(body.text.startsWith("[部署通知]")).toBe(true)
    expect(body.text).toContain("运行中")
    expect(body.text).toContain("0.1.0+abcdef0")
    expect(body.text).toContain("main@abcdef0")
    expect(errorMock).not.toHaveBeenCalled()
  })

  it("formats build-stage notifications with the deployment prefix", async () => {
    const { formatBuildStageMessage } = await import("../scripts/zeabur-build-notify.mjs")

    const previousEnv = {
      ZEABUR_GIT_BRANCH: process.env.ZEABUR_GIT_BRANCH,
      ZEABUR_GIT_COMMIT_SHA: process.env.ZEABUR_GIT_COMMIT_SHA,
      ZEABUR_GIT_COMMIT_MESSAGE: process.env.ZEABUR_GIT_COMMIT_MESSAGE,
      ZEABUR_SERVICE_NAME: process.env.ZEABUR_SERVICE_NAME,
      TZ: process.env.TZ,
    }

    process.env.ZEABUR_GIT_BRANCH = "main"
    process.env.ZEABUR_GIT_COMMIT_SHA = "abcdef0123456789"
    process.env.ZEABUR_GIT_COMMIT_MESSAGE = "Deploy server"
    process.env.ZEABUR_SERVICE_NAME = "all-api-hub-server"
    process.env.TZ = "Asia/Shanghai"

    try {
      const message = formatBuildStageMessage("build_started")
      expect(message.startsWith("[部署通知]")).toBe(true)
      expect(message).toContain("开始构建")
      expect(message).toContain("main@abcdef0")
    } finally {
      process.env.ZEABUR_GIT_BRANCH = previousEnv.ZEABUR_GIT_BRANCH
      process.env.ZEABUR_GIT_COMMIT_SHA = previousEnv.ZEABUR_GIT_COMMIT_SHA
      process.env.ZEABUR_GIT_COMMIT_MESSAGE = previousEnv.ZEABUR_GIT_COMMIT_MESSAGE
      process.env.ZEABUR_SERVICE_NAME = previousEnv.ZEABUR_SERVICE_NAME
      process.env.TZ = previousEnv.TZ
    }
  })

  it("keeps the build result authoritative even when Telegram notifications fail", async () => {
    const warnMock = vi.fn()
    const notifyMock = vi
      .fn<(_: "build_started" | "build_succeeded" | "build_failed", error?: unknown) => Promise<void>>()
      .mockRejectedValue(new Error("telegram unavailable"))
    const buildMock = vi.fn(async () => {})

    const { runBuildWithNotifications } = await import("../scripts/zeabur-build-notify.mjs")

    await expect(
      runBuildWithNotifications({
        notify: notifyMock,
        build: buildMock,
        logger: {
          warn: warnMock,
        },
      }),
    ).resolves.toBeUndefined()

    expect(buildMock).toHaveBeenCalledTimes(1)
    expect(notifyMock.mock.calls.map(([stage]) => stage)).toEqual([
      "build_started",
      "build_succeeded",
    ])
    expect(warnMock).toHaveBeenCalled()
  })
})
