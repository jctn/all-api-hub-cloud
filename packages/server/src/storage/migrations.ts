import type { DatabasePool } from "./types.js"

interface SqlMigration {
  id: string
  sql: string
}

const MIGRATIONS: SqlMigration[] = [
  {
    id: "001_init_postgres_storage",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at bigint NOT NULL
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id text PRIMARY KEY,
        site_name text NOT NULL,
        site_url text NOT NULL,
        site_type text NOT NULL,
        auth_type text NOT NULL,
        disabled boolean NOT NULL DEFAULT false,
        created_at bigint NOT NULL,
        updated_at bigint NOT NULL,
        last_sync_time bigint NOT NULL,
        exchange_rate double precision NOT NULL,
        exclude_from_total_balance boolean NOT NULL DEFAULT false,
        health jsonb NOT NULL,
        account_info jsonb NOT NULL,
        cookie_auth jsonb,
        sub2api_auth jsonb,
        check_in jsonb NOT NULL,
        tag_ids jsonb NOT NULL,
        notes text NOT NULL DEFAULT '',
        manual_balance_usd text
      );

      CREATE INDEX IF NOT EXISTS idx_accounts_site_url ON accounts (site_url);
      CREATE INDEX IF NOT EXISTS idx_accounts_site_type ON accounts (site_type);
      CREATE INDEX IF NOT EXISTS idx_accounts_disabled ON accounts (disabled);
      CREATE INDEX IF NOT EXISTS idx_accounts_updated_at ON accounts (updated_at);

      CREATE TABLE IF NOT EXISTS app_settings (
        key text PRIMARY KEY,
        value jsonb NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkin_runs (
        id uuid PRIMARY KEY,
        initiated_by text NOT NULL,
        target_account_ids jsonb,
        started_at bigint NOT NULL,
        completed_at bigint NOT NULL,
        summary jsonb NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkin_runs_completed_at
        ON checkin_runs (completed_at DESC);

      CREATE TABLE IF NOT EXISTS checkin_run_results (
        id bigserial PRIMARY KEY,
        run_id uuid NOT NULL REFERENCES checkin_runs(id) ON DELETE CASCADE,
        account_id text NOT NULL,
        site_name text NOT NULL,
        site_url text NOT NULL,
        site_type text NOT NULL,
        status text NOT NULL,
        code text,
        message text NOT NULL,
        raw_message text,
        checkin_url text,
        started_at bigint NOT NULL,
        completed_at bigint NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_checkin_run_results_run_id
        ON checkin_run_results (run_id);
      CREATE INDEX IF NOT EXISTS idx_checkin_run_results_account_id
        ON checkin_run_results (account_id);

      CREATE TABLE IF NOT EXISTS account_checkin_states (
        account_id text PRIMARY KEY,
        last_run_at bigint,
        last_status text,
        last_message text,
        requires_manual_action boolean NOT NULL DEFAULT false
      );
    `,
  },
  {
    id: "002_local_worker_tasks",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS local_worker_tasks (
        id text PRIMARY KEY,
        kind text NOT NULL,
        scope text NOT NULL,
        account_ids jsonb NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL,
        requested_by text NOT NULL,
        chat_id text,
        is_verbose boolean NOT NULL DEFAULT false,
        worker_id text,
        progress_text text,
        heartbeat_at bigint,
        requested_at bigint NOT NULL,
        claimed_at bigint,
        started_at bigint,
        finished_at bigint,
        result_json jsonb,
        error_code text,
        error_message text
      );

      CREATE INDEX IF NOT EXISTS idx_local_worker_tasks_status_requested_at
        ON local_worker_tasks (status, requested_at ASC);
    `,
  },
]

export interface MigrationResult {
  appliedMigrationIds: string[]
  latestMigrationId: string | null
}

export async function runMigrations(
  pool: DatabasePool,
): Promise<MigrationResult> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at bigint NOT NULL
    )
  `)

  const appliedRows = await pool.query<{ id: string }>(
    "SELECT id FROM schema_migrations ORDER BY id ASC",
  )
  const applied = new Set(appliedRows.rows.map((row) => row.id))
  const appliedMigrationIds: string[] = []

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) {
      continue
    }

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(migration.sql)
      await client.query(
        "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)",
        [migration.id, Date.now()],
      )
      await client.query("COMMIT")
      appliedMigrationIds.push(migration.id)
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  return {
    appliedMigrationIds,
    latestMigrationId: MIGRATIONS.at(-1)?.id ?? null,
  }
}
