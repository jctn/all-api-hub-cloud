import { randomUUID } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  AuthType,
  CheckinResultStatus,
  HealthState,
  type SiteAccount,
} from "@all-api-hub/core"

import { PostgresLocalWorkerTaskStore } from "../src/localWorker/postgresTaskStore.js"
import { runMigrations } from "../src/storage/migrations.js"
import { PostgresRepository } from "../src/storage/postgresRepository.js"

function createAccount(overrides: Partial<SiteAccount> = {}): SiteAccount {
  const now = Date.now()
  return {
    id: overrides.id ?? randomUUID(),
    site_name: overrides.site_name ?? "Demo",
    site_url: overrides.site_url ?? "https://demo.example.com",
    site_type: overrides.site_type ?? "new-api",
    health: overrides.health ?? { status: HealthState.Healthy },
    exchange_rate: overrides.exchange_rate ?? 7.2,
    account_info: overrides.account_info ?? {
      id: 1,
      access_token: "token",
      username: "alice",
      quota: 0,
      today_prompt_tokens: 0,
      today_completion_tokens: 0,
      today_quota_consumption: 0,
      today_requests_count: 0,
      today_income: 0,
    },
    last_sync_time: overrides.last_sync_time ?? now,
    updated_at: overrides.updated_at ?? now,
    created_at: overrides.created_at ?? now,
    notes: overrides.notes ?? "",
    tagIds: overrides.tagIds ?? [],
    disabled: overrides.disabled ?? false,
    excludeFromTotalBalance: overrides.excludeFromTotalBalance ?? false,
    authType: overrides.authType ?? AuthType.AccessToken,
    cookieAuth: overrides.cookieAuth,
    sub2apiAuth: overrides.sub2apiAuth,
    checkIn: overrides.checkIn ?? {
      enableDetection: true,
      autoCheckInEnabled: true,
    },
    manualBalanceUsd: overrides.manualBalanceUsd,
  }
}

describe("runMigrations", () => {
  it("applies pending SQL migrations and records the latest id", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    }
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    }

    const result = await runMigrations(pool)

    expect(result.appliedMigrationIds).toEqual([
      "001_init_postgres_storage",
      "002_local_worker_tasks",
    ])
    expect(result.latestMigrationId).toBe("002_local_worker_tasks")
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN")
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)",
      ["001_init_postgres_storage", expect.any(Number)],
    )
    expect(client.query).toHaveBeenNthCalledWith(4, "COMMIT")
    expect(client.query).toHaveBeenNthCalledWith(5, "BEGIN")
    expect(client.query).toHaveBeenNthCalledWith(
      7,
      "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)",
      ["002_local_worker_tasks", expect.any(Number)],
    )
    expect(client.query.mock.calls[5]?.[0]).toContain(
      "is_verbose boolean NOT NULL DEFAULT false",
    )
    expect(client.query.mock.calls[5]?.[0]).not.toContain(
      "\n        verbose boolean NOT NULL DEFAULT false",
    )
    expect(client.query).toHaveBeenNthCalledWith(8, "COMMIT")
    expect(client.release).toHaveBeenCalledTimes(2)
  })
})

describe("PostgresRepository", () => {
  it("maps stored account rows and settings rows into domain objects", async () => {
    const account = createAccount({
      notes: "from postgres",
      cookieAuth: {
        sessionCookie: "sid=abc123",
      },
    })

    const pool = {
      query: vi.fn(async (queryText: string) => {
        if (queryText.includes("FROM accounts") && queryText.includes("WHERE id = $1")) {
          return {
            rows: [
              {
                id: account.id,
                site_name: account.site_name,
                site_url: account.site_url,
                site_type: account.site_type,
                auth_type: account.authType,
                disabled: account.disabled,
                created_at: account.created_at,
                updated_at: account.updated_at,
                last_sync_time: account.last_sync_time,
                exchange_rate: account.exchange_rate,
                exclude_from_total_balance: account.excludeFromTotalBalance,
                health: account.health,
                account_info: account.account_info,
                cookie_auth: account.cookieAuth,
                sub2api_auth: account.sub2apiAuth ?? null,
                check_in: account.checkIn,
                tag_ids: account.tagIds,
                notes: account.notes,
                manual_balance_usd: account.manualBalanceUsd ?? null,
              },
            ],
          }
        }

        if (queryText.includes("FROM app_settings")) {
          return {
            rows: [
              { key: "lastImportPath", value: "github://repo/accounts.json" },
              { key: "lastImportedAt", value: 123 },
              { key: "lastImportedCommitSha", value: "sha-1" },
            ],
          }
        }

        return { rows: [] }
      }),
      connect: vi.fn(async () => {
        throw new Error("connect should not be called")
      }),
      end: vi.fn(async () => undefined),
    }

    const repository = new PostgresRepository(pool)

    const savedAccount = await repository.getAccountById(account.id)
    const settings = await repository.getSettings()

    expect(savedAccount).toEqual(account)
    expect(settings).toEqual({
      version: 1,
      lastImportPath: "github://repo/accounts.json",
      lastImportedAt: 123,
      lastImportedCommitSha: "sha-1",
    })
  })

  it("writes check-in runs and exposes normalized history", async () => {
    const account = createAccount()
    const recordId = randomUUID()
    const transactionalQueries: Array<{ queryText: string; values?: unknown[] }> = []

    const client = {
      query: vi.fn(async (queryText: string, values?: unknown[]) => {
        transactionalQueries.push({ queryText, values })
        return { rows: [] }
      }),
      release: vi.fn(),
    }

    const pool = {
      query: vi.fn(async (queryText: string) => {
        if (queryText.includes("FROM checkin_runs")) {
          return {
            rows: [
              {
                id: recordId,
                initiated_by: "server",
                target_account_ids: [account.id],
                started_at: 100,
                completed_at: 200,
                summary: {
                  total: 1,
                  success: 1,
                  alreadyChecked: 0,
                  failed: 0,
                  manualActionRequired: 0,
                  skipped: 0,
                },
              },
            ],
          }
        }

        if (queryText.includes("FROM account_checkin_states")) {
          return {
            rows: [
              {
                account_id: account.id,
                last_run_at: 200,
                last_status: CheckinResultStatus.Success,
                last_message: "签到成功",
                requires_manual_action: false,
              },
            ],
          }
        }

        if (queryText.includes("FROM checkin_run_results")) {
          return {
            rows: [
              {
                id: 1,
                run_id: recordId,
                account_id: account.id,
                site_name: account.site_name,
                site_url: account.site_url,
                site_type: account.site_type,
                status: CheckinResultStatus.Success,
                code: null,
                message: "签到成功",
                raw_message: null,
                checkin_url: null,
                started_at: 100,
                completed_at: 200,
              },
            ],
          }
        }

        return { rows: [] }
      }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    }

    const repository = new PostgresRepository(pool)

    const history = await repository.appendHistory({
      id: recordId,
      initiatedBy: "server",
      targetAccountIds: [account.id],
      startedAt: 100,
      completedAt: 200,
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
          accountId: account.id,
          siteName: account.site_name,
          siteUrl: account.site_url,
          siteType: account.site_type,
          status: CheckinResultStatus.Success,
          message: "签到成功",
          startedAt: 100,
          completedAt: 200,
        },
      ],
    })

    expect(transactionalQueries[0].queryText).toBe("BEGIN")
    expect(
      transactionalQueries.some((entry) =>
        entry.queryText.includes("INSERT INTO checkin_runs"),
      ),
    ).toBe(true)
    expect(
      transactionalQueries.some((entry) =>
        entry.queryText.includes("INSERT INTO checkin_run_results"),
      ),
    ).toBe(true)
    expect(
      transactionalQueries.some((entry) =>
        entry.queryText.includes("INSERT INTO account_checkin_states"),
      ),
    ).toBe(true)
    expect(history.records).toHaveLength(1)
    expect(history.records[0].results[0]).toMatchObject({
      accountId: account.id,
      status: CheckinResultStatus.Success,
    })
    expect(history.accountStates[account.id]).toMatchObject({
      lastRunAt: 200,
      lastStatus: CheckinResultStatus.Success,
      lastMessage: "签到成功",
    })
  })
})

describe("PostgresLocalWorkerTaskStore", () => {
  it("enqueues tasks with the is_verbose column and maps verbose from SQL alias", async () => {
    const queries: Array<{ queryText: string; values?: unknown[] }> = []
    const pool = {
      query: vi.fn(async (queryText: string, values?: unknown[]) => {
        queries.push({ queryText, values })
        return {
          rows: [
            {
              id: "task-1",
              kind: "checkin",
              scope: "single",
              account_ids: ["account-1"],
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
              status: "queued",
              requested_by: "telegram",
              chat_id: "10001",
              verbose: true,
              worker_id: null,
              progress_text: null,
              heartbeat_at: null,
              requested_at: 1_000,
              claimed_at: null,
              started_at: null,
              finished_at: null,
              result_json: null,
              error_code: null,
              error_message: null,
            },
          ],
        }
      }),
      connect: vi.fn(async () => {
        throw new Error("connect should not be called")
      }),
      end: vi.fn(async () => undefined),
    }

    const store = new PostgresLocalWorkerTaskStore(pool)

    const task = await store.enqueue({
      kind: "checkin",
      scope: "single",
      requestedBy: "telegram",
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
      requestedAt: 1_000,
    })

    expect(task).toMatchObject({
      id: "task-1",
      status: "queued",
      verbose: true,
    })
    expect(queries[0]?.queryText).toContain("is_verbose")
    expect(queries[0]?.queryText).toContain("is_verbose AS verbose")
    expect(queries[0]?.values?.[6]).toBe(true)
  })

  it("claims the oldest queued task and maps the returned row", async () => {
    const transactionalQueries: Array<{ queryText: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (queryText: string, values?: unknown[]) => {
        transactionalQueries.push({ queryText, values })

        if (queryText.includes("FROM local_worker_tasks") && queryText.includes("status IN")) {
          return { rows: [] }
        }

        if (queryText.includes("FROM local_worker_tasks") && queryText.includes("status = 'queued'")) {
          return {
            rows: [
              {
                id: "task-1",
                kind: "checkin",
                scope: "single",
                account_ids: ["account-1"],
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
                status: "queued",
                requested_by: "telegram",
                chat_id: "10001",
                verbose: true,
                worker_id: null,
                progress_text: null,
                heartbeat_at: null,
                requested_at: 1_000,
                claimed_at: null,
                started_at: null,
                finished_at: null,
                result_json: null,
                error_code: null,
                error_message: null,
              },
            ],
          }
        }

        if (queryText.includes("UPDATE local_worker_tasks")) {
          return {
            rows: [
              {
                id: "task-1",
                kind: "checkin",
                scope: "single",
                account_ids: ["account-1"],
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
                status: "claimed",
                requested_by: "telegram",
                chat_id: "10001",
                verbose: true,
                worker_id: "local-browser-1",
                progress_text: null,
                heartbeat_at: 1_005,
                requested_at: 1_000,
                claimed_at: 1_005,
                started_at: null,
                finished_at: null,
                result_json: null,
                error_code: null,
                error_message: null,
              },
            ],
          }
        }

        return { rows: [] }
      }),
      release: vi.fn(),
    }
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    }

    const store = new PostgresLocalWorkerTaskStore(pool)

    const task = await store.claimNext("local-browser-1", 1_005)

    expect(task).toMatchObject({
      id: "task-1",
      status: "claimed",
      workerId: "local-browser-1",
      claimedAt: 1_005,
      heartbeatAt: 1_005,
      accountIds: ["account-1"],
    })
    expect(transactionalQueries[0]?.queryText).toBe("BEGIN")
    expect(
      transactionalQueries.some((entry) =>
        entry.queryText.includes("FOR UPDATE SKIP LOCKED"),
      ),
    ).toBe(true)
    expect(transactionalQueries.at(-1)?.queryText).toBe("COMMIT")
  })

  it("updates progress and finish states through returning rows", async () => {
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              id: "task-1",
              kind: "checkin",
              scope: "single",
              account_ids: ["account-1"],
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
              status: "running",
              requested_by: "telegram",
              chat_id: "10001",
              verbose: true,
              worker_id: "local-browser-1",
              progress_text: "浏览器已启动",
              heartbeat_at: 1_100,
              requested_at: 1_000,
              claimed_at: 1_050,
              started_at: 1_100,
              finished_at: null,
              result_json: null,
              error_code: null,
              error_message: null,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: "task-1",
              kind: "checkin",
              scope: "single",
              account_ids: ["account-1"],
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
              status: "succeeded",
              requested_by: "telegram",
              chat_id: "10001",
              verbose: true,
              worker_id: "local-browser-1",
              progress_text: "浏览器已启动",
              heartbeat_at: 1_120,
              requested_at: 1_000,
              claimed_at: 1_050,
              started_at: 1_100,
              finished_at: 1_120,
              result_json: {
                summary: {
                  total: 1,
                  success: 1,
                },
              },
              error_code: null,
              error_message: null,
            },
          ],
        }),
      connect: vi.fn(async () => {
        throw new Error("connect should not be called")
      }),
      end: vi.fn(async () => undefined),
    }

    const store = new PostgresLocalWorkerTaskStore(pool)

    const running = await store.updateProgress("task-1", "local-browser-1", {
      status: "running",
      progressText: "浏览器已启动",
      heartbeatAt: 1_100,
    })
    const finished = await store.finish("task-1", "local-browser-1", {
      status: "succeeded",
      finishedAt: 1_120,
      resultJson: {
        summary: {
          total: 1,
          success: 1,
        },
      },
    })

    expect(running).toMatchObject({
      id: "task-1",
      status: "running",
      progressText: "浏览器已启动",
    })
    expect(finished).toMatchObject({
      id: "task-1",
      status: "succeeded",
      finishedAt: 1_120,
      resultJson: {
        summary: {
          success: 1,
        },
      },
    })
  })

  it("uses matching SQL placeholders when expiring stale tasks", async () => {
    const queries: Array<{ queryText: string; values?: unknown[] }> = []
    const pool = {
      query: vi.fn(async (queryText: string, values?: unknown[]) => {
        queries.push({ queryText, values })
        return { rows: [] }
      }),
      connect: vi.fn(async () => {
        throw new Error("connect should not be called")
      }),
      end: vi.fn(async () => undefined),
    }

    const store = new PostgresLocalWorkerTaskStore(pool)

    await store.expireStaleTasks({
      claimTimeoutBefore: 1_000,
      heartbeatTimeoutBefore: 2_000,
      finishedAt: 3_000,
    })

    expect(queries).toHaveLength(2)
    expect(queries[0]?.queryText).toContain("finished_at = $2")
    expect(queries[0]?.queryText).toContain(
      "COALESCE(claimed_at, requested_at) <= $1",
    )
    expect(queries[0]?.values).toEqual([1_000, 3_000])

    expect(queries[1]?.queryText).toContain("finished_at = $2")
    expect(queries[1]?.queryText).toContain(
      "COALESCE(heartbeat_at, claimed_at, requested_at) <= $1",
    )
    expect(queries[1]?.values).toEqual([2_000, 3_000])
  })
})
