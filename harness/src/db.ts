// A `SqlExecutor` over node-postgres, plus schema setup and per-test isolation.
//
// The harness talks to a real Postgres deliberately. Every guarantee the mechanism makes is a
// property of a WHERE clause under concurrency — `for update skip locked`, a partial unique
// index, a CAS on an epoch — and none of those exist in a fake. A test that passes against a
// stub proves nothing about the thing being claimed.

import { randomUUID } from 'node:crypto'
import { Client, Pool, type ClientBase } from 'pg'

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

function clientExecutor(client: ClientBase): SqlExecutor {
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

/**
 * A connection of its own, outside the pool, whose backend the test can watch.
 *
 * For interleavings a test must force rather than hope for: start a statement here, wait until
 * Postgres reports it waiting on a lock, then release the lock from the pool side. `monitor` is
 * any other connection — the waiting one cannot ask about itself.
 */
export async function dedicatedConnection(url: string, monitor: SqlExecutor) {
  const client = new Client({ connectionString: url })
  await client.connect()
  const pid = (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
  return {
    sql: clientExecutor(client),
    async waitUntilBlocked(timeoutMs = 10_000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const result = await monitor.query<{ wait: string | null }>(
          'select wait_event_type as wait from pg_stat_activity where pid = $1',
          [pid],
        )
        if (result.rows[0]?.wait === 'Lock') return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error(`backend ${pid} never blocked on a lock within ${timeoutMs}ms`)
    },
    end: () => client.end(),
  }
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
