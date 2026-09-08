import { toPositional } from '../sql-executor-mikro'

// The statements are written in Postgres's own `$n` form so the SQL the failure harness
// exercises is character-for-character the SQL a host runs. MikroORM binds `?` positionally,
// and this is the whole of the translation between them — so it is the whole of what can go
// silently wrong between a tested statement and a deployed one.
describe('toPositional', () => {
  it('rewrites placeholders in order', () => {
    expect(toPositional('select $1, $2', ['a', 'b'])).toEqual({ text: 'select ?, ?', params: ['a', 'b'] })
  })

  it('duplicates a parameter that the statement reads twice', () => {
    // The scope predicate does exactly this: compares the organization and tests it for null.
    const sql = 'where organization_id = $2 or ($2::uuid is null and organization_id is null)'
    expect(toPositional(sql, ['tenant', null])).toEqual({
      text: 'where organization_id = ? or (?::uuid is null and organization_id is null)',
      params: [null, null],
    })
  })

  it('handles placeholders that are not in ascending order', () => {
    expect(toPositional('select $3, $1', ['a', 'b', 'c'])).toEqual({ text: 'select ?, ?', params: ['c', 'a'] })
  })

  it('refuses a statement that references a parameter nobody supplied', () => {
    // Silently binding undefined would turn a fenced predicate into one that matches nothing,
    // which reads exactly like "the lease was lost" and would be debugged as such.
    expect(() => toPositional('select $2', ['only-one'])).toThrow(/references \$2 but 1 parameter/)
  })
})

// The two bugs that made the OM adapter differ from the harness — where every statement runs
// through node-postgres, which reports affected rows and honours transactions for free.
describe('mikroExecutor', () => {
  const stub = (result: unknown) => {
    const calls: Array<{ sql: string; method?: string; ctx?: unknown }> = []
    const connection = {
      execute: async (sql: string, _params?: unknown[], method?: string, ctx?: unknown) => {
        calls.push({ sql, method, ctx })
        return result
      },
    }
    const em = {
      getConnection: () => connection,
      getTransactionContext: () => 'the-transaction',
      fork: () => em,
      transactional: async (fn: (trx: unknown) => Promise<unknown>) => fn(em),
    }
    return { em, calls }
  }

  it('counts rows a statement affected, not rows it returned', async () => {
    // An UPDATE with no RETURNING returns nothing. Reporting that as zero affected rows makes
    // every domain mirror look like it matched nothing — which is treated exactly like a throw,
    // so the mirror is retried forever over a write that already landed.
    const { em, calls } = stub({ affectedRows: 1 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { mikroExecutor } = await import('../sql-executor-mikro')
    const sql = mikroExecutor(em as any)
    expect(await sql.query('update sync_runs set status = $1 where id = $2', ['completed', 'x'])).toEqual({ rows: [], rowCount: 1 })
    expect(calls[0]!.method).toBe('run')
  })

  it('reads rows from a statement that returns them', async () => {
    const { em, calls } = stub([{ id: 'a' }])
    const { mikroExecutor } = await import('../sql-executor-mikro')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = mikroExecutor(em as any)
    expect(await sql.query('update t set a = $1 returning id', [1])).toEqual({ rows: [{ id: 'a' }], rowCount: 1 })
    expect(calls[0]!.method).toBe('all')
  })

  it('passes the transaction context to every statement', async () => {
    // Without it the statements run on a pooled connection outside the transaction: nothing
    // fails, it simply stops being atomic — so `fencedWrite` no longer rolls back a stale
    // worker's writes and a terminal transition no longer moves both rows together.
    const { em, calls } = stub([{ id: 'a' }])
    const { mikroExecutor } = await import('../sql-executor-mikro')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mikroExecutor(em as any).transaction(async (tx) => tx.query('select 1'))
    expect(calls[0]!.ctx).toBe('the-transaction')
  })
})
