import { randomUUID } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  InMemoryLocalWorkerTaskStore,
  type LocalWorkerTaskPayload,
} from "../src/localWorker/taskStore.js"

function createPayload(
  overrides: Partial<LocalWorkerTaskPayload> = {},
): LocalWorkerTaskPayload {
  return {
    accountIds: overrides.accountIds ?? ["account-1"],
    accounts: overrides.accounts ?? [
      {
        id: "account-1",
        siteName: "RunAnytime",
        siteUrl: "https://runanytime.example.com",
        siteType: "new-api",
      },
    ],
    ...overrides,
  }
}

describe("InMemoryLocalWorkerTaskStore", () => {
  it("runs through queued, claimed, running, waiting_manual and succeeded states", async () => {
    const store = new InMemoryLocalWorkerTaskStore()
    const task = await store.enqueue({
      kind: "checkin",
      scope: "single",
      requestedBy: "telegram",
      chatId: "10001",
      verbose: true,
      payload: createPayload(),
    })

    expect(task.status).toBe("queued")

    const claimed = await store.claimNext("local-browser-1", 1_000)
    expect(claimed).not.toBeNull()
    expect(claimed?.id).toBe(task.id)
    expect(claimed?.status).toBe("claimed")
    expect(claimed?.workerId).toBe("local-browser-1")

    const running = await store.updateProgress(task.id, "local-browser-1", {
      status: "running",
      progressText: "浏览器已启动",
      heartbeatAt: 1_005,
    })
    expect(running?.status).toBe("running")
    expect(running?.progressText).toBe("浏览器已启动")

    const waitingManual = await store.updateProgress(task.id, "local-browser-1", {
      status: "waiting_manual",
      progressText: "等待人工处理 Cloudflare",
      heartbeatAt: 1_010,
    })
    expect(waitingManual?.status).toBe("waiting_manual")
    expect(waitingManual?.progressText).toContain("Cloudflare")

    const finished = await store.finish(task.id, "local-browser-1", {
      status: "succeeded",
      finishedAt: 1_020,
      resultJson: {
        startedAt: 1_000,
        completedAt: 1_020,
        summary: {
          total: 1,
          success: 1,
          alreadyChecked: 0,
          failed: 0,
          manualActionRequired: 0,
          skipped: 0,
        },
        results: [],
      },
    })
    expect(finished?.status).toBe("succeeded")
    expect(finished?.finishedAt).toBe(1_020)
    expect(finished?.resultJson).toMatchObject({
      summary: {
        total: 1,
        success: 1,
      },
    })
  })

  it("does not claim a second task while another task is still active", async () => {
    const store = new InMemoryLocalWorkerTaskStore()
    const first = await store.enqueue({
      kind: "checkin",
      scope: "single",
      requestedBy: "telegram",
      chatId: "10001",
      verbose: false,
      payload: createPayload(),
    })
    await store.enqueue({
      kind: "auth_refresh",
      scope: "batch",
      requestedBy: "telegram",
      chatId: "10001",
      verbose: false,
      payload: createPayload({
        accountIds: ["account-1", "account-2"],
      }),
    })

    const claimed = await store.claimNext("local-browser-1", 2_000)
    expect(claimed?.id).toBe(first.id)
    expect(await store.claimNext("local-browser-1", 2_001)).toBeNull()
  })

  it("expires stale claimed and running tasks", async () => {
    const store = new InMemoryLocalWorkerTaskStore()
    const task = await store.enqueue({
      kind: "checkin",
      scope: "single",
      requestedBy: "telegram",
      chatId: "10001",
      verbose: false,
      payload: createPayload(),
    })

    await store.claimNext("local-browser-1", 10_000)
    await store.expireStaleTasks({
      claimTimeoutBefore: 10_100,
      heartbeatTimeoutBefore: 10_100,
    })

    const expired = await store.getById(task.id)
    expect(expired?.status).toBe("expired")
    expect(expired?.errorCode).toBe("local_worker_offline")
  })

  it("rejects progress and finish updates from a different worker", async () => {
    const store = new InMemoryLocalWorkerTaskStore()
    const task = await store.enqueue({
      kind: "checkin",
      scope: "single",
      requestedBy: "telegram",
      chatId: "10001",
      verbose: false,
      payload: createPayload({
        requestId: randomUUID(),
      }),
    })

    await store.claimNext("local-browser-1", 5_000)

    await expect(
      store.updateProgress(task.id, "other-worker", {
        status: "running",
        progressText: "unexpected",
        heartbeatAt: 5_001,
      }),
    ).rejects.toThrow("Task worker mismatch")

    await expect(
      store.finish(task.id, "other-worker", {
        status: "failed",
        finishedAt: 5_005,
        errorCode: "worker_mismatch",
        errorMessage: "unexpected",
      }),
    ).rejects.toThrow("Task worker mismatch")
  })
})
