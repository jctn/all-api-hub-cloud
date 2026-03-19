import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  FileSystemRepository,
  HealthState,
} from "../src/index.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true })
    }),
  )
})

describe("FileSystemRepository", () => {
  it("persists accounts and check-in history in shared files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aah-core-"))
    tempDirs.push(tempDir)

    const repository = new FileSystemRepository(tempDir)
    await repository.initialize()

    await repository.saveAccount({
      id: "a1",
      site_name: "Demo",
      site_url: "https://demo.example.com",
      site_type: "new-api",
      health: { status: HealthState.Healthy },
      exchange_rate: 7.2,
      account_info: {
        id: 1,
        access_token: "token",
        username: "demo",
        quota: 0,
        today_prompt_tokens: 0,
        today_completion_tokens: 0,
        today_quota_consumption: 0,
        today_requests_count: 0,
        today_income: 0,
      },
      last_sync_time: 1,
      updated_at: 1,
      created_at: 1,
      notes: "",
      tagIds: [],
      disabled: false,
      excludeFromTotalBalance: false,
      authType: AuthType.AccessToken,
      checkIn: { enableDetection: true },
    })

    await repository.appendHistory({
      id: "run-1",
      initiatedBy: "cli",
      targetAccountIds: null,
      startedAt: 1,
      completedAt: 2,
      summary: {
        total: 1,
        success: 1,
        alreadyChecked: 0,
        failed: 0,
        manualActionRequired: 0,
        skipped: 0,
      },
      results: [
        {
          accountId: "a1",
          siteName: "Demo",
          siteUrl: "https://demo.example.com",
          siteType: "new-api",
          status: CheckinResultStatus.Success,
          message: "ok",
          startedAt: 1,
          completedAt: 2,
        },
      ],
    })

    const accounts = await repository.getAccounts()
    const history = await repository.getHistory()

    expect(accounts).toHaveLength(1)
    expect(history.records).toHaveLength(1)
    expect(history.accountStates.a1.lastStatus).toBe(CheckinResultStatus.Success)
  })

  it("recovers from a stale accounts lock file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "aah-core-"))
    tempDirs.push(tempDir)

    const repository = new FileSystemRepository(tempDir)
    await repository.initialize()

    const lockFilePath = path.join(tempDir, "accounts.json.lock")
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000)

    await fs.writeFile(lockFilePath, "", "utf8")
    await fs.utimes(lockFilePath, staleTimestamp, staleTimestamp)

    const saved = await repository.saveAccount({
      id: "stale-lock-account",
      site_name: "Locked Demo",
      site_url: "https://locked.example.com",
      site_type: "new-api",
      health: { status: HealthState.Healthy },
      exchange_rate: 7.2,
      account_info: {
        id: 2,
        access_token: "token",
        username: "locked",
        quota: 0,
        today_prompt_tokens: 0,
        today_completion_tokens: 0,
        today_quota_consumption: 0,
        today_requests_count: 0,
        today_income: 0,
      },
      last_sync_time: 1,
      updated_at: 1,
      created_at: 1,
      notes: "",
      tagIds: [],
      disabled: false,
      excludeFromTotalBalance: false,
      authType: AuthType.AccessToken,
      checkIn: { enableDetection: true },
    })

    expect(saved.id).toBe("stale-lock-account")
    await expect(fs.access(lockFilePath)).rejects.toThrow()
    await expect(repository.getAccounts()).resolves.toHaveLength(1)
  })
})
