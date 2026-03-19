import { describe, expect, it } from "vitest"

import { previewBackupImport } from "../src/importing/backup.js"

describe("previewBackupImport", () => {
  it("imports V2 account backups and counts unsupported accounts", () => {
    const preview = previewBackupImport(
      JSON.stringify({
        version: "2.0",
        timestamp: 123,
        accounts: {
          accounts: [
            {
              id: "a1",
              site_name: "New API",
              site_url: "https://example.com",
              site_type: "new-api",
              authType: "access_token",
              account_info: { id: 1, username: "alice", access_token: "token-a" },
              checkIn: { enableDetection: true },
            },
            {
              id: "a2",
              site_name: "AnyRouter",
              site_url: "https://anyrouter.example.com",
              site_type: "anyrouter",
              authType: "cookie",
              cookieAuth: { sessionCookie: "sid=abc" },
              account_info: { id: 2, username: "bob", access_token: "" },
              checkIn: { enableDetection: true },
            },
            {
              id: "a3",
              site_name: "WONG公益站",
              site_url: "https://wong.example.com",
              site_type: "wong-gongyi",
              authType: "access_token",
              account_info: { id: 3, username: "wong", access_token: "token-c" },
              checkIn: { enableDetection: true },
            },
          ],
        },
      }),
    )

    expect(preview.accounts).toHaveLength(3)
    expect(preview.summary.importableAccounts).toBe(3)
    expect(preview.summary.unsupportedAccounts).toBe(0)
    expect(preview.summary.checkinCapableAccounts).toBe(3)
  })

  it("supports legacy v1-like nested data.accounts payloads", () => {
    const preview = previewBackupImport(
      JSON.stringify({
        data: {
          accounts: [
            {
              site_name: "Legacy account",
              site_url: "https://legacy.example.com",
              site_type: "new-api",
              account_info: {
                id: 7,
                username: "legacy",
                access_token: "legacy-token",
              },
              supports_check_in: true,
            },
          ],
        },
      }),
    )

    expect(preview.accounts).toHaveLength(1)
    expect(preview.accounts[0].checkIn.enableDetection).toBe(true)
  })

  it("skips accounts missing required site_url", () => {
    const preview = previewBackupImport(
      JSON.stringify({
        accounts: [
          { site_name: "Bad account" },
          {
            site_name: "Good account",
            site_url: "https://good.example.com",
            site_type: "new-api",
            account_info: { id: 1, username: "good", access_token: "" },
          },
        ],
      }),
    )

    expect(preview.accounts).toHaveLength(1)
    expect(preview.summary.missingFieldAccounts).toBe(1)
  })
})
