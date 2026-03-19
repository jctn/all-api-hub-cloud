import {
  type AccountCheckinState,
  type AppSettings,
  type CheckinAccountResult,
  type CheckinHistoryDocument,
  type CheckinRunRecord,
  CheckinResultStatus,
  type SiteAccount,
  type StorageRepository,
} from "@all-api-hub/core"

import type { DatabaseClient, DatabasePool } from "./types.js"

interface AccountRow {
  id: string
  site_name: string
  site_url: string
  site_type: string
  auth_type: string
  disabled: boolean
  created_at: number | string
  updated_at: number | string
  last_sync_time: number | string
  exchange_rate: number
  exclude_from_total_balance: boolean
  health: SiteAccount["health"]
  account_info: SiteAccount["account_info"]
  cookie_auth: SiteAccount["cookieAuth"] | null
  sub2api_auth: SiteAccount["sub2apiAuth"] | null
  check_in: SiteAccount["checkIn"]
  tag_ids: string[]
  notes: string
  manual_balance_usd: string | null
}

interface CheckinRunRow {
  id: string
  initiated_by: CheckinRunRecord["initiatedBy"]
  target_account_ids: string[] | null
  started_at: number | string
  completed_at: number | string
  summary: CheckinRunRecord["summary"]
}

interface CheckinRunResultRow {
  id: number | string
  run_id: string
  account_id: string
  site_name: string
  site_url: string
  site_type: string
  status: CheckinAccountResult["status"]
  code: string | null
  message: string
  raw_message: string | null
  checkin_url: string | null
  started_at: number | string
  completed_at: number | string
}

interface AccountCheckinStateRow {
  account_id: string
  last_run_at: number | string | null
  last_status: AccountCheckinState["lastStatus"] | null
  last_message: string | null
  requires_manual_action: boolean
}

interface AppSettingRow {
  key: string
  value: unknown
}

function toNumber(value: number | string | null | undefined): number {
  if (typeof value === "number") {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return 0
}

function mapAccountRow(row: AccountRow): SiteAccount {
  return {
    id: row.id,
    site_name: row.site_name,
    site_url: row.site_url,
    site_type: row.site_type,
    health: row.health,
    exchange_rate: row.exchange_rate,
    account_info: row.account_info,
    last_sync_time: toNumber(row.last_sync_time),
    updated_at: toNumber(row.updated_at),
    created_at: toNumber(row.created_at),
    notes: row.notes,
    tagIds: Array.isArray(row.tag_ids) ? row.tag_ids : [],
    disabled: row.disabled,
    excludeFromTotalBalance: row.exclude_from_total_balance,
    authType: row.auth_type as SiteAccount["authType"],
    cookieAuth: row.cookie_auth ?? undefined,
    sub2apiAuth: row.sub2api_auth ?? undefined,
    checkIn: row.check_in,
    manualBalanceUsd: row.manual_balance_usd ?? undefined,
  }
}

function mapCheckinResultRow(row: CheckinRunResultRow): CheckinAccountResult {
  return {
    accountId: row.account_id,
    siteName: row.site_name,
    siteUrl: row.site_url,
    siteType: row.site_type,
    status: row.status,
    code: row.code ?? undefined,
    message: row.message,
    rawMessage: row.raw_message ?? undefined,
    checkInUrl: row.checkin_url ?? undefined,
    startedAt: toNumber(row.started_at),
    completedAt: toNumber(row.completed_at),
  }
}

function mapStateRow(row: AccountCheckinStateRow): AccountCheckinState {
  return {
    lastRunAt: row.last_run_at == null ? undefined : toNumber(row.last_run_at),
    lastStatus: row.last_status ?? undefined,
    lastMessage: row.last_message ?? undefined,
    requiresManualAction: row.requires_manual_action,
  }
}

function mapRunRow(
  row: CheckinRunRow,
  results: CheckinAccountResult[],
): CheckinRunRecord {
  return {
    id: row.id,
    initiatedBy: row.initiated_by,
    targetAccountIds: Array.isArray(row.target_account_ids)
      ? row.target_account_ids
      : null,
    startedAt: toNumber(row.started_at),
    completedAt: toNumber(row.completed_at),
    summary: row.summary,
    results,
  }
}

function normalizeSettings(rows: AppSettingRow[]): AppSettings {
  const settings: AppSettings = {
    version: 1,
  }

  for (const row of rows) {
    switch (row.key) {
      case "lastImportPath":
        if (typeof row.value === "string") {
          settings.lastImportPath = row.value
        }
        break
      case "lastImportedAt":
        settings.lastImportedAt = toNumber(row.value as number | string)
        break
      case "lastImportedCommitSha":
        if (typeof row.value === "string") {
          settings.lastImportedCommitSha = row.value
        }
        break
      default:
        break
    }
  }

  return settings
}

export class PostgresRepository implements StorageRepository {
  constructor(private readonly pool: DatabasePool) {}

  async initialize(): Promise<void> {}

  async getAccounts(): Promise<SiteAccount[]> {
    const result = await this.pool.query<AccountRow>(
      `
        SELECT
          id,
          site_name,
          site_url,
          site_type,
          auth_type,
          disabled,
          created_at,
          updated_at,
          last_sync_time,
          exchange_rate,
          exclude_from_total_balance,
          health,
          account_info,
          cookie_auth,
          sub2api_auth,
          check_in,
          tag_ids,
          notes,
          manual_balance_usd
        FROM accounts
        ORDER BY created_at ASC, id ASC
      `,
    )

    return result.rows.map(mapAccountRow)
  }

  async getAccountById(accountId: string): Promise<SiteAccount | null> {
    const result = await this.pool.query<AccountRow>(
      `
        SELECT
          id,
          site_name,
          site_url,
          site_type,
          auth_type,
          disabled,
          created_at,
          updated_at,
          last_sync_time,
          exchange_rate,
          exclude_from_total_balance,
          health,
          account_info,
          cookie_auth,
          sub2api_auth,
          check_in,
          tag_ids,
          notes,
          manual_balance_usd
        FROM accounts
        WHERE id = $1
      `,
      [accountId],
    )

    return result.rows[0] ? mapAccountRow(result.rows[0]) : null
  }

  async replaceAccounts(accounts: SiteAccount[]): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("DELETE FROM accounts")
      for (const account of accounts) {
        await this.upsertAccount(client, account)
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async saveAccount(account: SiteAccount): Promise<SiteAccount> {
    await this.upsertAccount(this.pool, account)
    return account
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM accounts WHERE id = $1",
      [accountId],
    )
    return (result.rowCount ?? 0) > 0
  }

  async getSettings(): Promise<AppSettings> {
    const result = await this.pool.query<AppSettingRow>(
      "SELECT key, value FROM app_settings ORDER BY key ASC",
    )
    return normalizeSettings(result.rows)
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const entries = Object.entries(patch).filter(
      ([key, value]) => key !== "version" && value !== undefined,
    )

    if (entries.length === 0) {
      return await this.getSettings()
    }

    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      for (const [key, value] of entries) {
        await client.query(
          `
            INSERT INTO app_settings (key, value)
            VALUES ($1, $2::jsonb)
            ON CONFLICT (key)
            DO UPDATE SET value = EXCLUDED.value
          `,
          [key, JSON.stringify(value)],
        )
      }
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    return await this.getSettings()
  }

  async getHistory(): Promise<CheckinHistoryDocument> {
    const [runResult, stateResult] = await Promise.all([
      this.pool.query<CheckinRunRow>(
        `
          SELECT
            id,
            initiated_by,
            target_account_ids,
            started_at,
            completed_at,
            summary
          FROM checkin_runs
          ORDER BY completed_at DESC, id DESC
          LIMIT 100
        `,
      ),
      this.pool.query<AccountCheckinStateRow>(
        `
          SELECT
            account_id,
            last_run_at,
            last_status,
            last_message,
            requires_manual_action
          FROM account_checkin_states
          ORDER BY account_id ASC
        `,
      ),
    ])

    const runIds = runResult.rows.map((row) => row.id)
    const resultsByRunId = new Map<string, CheckinAccountResult[]>()

    if (runIds.length > 0) {
      const resultRows = await this.pool.query<CheckinRunResultRow>(
        `
          SELECT
            id,
            run_id,
            account_id,
            site_name,
            site_url,
            site_type,
            status,
            code,
            message,
            raw_message,
            checkin_url,
            started_at,
            completed_at
          FROM checkin_run_results
          WHERE run_id = ANY($1::uuid[])
          ORDER BY run_id ASC, id ASC
        `,
        [runIds],
      )

      for (const row of resultRows.rows) {
        const results = resultsByRunId.get(row.run_id) ?? []
        results.push(mapCheckinResultRow(row))
        resultsByRunId.set(row.run_id, results)
      }
    }

    const records = runResult.rows.map((row) =>
      mapRunRow(row, resultsByRunId.get(row.id) ?? []),
    )

    const accountStates = Object.fromEntries(
      stateResult.rows.map((row) => [row.account_id, mapStateRow(row)]),
    )

    const updatedAt = Math.max(
      0,
      ...records.map((record) => record.completedAt),
      ...stateResult.rows.map((row) => toNumber(row.last_run_at)),
    )

    return {
      version: 1,
      updatedAt,
      records,
      accountStates,
    }
  }

  async appendHistory(record: CheckinRunRecord): Promise<CheckinHistoryDocument> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `
          INSERT INTO checkin_runs (
            id,
            initiated_by,
            target_account_ids,
            started_at,
            completed_at,
            summary
          ) VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)
        `,
        [
          record.id,
          record.initiatedBy,
          record.targetAccountIds ? JSON.stringify(record.targetAccountIds) : null,
          record.startedAt,
          record.completedAt,
          JSON.stringify(record.summary),
        ],
      )

      for (const result of record.results) {
        await client.query(
          `
            INSERT INTO checkin_run_results (
              run_id,
              account_id,
              site_name,
              site_url,
              site_type,
              status,
              code,
              message,
              raw_message,
              checkin_url,
              started_at,
              completed_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
            )
          `,
          [
            record.id,
            result.accountId,
            result.siteName,
            result.siteUrl,
            result.siteType,
            result.status,
            result.code ?? null,
            result.message,
            result.rawMessage ?? null,
            result.checkInUrl ?? null,
            result.startedAt,
            result.completedAt,
          ],
        )

        await this.upsertAccountCheckinState(client, result.accountId, {
          lastRunAt: result.completedAt,
          lastStatus: result.status,
          lastMessage: result.message,
          requiresManualAction:
            result.status === CheckinResultStatus.ManualActionRequired,
        })
      }

      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    return await this.getHistory()
  }

  async setLatestAccountResult(
    accountId: string,
    result: Pick<CheckinAccountResult, "status" | "message" | "completedAt">,
  ): Promise<void> {
    await this.upsertAccountCheckinState(this.pool, accountId, {
      lastRunAt: result.completedAt,
      lastStatus: result.status,
      lastMessage: result.message,
      requiresManualAction:
        result.status === CheckinResultStatus.ManualActionRequired,
    })
  }

  private async upsertAccount(
    executor: DatabasePool | DatabaseClient,
    account: SiteAccount,
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO accounts (
          id,
          site_name,
          site_url,
          site_type,
          auth_type,
          disabled,
          created_at,
          updated_at,
          last_sync_time,
          exchange_rate,
          exclude_from_total_balance,
          health,
          account_info,
          cookie_auth,
          sub2api_auth,
          check_in,
          tag_ids,
          notes,
          manual_balance_usd
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
          $17::jsonb, $18, $19
        )
        ON CONFLICT (id) DO UPDATE SET
          site_name = EXCLUDED.site_name,
          site_url = EXCLUDED.site_url,
          site_type = EXCLUDED.site_type,
          auth_type = EXCLUDED.auth_type,
          disabled = EXCLUDED.disabled,
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          last_sync_time = EXCLUDED.last_sync_time,
          exchange_rate = EXCLUDED.exchange_rate,
          exclude_from_total_balance = EXCLUDED.exclude_from_total_balance,
          health = EXCLUDED.health,
          account_info = EXCLUDED.account_info,
          cookie_auth = EXCLUDED.cookie_auth,
          sub2api_auth = EXCLUDED.sub2api_auth,
          check_in = EXCLUDED.check_in,
          tag_ids = EXCLUDED.tag_ids,
          notes = EXCLUDED.notes,
          manual_balance_usd = EXCLUDED.manual_balance_usd
      `,
      [
        account.id,
        account.site_name,
        account.site_url,
        account.site_type,
        account.authType,
        account.disabled,
        account.created_at,
        account.updated_at,
        account.last_sync_time,
        account.exchange_rate,
        account.excludeFromTotalBalance,
        JSON.stringify(account.health),
        JSON.stringify(account.account_info),
        account.cookieAuth ? JSON.stringify(account.cookieAuth) : null,
        account.sub2apiAuth ? JSON.stringify(account.sub2apiAuth) : null,
        JSON.stringify(account.checkIn),
        JSON.stringify(account.tagIds),
        account.notes,
        account.manualBalanceUsd ?? null,
      ],
    )
  }

  private async upsertAccountCheckinState(
    executor: DatabasePool | DatabaseClient,
    accountId: string,
    state: AccountCheckinState,
  ): Promise<void> {
    await executor.query(
      `
        INSERT INTO account_checkin_states (
          account_id,
          last_run_at,
          last_status,
          last_message,
          requires_manual_action
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (account_id) DO UPDATE SET
          last_run_at = EXCLUDED.last_run_at,
          last_status = EXCLUDED.last_status,
          last_message = EXCLUDED.last_message,
          requires_manual_action = EXCLUDED.requires_manual_action
      `,
      [
        accountId,
        state.lastRunAt ?? null,
        state.lastStatus ?? null,
        state.lastMessage ?? null,
        state.requiresManualAction ?? false,
      ],
    )
  }
}
