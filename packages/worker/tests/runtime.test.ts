import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { initializeWorkerRuntime } from "../src/runtime.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe("initializeWorkerRuntime", () => {
  it("imports seed accounts and site login profiles from the private data directory on first boot", async () => {
    const privateDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aah-private-"))
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "aah-worker-"))
    tempDirectories.push(privateDataDir, dataDir)

    await fs.writeFile(
      path.join(privateDataDir, "all-api-hub-backup.json"),
      JSON.stringify({
        version: "2.0",
        timestamp: 1710000000000,
        accounts: {
          accounts: [
            {
              id: "seed-1",
              site_name: "Seed Site",
              site_url: "https://seed.example.com",
              site_type: "new-api",
              authType: "access_token",
              account_info: {
                id: 1,
                username: "seed",
                access_token: "seed-token",
                quota: 0,
                today_prompt_tokens: 0,
                today_completion_tokens: 0,
                today_quota_consumption: 0,
                today_requests_count: 0,
                today_income: 0,
              },
              checkIn: {
                enableDetection: true,
                autoCheckInEnabled: true,
              },
            },
          ],
        },
      }),
      "utf8",
    )
    await fs.writeFile(
      path.join(privateDataDir, "site-login-profiles.json"),
      JSON.stringify({
        "runanytime.example.com": {
          loginPath: "/auth/login",
          loginButtonSelectors: ["button[data-provider='linuxdo']"],
          successUrlPatterns: ["/console"],
          tokenStorageKeys: ["access_token"],
          postLoginSelectors: [".avatar"],
          executionMode: "local-browser",
        },
      }),
      "utf8",
    )

    const runtime = await initializeWorkerRuntime({
      privateDataDirectory: privateDataDir,
      dataDirectory: dataDir,
    })

    const accounts = await runtime.repository.getAccounts()

    expect(accounts.map((account) => account.id)).toEqual(["seed-1"])
    expect(runtime.siteLoginProfiles["runanytime.example.com"]?.executionMode).toBe(
      "local-browser",
    )
    expect(
      runtime.paths.siteProfileDirectory("seed-1"),
    ).toBe(path.join(dataDir, "profiles", "sites", "seed-1"))
  })
})
