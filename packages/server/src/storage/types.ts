import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg"

export interface DatabaseClient {
  query<TResult extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>
  release(): void
}

export interface DatabasePool {
  query<TResult extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>
  connect(): Promise<DatabaseClient>
  end?(): Promise<void>
}

export type PgPool = Pool
export type PgPoolClient = PoolClient
