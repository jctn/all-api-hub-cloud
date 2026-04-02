import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileSystemRepository } from "@all-api-hub/core"
import type { UserFromGetMe } from "grammy/types"

import { InMemoryLocalWorkerTaskStore } from "../src/localWorker/taskStore.js"
import { buildServer, type BuildServerOptions } from "../src/server.js"

const tempDirectories: string[] = []
const testBotInfo: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})

async function createServer(options: Partial<BuildServerOptions> = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aah-server-app-"))
  tempDirectories.push(directory)

  const repository = new FileSystemRepository(directory)
  const localWorkerTaskStore = new InMemoryLocalWorkerTaskStore()
  const server = await buildServer({
    repository,
    localWorkerTaskStore,
    config: {
      port: 3000,
      databaseUrl: "postgres://user:pass@localhost:5432/all_api_hub",
      dataDirectory: directory,
      diagnosticsDirectory: path.join(directory, "diagnostics"),
      sharedSsoProfileDirectory: path.join(directory, "profiles", "cloud"),
      internalAdminToken: "internal-token",
      localWorkerToken: "local-worker-token",
      telegram: {
        botToken: "123456:ABCDEF",
        webhookSecret: "tg-secret",
        adminChatId: "10001",
      },
      importRepo: {
        owner: "owner",
        name: "repo",
        path: "accounts.json",
        ref: "main",
        githubPat: "pat",
      },
      github: {
        username: "user",
        password: "pass",
        totpSecret: "JBSWY3DPEHPK3PXP",
        linuxdoBaseUrl: "https://linux.do",
      },
      flareSolverrUrl: null,
      siteLoginProfiles: {},
      timeZone: "Asia/Shanghai",
      appVersion: "0.1.0",
      deploymentVersion: "0.1.0+test123",
      gitCommitSha: "test1234567890",
      gitCommitShortSha: "test123",
      gitBranch: "main",
      gitCommitMessage: "Test deployment",
      siteLoginProfilesSource: "github://owner/repo/site-login-profiles.json@main",
      siteLoginProfilesCount: 2,
    },
    fetchImpl: async () => new Response("{}", { status: 200 }),
    telegramBotInfo: testBotInfo,
    ...options,
  })

  return server
}

describe("server routes", () => {
  it("returns health information", async () => {
    const server = await createServer()
    const response = await server.inject({
      method: "GET",
      url: "/internal/healthz",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      version: "0.1.0+test123",
      appVersion: "0.1.0",
      gitCommitShortSha: "test123",
      gitBranch: "main",
      siteLoginProfilesSource: "github://owner/repo/site-login-profiles.json@main",
      siteLoginProfilesCount: 2,
      storageMode: "filesystem",
    })
  })

  it("rejects telegram webhook requests with an invalid secret", async () => {
    const server = await createServer()
    const response = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "wrong",
      },
      payload: {},
    })

    expect(response.statusCode).toBe(403)
  })

  it("accepts telegram webhook requests with a valid secret", async () => {
    const server = await createServer()
    const response = await server.inject({
      method: "POST",
      url: "/telegram/webhook",
      headers: {
        "x-telegram-bot-api-secret-token": "tg-secret",
      },
      payload: {
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: {
            id: 10001,
            type: "private",
          },
          from: {
            id: 10001,
            is_bot: false,
            first_name: "Admin",
          },
          text: "hello",
        },
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
    })
  })

  it("rejects internal requests without the bearer token", async () => {
    const server = await createServer()
    const response = await server.inject({
      method: "POST",
      url: "/internal/import/sync",
    })

    expect(response.statusCode).toBe(401)
  })

  it("rejects worker task claim requests without the worker token", async () => {
    const server = await createServer()
    const response = await server.inject({
      method: "POST",
      url: "/internal/worker/tasks/claim",
    })

    expect(response.statusCode).toBe(401)
  })

  it("allows a local worker to claim, update and finish a task", async () => {
    const server = await createServer()

    const enqueueResponse = await server.inject({
      method: "POST",
      url: "/internal/worker/tasks/enqueue",
      headers: {
        authorization: "Bearer internal-token",
      },
      payload: {
        kind: "checkin",
        scope: "single",
        requestedBy: "test",
        chatId: "10001",
        verbose: true,
        payload: {
          accountIds: ["account-1"],
          accounts: [
            {
              id: "account-1",
              siteName: "RunAnytime",
              siteUrl: "https://runanytime.example.com",
              siteType: "new-api",
            },
          ],
        },
      },
    })

    expect(enqueueResponse.statusCode).toBe(200)

    const claimResponse = await server.inject({
      method: "POST",
      url: "/internal/worker/tasks/claim",
      headers: {
        authorization: "Bearer local-worker-token",
      },
      payload: {
        workerId: "local-browser-1",
      },
    })

    expect(claimResponse.statusCode).toBe(200)
    expect(claimResponse.json()).toMatchObject({
      ok: true,
      task: {
        status: "claimed",
        workerId: "local-browser-1",
        kind: "checkin",
      },
    })

    const taskId = claimResponse.json().task.id as string

    const progressResponse = await server.inject({
      method: "POST",
      url: `/internal/worker/tasks/${taskId}/progress`,
      headers: {
        authorization: "Bearer local-worker-token",
      },
      payload: {
        workerId: "local-browser-1",
        status: "running",
        progressText: "浏览器已启动",
        heartbeatAt: 123,
      },
    })

    expect(progressResponse.statusCode).toBe(200)
    expect(progressResponse.json()).toMatchObject({
      ok: true,
      task: {
        id: taskId,
        status: "running",
        progressText: "浏览器已启动",
      },
    })

    const finishResponse = await server.inject({
      method: "POST",
      url: `/internal/worker/tasks/${taskId}/finish`,
      headers: {
        authorization: "Bearer local-worker-token",
      },
      payload: {
        workerId: "local-browser-1",
        status: "succeeded",
        finishedAt: 456,
        resultJson: {
          startedAt: 123,
          completedAt: 456,
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
      },
    })

    expect(finishResponse.statusCode).toBe(200)
    expect(finishResponse.json()).toMatchObject({
      ok: true,
      task: {
        id: taskId,
        status: "succeeded",
        finishedAt: 456,
      },
    })
  })
})
