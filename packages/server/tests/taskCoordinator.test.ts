import { describe, expect, it, vi } from "vitest"

import { PostgresAdvisoryLockProvider } from "../src/storage/advisoryLock.js"
import { BusyTaskError, TaskCoordinator } from "../src/taskCoordinator.js"

describe("TaskCoordinator", () => {
  it("runs tasks exclusively with an async lock provider", async () => {
    const release = vi.fn(async () => undefined)
    const coordinator = new TaskCoordinator({
      acquire: async () => ({
        release,
      }),
    })

    const task = coordinator.startExclusive(
      "sync_import",
      "同步导入",
      async () => "ok",
    )

    await expect(task).resolves.toBe("ok")
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("returns a promise that rejects with the task error", async () => {
    const coordinator = new TaskCoordinator()

    const task = coordinator.startExclusive("sync_import", "同步导入", async () => {
      throw new Error("boom")
    })

    await expect(task).rejects.toThrow("boom")
  })

  it("throws BusyTaskError when the distributed lock is unavailable", async () => {
    const coordinator = new TaskCoordinator({
      acquire: async () => null,
    })

    await expect(
      coordinator.startExclusive("checkin_all", "批量签到", async () => "ok"),
    ).rejects.toBeInstanceOf(BusyTaskError)
  })
})

describe("PostgresAdvisoryLockProvider", () => {
  it("acquires and releases advisory locks through a dedicated client", async () => {
    const release = vi.fn()
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ locked: true }],
      })
      .mockResolvedValueOnce({
        rows: [],
      })

    const provider = new PostgresAdvisoryLockProvider({
      connect: async () => ({
        query,
        release,
      }),
      query: vi.fn(),
      end: vi.fn(async () => undefined),
    })

    const handle = await provider.acquire()
    expect(handle).not.toBeNull()

    await handle?.release()
    expect(query).toHaveBeenNthCalledWith(
      1,
      "SELECT pg_try_advisory_lock($1) AS locked",
      [101327],
    )
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT pg_advisory_unlock($1)",
      [101327],
    )
    expect(release).toHaveBeenCalledTimes(1)
  })
})
