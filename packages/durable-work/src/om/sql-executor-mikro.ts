// Bridges the mechanism's `SqlExecutor` onto a MikroORM EntityManager.
//
// The mechanism talks SQL, not ORM, because every statement it issues is a compare-and-set
// whose predicate is the guarantee. But a host's transaction is a MikroORM one, and a job row
// that has to commit with a domain row has to be inside it. This adapter is how both are true
// at once: the caller keeps their EntityManager, the mechanism keeps its statements.

import type { EntityManager } from '@mikro-orm/postgresql'

import type { SqlExecutor, SqlTransactor } from '../core/types'

type Connection = {
  execute(sql: string, params?: unknown[], method?: 'all' | 'get' | 'run'): Promise<unknown>
}

/**
 * Rewrites Postgres's numbered placeholders into the positional ones MikroORM binds with.
 *
 * The statements are written in `$n` form because that is Postgres's own, and because the
 * failure harness runs them through node-postgres unchanged — the SQL that CI exercises is
 * character-for-character the SQL a host runs. MikroORM goes through Knex, which binds `?`
 * positionally, so the translation happens here rather than by writing the statements twice.
 *
 * A placeholder may legitimately appear more than once — the scope predicate reads `$3` twice,
 * to compare an organization and to test it for null — so the parameter list is rebuilt in
 * order of occurrence rather than reused as given.
 */
export function toPositional(text: string, params: readonly unknown[]): { text: string; params: unknown[] } {
  const ordered: unknown[] = []
  const rewritten = text.replace(/\$(\d+)/g, (_match, index: string) => {
    const position = Number(index)
    if (position < 1 || position > params.length) {
      throw new Error(`SQL references $${position} but ${params.length} parameter(s) were supplied`)
    }
    ordered.push(params[position - 1])
    return '?'
  })
  return { text: rewritten, params: ordered }
}

function executorFor(em: EntityManager): SqlExecutor {
  return {
    async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const connection = em.getConnection() as unknown as Connection
      const bound = toPositional(text, params)
      // `all` for every statement: our writes use RETURNING, and MikroORM's `run` discards
      // rows. A CAS whose returned row is thrown away cannot tell "matched" from "refused".
      const rows = (await connection.execute(bound.text, bound.params, 'all')) as R[]
      return { rows, rowCount: rows.length }
    },
  }
}

/**
 * Wraps an EntityManager as a transactor.
 *
 * Each transaction runs on a *forked* EntityManager. The mechanism's statements must not share
 * an identity map or a flush cycle with whatever the caller is doing — a heartbeat that
 * accidentally flushed a half-built domain entity would be a spectacular way to lose data.
 */
export function mikroExecutor(em: EntityManager): SqlTransactor {
  const base = executorFor(em)
  return {
    query: base.query,
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      const forked = em.fork()
      return forked.transactional(async (trx) => fn(executorFor(trx as EntityManager)))
    },
  }
}

/** Wraps an EntityManager the caller has already opened a transaction on, so the mechanism's
 *  statements join it rather than opening a second one. */
export function mikroTx(em: EntityManager): SqlExecutor {
  return executorFor(em)
}
