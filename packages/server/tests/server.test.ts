import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileSystemRepository } from "@all-api-hub/core"
import type { UserFromGetMe } from "grammy/types"

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
  const server = await buildServer({
    repository,
    config: {
      port: 3000,
      databaseUrl: "postgres://user:pass@localhost:5432/all_api_hub",
      dataDirectory: directory,
      diagnosticsDirectory: path.join(directory, "diagnostics"),
      sharedSsoProfileDirectory: path.join(directory, "profiles", "cloud"),
      internalAdminToken: "internal-token",
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
      siteLoginProfiles: {},
      timeZone: "Asia/Shanghai",
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
})
