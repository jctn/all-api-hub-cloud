import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { FileSystemRepository } from "@all-api-hub/core"

import { GitHubBackupImporter } from "../src/importing/githubRepoImporter.js"

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true })
    }),
  )
})

async function createRepository() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aah-server-import-"))
  tempDirectories.push(directory)

  const repository = new FileSystemRepository(directory)
  await repository.initialize()
  return repository
}

const backupPayload = JSON.stringify({
  accounts: [
    {
      id: "acc-1",
      site_name: "Demo",
      site_url: "https://demo.example.com",
      site_type: "new-api",
      account_info: {
        id: 1,
        access_token: "token",
        username: "alice",
      },
      authType: "access_token",
      checkIn: {
        enableDetection: true,
      },
    },
  ],
})

describe("GitHubBackupImporter", () => {
  it("imports the repo json and saves the last imported sha", async () => {
    const repository = await createRepository()
    const importer = new GitHubBackupImporter(
      repository,
      {
        owner: "owner",
        name: "repo",
        path: "accounts.json",
        ref: "main",
        githubPat: "pat",
      },
      async () =>
        new Response(
          JSON.stringify({
            sha: "sha-1",
            content: Buffer.from(backupPayload).toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    )

    const result = await importer.syncFromRepo()
    const accounts = await repository.getAccounts()
    const settings = await repository.getSettings()

    expect(result.skipped).toBe(false)
    expect(accounts).toHaveLength(1)
    expect(settings.lastImportedCommitSha).toBe("sha-1")
  })

  it("skips importing when the sha is unchanged", async () => {
    const repository = await createRepository()
    await repository.saveSettings({
      lastImportedCommitSha: "sha-1",
      lastImportedAt: 123,
    })

    const importer = new GitHubBackupImporter(
      repository,
      {
        owner: "owner",
        name: "repo",
        path: "accounts.json",
        ref: "main",
        githubPat: "pat",
      },
      async () =>
        new Response(
          JSON.stringify({
            sha: "sha-1",
            content: Buffer.from(backupPayload).toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    )

    const result = await importer.syncFromRepo()
    expect(result.skipped).toBe(true)
    expect(result.importedAt).toBe(123)
  })

  it("forces reimport when the sha is unchanged and force is enabled", async () => {
    const repository = await createRepository()
    await repository.saveSettings({
      lastImportedCommitSha: "sha-1",
      lastImportedAt: 123,
    })

    const importer = new GitHubBackupImporter(
      repository,
      {
        owner: "owner",
        name: "repo",
        path: "accounts.json",
        ref: "main",
        githubPat: "pat",
      },
      async () =>
        new Response(
          JSON.stringify({
            sha: "sha-1",
            content: Buffer.from(
              JSON.stringify({
                accounts: [
                  {
                    id: "acc-2",
                    site_name: "Forced Demo",
                    site_url: "https://forced.example.com",
                    site_type: "new-api",
                    account_info: {
                      id: 2,
                      access_token: "token-2",
                      username: "bob",
                    },
                    authType: "access_token",
                    checkIn: {
                      enableDetection: true,
                    },
                  },
                ],
              }),
            ).toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    )

    const result = await importer.syncFromRepo({ force: true })
    const accounts = await repository.getAccounts()
    const settings = await repository.getSettings()

    expect(result.skipped).toBe(false)
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.id).toBe("acc-2")
    expect(settings.lastImportedCommitSha).toBe("sha-1")
    expect(settings.lastImportedAt).not.toBe(123)
  })
})
