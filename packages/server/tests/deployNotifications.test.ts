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
    expect(body.text).toContain("运行中")
    expect(body.text).toContain("0.1.0+abcdef0")
    expect(body.text).toContain("main@abcdef0")
    expect(errorMock).not.toHaveBeenCalled()
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
