// The domain mirror, against a real Postgres.
//
// `onTransition` must leave the domain row agreeing with the job, and reports how many rows it
// matched so that "the callback ran" is never mistaken for "the row agrees". Zero matched is
// therefore treated exactly like a throw.
//
// That rule has an edge it originally got wrong, and it deadlocked a real environment. An
// operator cancelled a `data_sync` run through core's own route, which writes `cancelled`
// straight onto the run. The job then tried to mirror its own terminal state, matched no rows
// because the run was no longer `running`, and failed the transition — but the only way out of
// `running` is a successful mirror, so it retried until its budget was gone and sat there.
//
// The row already said what the job was trying to make it say. "Matched" has to mean the row
// agrees, not that this writer is the one who made it agree.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { store, type Scope } from '@fullstackhouse/open-mercato-durable-work'
import { mirrorRunStatus, reopenRun } from '@fullstackhouse/open-mercato-data-sync-durable/engine/durable-run'
import { cancelDurableJobForRun, syncIdempotencyKey, IMPORT_KIND } from '@fullstackhouse/open-mercato-data-sync-durable/kinds/data-sync-run'

import { acquire, type HarnessEnv } from '../env'
import { connect, freshScope, migrate, type PgExecutor } from '../db'

let env: HarnessEnv
let sql: PgExecutor

beforeAll(async () => {
  env = await acquire({ postgres: true, redis: false })
  sql = await connect(env.postgresUrl!, { max: 5 })
  await migrate(sql)
  // Only the columns the mirror touches. The point is the WHERE clause, not core's schema.
  await sql.query(`
    create table if not exists sync_runs (
      id uuid primary key,
      status text not null,
      last_error text,
      updated_at timestamptz not null default now(),
      deleted_at timestamptz
    )`)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  await env?.stop()
})

async function aRun(status: string, opts: { deleted?: boolean } = {}): Promise<string> {
  const id = randomUUID()
  await sql.query(`insert into sync_runs (id, status, deleted_at) values ($1, $2, $3)`, [
    id,
    status,
    opts.deleted ? new Date() : null,
  ])
  return id
}

const statusOf = async (id: string): Promise<string> =>
  (await sql.query<{ status: string }>(`select status from sync_runs where id = $1`, [id])).rows[0].status

describe('mirroring a terminal transition onto the run', () => {
  it('moves a live run to the terminal status', async () => {
    const id = await aRun('running')
    await expect(mirrorRunStatus(sql, id, 'completed', null)).resolves.toEqual({ matched: 1 })
    expect(await statusOf(id)).toBe('completed')
  })

  it('agrees with a run that already holds the target status, instead of deadlocking', async () => {
    // The staging failure. Core's cancel route writes `cancelled` onto the run directly, so by
    // the time the job mirrors its own cancellation the row already says so. Reporting that as
    // "matched nothing" fails a transition whose only exit is that same mirror.
    const id = await aRun('cancelled')
    await expect(mirrorRunStatus(sql, id, 'cancelled', null)).resolves.toEqual({ matched: 1 })
    expect(await statusOf(id)).toBe('cancelled')
  })

  it('still refuses a run that finished as something else', async () => {
    // The rule this edge must not erode: a row that genuinely disagrees is a real conflict, and
    // forcing it would let a job overwrite an outcome another path already decided.
    const id = await aRun('completed')
    await expect(mirrorRunStatus(sql, id, 'failed', 'boom')).resolves.toEqual({ matched: 0 })
    expect(await statusOf(id)).toBe('completed')
  })

  it('still refuses a run that has been deleted', async () => {
    const id = await aRun('running', { deleted: true })
    await expect(mirrorRunStatus(sql, id, 'completed', null)).resolves.toEqual({ matched: 0 })
  })
})

describe('re-opening a run when an operator re-drives its job', () => {
  it('re-opens a terminal run', async () => {
    const id = await aRun('failed')
    await expect(reopenRun(sql, id)).resolves.toEqual({ matched: 1 })
    expect(await statusOf(id)).toBe('running')
  })

  it('agrees with a run that is already open', async () => {
    // Same edge, mirrored: a re-drive whose run is already `running` has nothing to do, and
    // saying so as a failure would strand the re-drive the way the cancel stranded the job.
    const id = await aRun('running')
    await expect(reopenRun(sql, id)).resolves.toEqual({ matched: 1 })
  })
})


describe('cancelling the durable job behind a run', () => {
  // Core's cancel route writes `cancelled` onto the run and knows nothing about the job. Left
  // there, the mechanism's own cancellation never happens: `cancel_requested_at` is never set,
  // the reconciler's cancelling sweep has nothing to find, and a kind's `onCancel` — which is
  // where external resources are released — never runs.
  async function aJobFor(runId: string, scope: Scope): Promise<string> {
    const { job } = await store.insertJob(
      sql,
      randomUUID(),
      scope,
      {
        kind: IMPORT_KIND,
        input: { runId, batchSize: 100, direction: 'import' },
        idempotencyKey: syncIdempotencyKey(runId),
        subject: { type: 'data_sync.run', id: runId },
      },
      'durable-work.data-sync',
    )
    return job.id
  }

  it('asks the mechanism to cancel the job that carries the run', async () => {
    const scope = freshScope()
    const runId = randomUUID()
    const jobId = await aJobFor(runId, scope)
    const cancelled: string[] = []

    const outcome = await cancelDurableJobForRun(
      { sql, durable: { cancel: async (id: string) => (cancelled.push(id), null) } },
      runId,
      scope,
      'user-1',
    )

    expect(outcome).toBe('cancelled')
    expect(cancelled).toEqual([jobId])
  })

  it('says so when the run has no durable job, rather than failing the request', async () => {
    // A run started before this package was adopted, or one whose job was already reaped. The
    // operator's cancel still succeeded; there is simply nothing further to stop.
    const outcome = await cancelDurableJobForRun(
      { sql, durable: { cancel: async () => null } },
      randomUUID(),
      freshScope(),
      null,
    )
    expect(outcome).toBe('no_job')
  })
})
