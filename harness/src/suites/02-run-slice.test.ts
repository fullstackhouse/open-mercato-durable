// Phase 2: the worker body, against a real Postgres.
//
// These are the scenarios the mechanism exists for. Each one is a way work gets lost or done
// twice in a system without a lease — a process dying mid-batch, a duplicate delivery, a
// write that lands after its right to make it expired — reproduced deliberately.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  NoFurtherAttempts,
  TerminalError,
  UnrecoverableError,
  makeOwnerId,
  runSlice,
  store,
  type Scope,
} from '@fullstackhouse/open-mercato-durable-work'

import { acquire, type HarnessEnv } from '../env'
import { ageBy, connect, freshScope, migrate, type PgExecutor } from '../db'
import { fakeDelivery, scriptedKind, type Script, type ScriptedKind } from '../scripted'

let env: HarnessEnv
let sql: PgExecutor

beforeAll(async () => {
  env = await acquire({ postgres: true, redis: false })
  sql = await connect(env.postgresUrl!)
  await migrate(sql)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  await env?.stop()
})

const QUEUE = 'durable-work.test'

async function seed(scope: Scope, kind: ScriptedKind) {
  const { job } = await store.insertJob(sql, randomUUID(), scope, { kind: kind.kind }, QUEUE)
  return job
}

function deps(kind: ScriptedKind, owner = makeOwnerId('test')) {
  return { sql, kind, owner }
}

/** Runs deliveries until the job stops asking for more, so a test can say "run it to the end"
 *  without hand-rolling a loop each time. */
async function drive(
  kind: ScriptedKind,
  scope: Scope,
  jobId: string,
  opts: { maxDeliveries?: number; owner?: string; script?: Script } = {},
) {
  const results = []
  let delivery = { jobId, seq: 0, redrives: 0 }
  for (let i = 0; i < (opts.maxDeliveries ?? 20); i += 1) {
    const attempt = fakeDelivery()
    const result = await runSlice(deps(kind, opts.owner ?? makeOwnerId('test')), delivery, scope, attempt.ctx).catch((error) => {
      if (error instanceof NoFurtherAttempts) return { outcome: 'failed' as const, verdict: 'unrecoverable' as const }
      return { outcome: 'threw' as const, error }
    })
    results.push(result)
    if (result.outcome !== 'yielded') break
    delivery = { jobId, seq: result.seq, redrives: result.redrives }
  }
  return results
}

describe('the happy path', () => {
  it('runs every batch exactly once and completes', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 5, commit: true } })
    const job = await seed(scope, kind)

    const results = await drive(kind, scope, job.id)
    expect(results.at(-1)).toEqual({ outcome: 'completed' })
    expect(kind.executed).toEqual([0, 1, 2, 3, 4])
    const final = await store.getJob(sql, job.id, scope)
    expect(final).toMatchObject({ status: 'completed', processedCount: 5, totalCount: 5 })
    expect(final!.finishedAt).not.toBeNull()
  })

  it('resumes from the committed checkpoint across slices, without repeating a batch', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 6, commit: true, yieldAfter: 2 } })
    const job = await seed(scope, kind)

    const results = await drive(kind, scope, job.id)
    expect(results.map((r) => r.outcome)).toEqual(['yielded', 'yielded', 'completed'])
    expect(kind.executed).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('spends no retry budget on a hand-back, however many times it yields', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 6, commit: true, yieldAfter: 2 } })
    const job = await seed(scope, kind)
    await drive(kind, scope, job.id)

    const final = await store.getJob(sql, job.id, scope)
    expect(final).toMatchObject({ consecutiveFailures: 0, redrives: 0, redrivesSinceCommit: 0 })
  })
})

describe('duplicate and stale deliveries', () => {
  it('refuses a duplicate delivery while the first still holds the lease', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 1, commit: true, batchMs: 150 } })
    const job = await seed(scope, kind)

    const [first, second] = await Promise.all([
      runSlice(deps(kind, makeOwnerId('a')), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx),
      runSlice(deps(kind, makeOwnerId('b')), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx),
    ])
    const outcomes = [first.outcome, second.outcome].sort()
    expect(outcomes).toEqual(['completed', 'refused'])
    expect(kind.executed).toEqual([0]) // the batch ran once, not twice
  })

  it('refuses a straggling redelivery of a slice that has already moved on', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 4, commit: true, yieldAfter: 1 } })
    const job = await seed(scope, kind)

    const first = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)
    expect(first).toMatchObject({ outcome: 'yielded', seq: 1 })

    const straggler = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)
    expect(straggler).toEqual({ outcome: 'refused', reason: 'identity' })
    expect(kind.executed).toEqual([0]) // the straggler ran nothing
  })

  it('hands the next identity to the transport, not the one it was given', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 4, commit: true, yieldAfter: 1 } })
    const job = await seed(scope, kind)
    const delivery = fakeDelivery()

    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, delivery.ctx)
    expect(delivery.handBacks).toEqual([{ jobId: job.id, seq: 1, redrives: 0 }])
  })
})

describe('a driver that dies mid-slice', () => {
  it('resumes from the last committed batch, and never re-runs a committed one', async () => {
    const scope = freshScope()
    const script: Script = { batches: 6, commit: true }
    const kind = scriptedKind({
      script: {
        ...script,
        // "The process is killed after batch 2": the slice stops without completing, exactly
        // as a SIGKILL would leave it, and the lease is what has to notice.
        onBatch: (index) => {
          if (index === 3) throw new Error('process died')
        },
      },
    })
    const job = await seed(scope, kind)

    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)
    expect(kind.executed).toEqual([0, 1, 2])

    const resumed = scriptedKind({ kind: kind.kind, script: { batches: 6, commit: true } })
    const after = await store.getJob(sql, job.id, scope)
    // Same identity: `failSlice` released the lease but left `(seq, redrives)` alone, which is
    // what lets the transport's retry claim the very same delivery.
    await drive(resumed, scope, job.id, { maxDeliveries: 5 })
    expect(resumed.executed).toEqual([3, 4, 5])
    expect(after!.status).toBe('running')
    expect((await store.getJob(sql, job.id, scope))!.status).toBe('completed')
  })

  it('lets a fresh driver take over once the lease expires, fencing the old one out', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 3, commit: true } })
    const job = await seed(scope, kind)

    // A driver claims and then vanishes without releasing anything.
    const abandoned = await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId('dead'), 60_000)
    const stale = { jobId: job.id, owner: abandoned!.leaseOwner!, epoch: abandoned!.leaseEpoch, ttlMs: 60_000 }
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)

    const results = await drive(kind, scope, job.id)
    expect(results.at(-1)).toEqual({ outcome: 'completed' })
    // The abandoned driver, waking up late, can write nothing.
    expect(await store.heartbeat(sql, stale)).toBeNull()
    expect(await store.writeCheckpoint(sql, stale, { done: 99 })).toBe(false)
  })

  it('rolls back a fenced write made after the lease was taken', async () => {
    const scope = freshScope()
    let taken = false
    const kind = scriptedKind({
      script: {
        batches: 3,
        commit: false,
        onBatch: async (index, ctx) => {
          if (index !== 1 || taken) return
          taken = true
          // Somebody else takes the job in the middle of this slice.
          await ageBy(sql, ctx.job.id, ['lease_expires_at'], 120_000)
          await store.claim(sql, ctx.job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId('usurper'), 60_000)
          await ctx.fencedWrite(async (tx) => {
            await tx.query(`insert into durable_work_jobs (id, tenant_id, kind, status) values ($1, $2, 'sentinel', 'pending')`, [
              randomUUID(),
              scope.tenantId,
            ])
          })
        },
      },
    })
    const job = await seed(scope, kind)

    const result = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)
    expect(result).toEqual({ outcome: 'lease_lost' })

    // The sentinel row is the proof: the fenced transaction rolled back entirely, so the
    // slice's write did not survive the loss of its lease.
    const sentinels = await sql.query<{ n: number }>(
      `select count(*)::int as n from durable_work_jobs where tenant_id = $1 and kind = 'sentinel'`,
      [scope.tenantId],
    )
    expect(sentinels.rows[0]!.n).toBe(0)
  })
})

describe('failure classification', () => {
  it('retries a transient failure by rethrowing, leaving the identity intact', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 3, commit: true, throwAt: 1 } })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toThrow('scripted failure')
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'running', consecutiveFailures: 1, continuationSeq: 0, errorCode: null })
    expect(after!.nextRunAt).not.toBeNull()
  })

  it('fails an unrecoverable error at once and tells the transport not to retry', async () => {
    const scope = freshScope()
    const kind = scriptedKind({
      script: { batches: 3, commit: true, throwAt: 0, throwWith: () => new UnrecoverableError('bad input', { code: 'bad_input' }) },
    })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toBeInstanceOf(NoFurtherAttempts)
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'unrecoverable', errorClass: 'unrecoverable' })
  })

  it('fails a terminal error at once, but leaves it re-drivable', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 3, commit: true, throwAt: 0, throwWith: () => new TerminalError('dead end') } })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toBeInstanceOf(NoFurtherAttempts)
    const failed = await store.getJob(sql, job.id, scope)
    expect(failed).toMatchObject({ status: 'failed', errorClass: 'terminal' })
    expect(await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: false }))).not.toBeNull()
  })

  it('exhausts the retry budget into a terminal failure', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 3, commit: false, throwAt: 0 }, budget: { maxConsecutiveFailures: 3 } })
    const job = await seed(scope, kind)

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery({ attempt }).ctx)).rejects.toThrow('scripted failure')
    }
    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery({ attempt: 3 }).ctx)).rejects.toBeInstanceOf(NoFurtherAttempts)
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'retry_exhausted' })
  })

  it('does not exhaust the budget when the slice keeps committing progress', async () => {
    // The failure this prevents: a long job that fails intermittently but makes real progress
    // between failures is killed by a counter that only ever goes up.
    const scope = freshScope()
    let batch = 0
    const kind = scriptedKind({
      budget: { maxConsecutiveFailures: 3 },
      script: {
        batches: 6,
        commit: true,
        onBatch: () => {
          batch += 1
          if (batch % 2 === 0) throw new Error('intermittent')
        },
      },
    })
    const job = await seed(scope, kind)

    for (let i = 0; i < 12; i += 1) {
      const result = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch((e) => e)
      if ((await store.getJob(sql, job.id, scope))!.status === 'completed') break
      void result
    }
    const final = await store.getJob(sql, job.id, scope)
    expect(final!.status).toBe('completed')
    expect(final!.errorCode).toBeNull()
  })
})

describe('the domain mirror', () => {
  it('rolls the terminal transition back when the mirror throws, and counts the attempt', async () => {
    const scope = freshScope()
    const kind = scriptedKind({
      script: { batches: 1, commit: true },
      mirror: {
        onTransition: (calls) => {
          if (calls === 1) throw new Error('domain unavailable')
          return { matched: 1 }
        },
      },
    })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toThrow('domain unavailable')
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'running', mirrorAttempts: 1 })
    expect(after!.finishedAt).toBeNull()
  })

  it('treats a mirror that matched no rows exactly like a throw', async () => {
    const scope = freshScope()
    const kind = scriptedKind({ script: { batches: 1, commit: true }, mirror: { onTransition: () => ({ matched: 0 }) } })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toThrow(/matched no rows/)
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'running', mirrorAttempts: 1 })
  })

  it('completes once the mirror recovers, and runs the after-commit hook exactly once', async () => {
    const scope = freshScope()
    const kind = scriptedKind({
      script: { batches: 1, commit: true },
      mirror: { onTransition: (calls) => (calls === 1 ? { matched: 0 } : { matched: 1 }) },
    })
    const job = await seed(scope, kind)

    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)
    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)

    const final = await store.getJob(sql, job.id, scope)
    expect(final).toMatchObject({ status: 'completed' })
    expect(final!.domainMirroredAt).not.toBeNull()
    expect(kind.afterTransitionCalls).toBe(1)
  })

  it('retries only the decision, never the work, when a verdict is already on the row', async () => {
    const scope = freshScope()
    const kind = scriptedKind({
      budget: { maxConsecutiveFailures: 1 },
      script: { batches: 3, commit: false, throwAt: 0, throwWith: () => new TerminalError('dead end') },
      mirror: { onTransition: (calls) => (calls === 1 ? { matched: 0 } : { matched: 1 }) },
    })
    const job = await seed(scope, kind)

    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)
    expect((await store.getJob(sql, job.id, scope))!.errorCode).toBe('retry_exhausted')

    const before = kind.executed.length
    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)
    expect(kind.executed.length).toBe(before) // the step never ran again
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'retry_exhausted' })
  })

  it('releases the lease when retrying a verdict fails, so the next attempt can claim', async () => {
    // Without the release the row sits under a live lease, every remaining transport attempt
    // is refused by `claim`, and the retry chain ends silently with the job stuck `running`.
    const scope = freshScope()
    const kind = scriptedKind({
      budget: { maxConsecutiveFailures: 1 },
      script: { batches: 3, commit: false, throwAt: 0, throwWith: () => new TerminalError('dead end') },
      mirror: { onTransition: () => ({ matched: 0 }) },
    })
    const job = await seed(scope, kind)

    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)
    await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(() => undefined)

    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'running', errorCode: 'retry_exhausted' })
    expect(after!.leaseOwner).toBeNull()
    expect(await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), 60_000)).not.toBeNull()
  })
})

describe('cancellation', () => {
  it('stops at the next batch boundary and ends as cancelled', async () => {
    const scope = freshScope()
    const kind = scriptedKind({
      lease: { ttlMs: 3_000 }, // heartbeats every second, so the request is observed quickly
      script: {
        batches: 20,
        commit: true,
        batchMs: 60,
        onBatch: async (index, ctx) => {
          if (index === 2) await store.requestCancel(sql, ctx.job.id, scope, null)
        },
      },
    })
    const job = await seed(scope, kind)

    const result = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)
    expect(result).toEqual({ outcome: 'cancelled' })
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'cancelled' })
    expect(kind.executed.length).toBeLessThan(20) // it stopped rather than draining
  })

  it('never counts a mirror failure during cancellation as a slice failure', async () => {
    // A cancellation must always end as `cancelled`. If a failed mirror spent the retry
    // budget, a cancelled job could end up `failed`, telling the operator something untrue.
    const scope = freshScope()
    const kind = scriptedKind({
      lease: { ttlMs: 3_000 },
      script: {
        batches: 20,
        commit: true,
        batchMs: 60,
        onBatch: async (index, ctx) => {
          if (index === 2) await store.requestCancel(sql, ctx.job.id, scope, null)
        },
      },
      mirror: { onTransition: () => ({ matched: 0 }) },
    })
    const job = await seed(scope, kind)

    await expect(runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx)).rejects.toThrow(/matched no rows/)
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'running', consecutiveFailures: 0, mirrorAttempts: 1 })
    expect(after!.cancelRequestedAt).not.toBeNull() // still owed, so the next attempt honours it
    expect(after!.errorCode).toBeNull()
  })
})

describe('shutdown', () => {
  it('hands the remaining work back instead of failing when the process is stopping', async () => {
    const scope = freshScope()
    const delivery = fakeDelivery()
    const kind = scriptedKind({
      script: {
        batches: 10,
        commit: true,
        batchMs: 20,
        onBatch: (index) => {
          if (index === 2) delivery.abort()
        },
      },
    })
    const job = await seed(scope, kind)

    const result = await runSlice(deps(kind), { jobId: job.id, seq: 0, redrives: 0 }, scope, delivery.ctx)
    expect(result).toMatchObject({ outcome: 'yielded', seq: 1 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'pending', interruptions: 1, consecutiveFailures: 0 })
    expect(after!.checkpoint).toEqual({ done: 3 })
  })
})
