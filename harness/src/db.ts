// A `SqlExecutor` over node-postgres, plus schema setup and per-test isolation.
//
// The harness talks to a real Postgres deliberately. Every guarantee the mechanism makes is a
// property of a WHERE clause under concurrency — `for update skip locked`, a partial unique
// index, a CAS on an epoch — and none of those exist in a fake. A test that passes against a
// stub proves nothing about the thing being claimed.

import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'

import { SCHEMA_STATEMENTS, TABLE, type Scope, type SqlExecutor, type SqlTransactor } from '@fullstackhouse/open-mercato-durable-work'

export class PgExecutor implements SqlTransactor {
  constructor(private readonly pool: Pool) {}

  async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
    const result = await this.pool.query(text, params as unknown[])
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const value = await fn(clientExecutor(client))
      await client.query('commit')
      return value
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async end(): Promise<void> {
    await this.pool.end()
  }
}

function clientExecutor(client: PoolClient): SqlExecutor {
  return {
    async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const result = await client.query(text, params as unknown[])
      return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 }
    },
  }
}

export async function connect(url: string, opts: { max?: number } = {}): Promise<PgExecutor> {
  const pool = new Pool({ connectionString: url, max: opts.max ?? 10 })
  return new PgExecutor(pool)
}

export async function migrate(sql: SqlExecutor): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) await sql.query(statement)
}

/** Every test gets its own tenant rather than a truncated table: the statements under test are
 *  concurrent by nature, and truncating between tests would make suites that run in parallel
 *  delete each other's rows. */
export function freshScope(): Scope {
  return { tenantId: randomUUID(), organizationId: randomUUID() }
}

export async function countJobs(sql: SqlExecutor, scope: Scope): Promise<number> {
  const result = await sql.query<{ n: number }>(`select count(*)::int as n from ${TABLE} where tenant_id = $1`, [scope.tenantId])
  return result.rows[0]?.n ?? 0
}

/** Reads a column directly, for assertions the mapped row does not expose. */
export async function readColumn<T = unknown>(sql: SqlExecutor, id: string, column: string): Promise<T> {
  const result = await sql.query<Record<string, T>>(`select ${column} from ${TABLE} where id = $1`, [id])
  return result.rows[0]![column]!
}

/** Moves a job's clock-sensitive columns into the past so a test can reach a state that would
 *  otherwise take minutes. Writes the timestamp on the DATABASE clock — the same rule the
 *  statements follow — so a test never depends on the agreement of two clocks. */
export async function ageBy(sql: SqlExecutor, id: string, columns: string[], ms: number): Promise<void> {
  const sets = columns.map((c) => `${c} = ${c} - ($2::bigint * interval '1 millisecond')`).join(', ')
  await sql.query(`update ${TABLE} set ${sets} where id = $1`, [id, ms])
}
