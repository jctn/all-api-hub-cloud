import { describe, expect, it, vi } from "vitest"

import {
  createBatchCheckinProgressReporter,
  shouldBroadcastBatchCheckinProgress,
} from "../src/telegram/bot.js"

describe("batch checkin progress reporter", () => {
  it("marks high-signal batch progress messages for telegram delivery", () => {
    expect(
      shouldBroadcastBatchCheckinProgress(
        "签到进度 (3/20)：随时跑路公益站 (account-1)",
      ),
    ).toBe(true)
    expect(
      shouldBroadcastBatchCheckinProgress("本地浏览器任务已入队：task-123"),
    ).toBe(true)
    expect(
      shouldBroadcastBatchCheckinProgress(
        "[本地浏览器] [随时跑路公益站] 命中本地 FlareSolverr 预热策略",
      ),
    ).toBe(true)
    expect(
      shouldBroadcastBatchCheckinProgress("调用 /api/user/self 校验登录状态"),
    ).toBe(false)
  })

  it("only forwards selected progress in non-verbose mode while still appending logs", async () => {
    const append = vi.fn(async () => undefined)
    const send = vi.fn(async () => undefined)
    const report = createBatchCheckinProgressReporter({
      verbose: false,
      append,
      send,
    })

    await report("调用 /api/user/self 校验登录状态")
    await report("签到进度 (1/20)：随时跑路公益站 (account-1)")

    expect(append).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      "签到进度 (1/20)：随时跑路公益站 (account-1)",
    )
  })

  it("forwards all progress in verbose mode", async () => {
    const send = vi.fn(async () => undefined)
    const report = createBatchCheckinProgressReporter({
      verbose: true,
      send,
    })

    await report("调用 /api/user/self 校验登录状态")

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith("调用 /api/user/self 校验登录状态")
  })
})
