// Phase 1: the statements, against a real Postgres.
//
// Each test names a way the mechanism can be wrong rather than a method it calls. These are
// the failures that a mechanism like this is *for*, so they are asserted directly rather than
// inferred from a happy path that happens to pass.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { makeOwnerId, store, type Lease, type Scope } from '@fullstackhouse/open-mercato-durable-work'
import { LockKeyHeldError } from '@fullstackhouse/open-mercato-durable-work'

import { acquire, type HarnessEnv } from '../env'
import { ageBy, connect, freshScope, migrate, type PgExecutor } from '../db'

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

const TTL = 60_000
const QUEUE = 'durable-work.test'

async function newJob(scope: Scope, overrides: Partial<Parameters<typeof store.insertJob>[3]> = {}) {
  const { job } = await store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', ...overrides }, QUEUE)
  return job
}

async function claimed(scope: Scope, jobId: string, owner = makeOwnerId('test')): Promise<Lease> {
  const job = await store.claim(sql, jobId, scope, { seq: 0, redrives: 0 }, owner, TTL)
  expect(job).not.toBeNull()
  return { jobId, owner, epoch: job!.leaseEpoch, ttlMs: TTL }
}

describe('creation', () => {
  it('starts a job pending, with a pending clock and no lease', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    expect(job.status).toBe('pending')
    expect(job.pendingSince).not.toBeNull()
    expect(job.leaseOwner).toBeNull()
    expect(job.leaseEpoch).toBe(0)
  })

  it('returns the existing job for a repeated idempotency key instead of starting a second', async () => {
    const scope = freshScope()
    const first = await store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', idempotencyKey: 'k-1' }, QUEUE)
    const second = await store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', idempotencyKey: 'k-1' }, QUEUE)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.job.id).toBe(first.job.id)
  })

  it('refuses a second live job for the same lock key, and names the holder', async () => {
    const scope = freshScope()
    const held = await newJob(scope, { lockKey: 'sync:1' })
    await expect(store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', lockKey: 'sync:1' }, QUEUE)).rejects.toThrow(LockKeyHeldError)
    await expect(store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', lockKey: 'sync:1' }, QUEUE)).rejects.toMatchObject({ heldBy: held.id })
  })

  it('frees the lock key once the holder is terminal', async () => {
    const scope = freshScope()
    const first = await newJob(scope, { lockKey: 'sync:2' })
    const lease = await claimed(scope, first.id)
    await sql.transaction((tx) => store.completeCas(tx, lease))
    const second = await store.insertJob(sql, randomUUID(), scope, { kind: 'test.kind', lockKey: 'sync:2' }, QUEUE)
    expect(second.created).toBe(true)
  })

  it('scopes the lock key by organization, treating a null organization as a real value', async () => {
    const tenantId = randomUUID()
    const orgA: Scope = { tenantId, organizationId: randomUUID() }
    const orgB: Scope = { tenantId, organizationId: randomUUID() }
    const tenantWide: Scope = { tenantId, organizationId: null }
    await newJob(orgA, { lockKey: 'shared' })
    await expect(newJob(orgB, { lockKey: 'shared' })).resolves.toBeDefined()
    await expect(newJob(tenantWide, { lockKey: 'shared' })).resolves.toBeDefined()
    // …and a second tenant-wide holder is still refused, which is the case a NULL-distinct
    // unique index would have let through.
    await expect(store.insertJob(sql, randomUUID(), tenantWide, { kind: 'test.kind', lockKey: 'shared' }, QUEUE)).rejects.toThrow(LockKeyHeldError)
  })
})

describe('the fence', () => {
  it('refuses a delivery whose (seq, redrives) no longer match the row', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    expect(await store.claim(sql, job.id, scope, { seq: 1, redrives: 0 }, makeOwnerId(), TTL)).toBeNull()
    expect(await store.claim(sql, job.id, scope, { seq: 0, redrives: 1 }, makeOwnerId(), TTL)).toBeNull()
    expect(await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), TTL)).not.toBeNull()
  })

  it('refuses a duplicate delivery while the lease is alive', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const first = await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId('a'), TTL)
    const second = await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId('b'), TTL)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('bumps the epoch on every claim, so a previous owner is fenced out', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const stale = await claimed(scope, job.id, makeOwnerId('stale'))
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    const fresh = await claimed(scope, job.id, makeOwnerId('fresh'))
    expect(fresh.epoch).toBeGreaterThan(stale.epoch)
    expect(await store.heartbeat(sql, stale)).toBeNull()
    expect(await store.heartbeat(sql, fresh)).not.toBeNull()
  })

  it('consumes the scheduled delivery: claim clears next_run_at', async () => {
    // Without this a worker SIGKILLed mid-slice would leave a timestamp for a delivery no
    // broker holds, and the reconciler would wait out the whole pending TTL to repair a job
    // that the much shorter lease grace should have caught.
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'transient' }, { nextAttemptDelayMs: 30_000, maxConsecutiveFailures: 5 })
    const afterFail = await store.getJob(sql, job.id, scope)
    expect(afterFail!.nextRunAt).not.toBeNull()
    await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), TTL)
    const afterClaim = await store.getJob(sql, job.id, scope)
    expect(afterClaim!.nextRunAt).toBeNull()
  })

  it('a stale writer inside a transaction is refused and writes nothing', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const stale = await claimed(scope, job.id, makeOwnerId('stale'))
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    await claimed(scope, job.id, makeOwnerId('fresh'))

    const held = await sql.transaction((tx) => store.assertLease(tx, stale))
    expect(held).toBe(false)
    expect(await store.writeCheckpoint(sql, stale, { at: 1 })).toBe(false)
    expect((await store.getJob(sql, job.id, scope))!.checkpoint).toBeNull()
  })
})

describe('budgets', () => {
  it('a committed heartbeat resets both budgets', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.query(`update durable_work_jobs set consecutive_failures = 4, redrives_since_commit = 2 where id = $1`, [job.id])

    await store.heartbeat(sql, lease, { committed: true })
    const after = await store.getJob(sql, job.id, scope)
    expect(after!.consecutiveFailures).toBe(0)
    expect(after!.redrivesSinceCommit).toBe(0)
    expect(after!.lastCommittedAt).not.toBeNull()
  })

  it('an uncommitted heartbeat leaves the budgets alone', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.query(`update durable_work_jobs set consecutive_failures = 3 where id = $1`, [job.id])
    await store.heartbeat(sql, lease, { processedCount: 7 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after!.consecutiveFailures).toBe(3)
    expect(after!.processedCount).toBe(7)
  })

  it('decides the retry verdict inside the statement, from the counter it increments', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.query(`update durable_work_jobs set consecutive_failures = 4 where id = $1`, [job.id])
    const verdict = await store.failSlice(sql, lease, { message: 'boom', code: null, class: 'transient' }, { nextAttemptDelayMs: 1_000, maxConsecutiveFailures: 5 })
    expect(verdict).toMatchObject({ consecutiveFailures: 5, verdict: 'retry_exhausted' })
  })

  it('honours a commit made mid-slice rather than a count read at claim time', async () => {
    // The failure this guards: a slice that has just committed a day of work is failed
    // terminally because the driver still held a stale `consecutiveFailures` from before.
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.query(`update durable_work_jobs set consecutive_failures = 4 where id = $1`, [job.id])
    await store.heartbeat(sql, lease, { committed: true })
    const verdict = await store.failSlice(sql, lease, { message: 'boom', code: null, class: 'transient' }, { nextAttemptDelayMs: 1_000, maxConsecutiveFailures: 5 })
    expect(verdict).toMatchObject({ consecutiveFailures: 1, verdict: null })
  })

  it('records an unrecoverable error as a verdict immediately, whatever the counter says', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    const verdict = await store.failSlice(sql, lease, { message: 'nope', code: 'bad_input', class: 'unrecoverable' }, { nextAttemptDelayMs: null, maxConsecutiveFailures: 5 })
    expect(verdict).toMatchObject({ consecutiveFailures: 1, verdict: 'unrecoverable' })
    expect((await store.getJob(sql, job.id, scope))!.nextRunAt).toBeNull()
  })

  it('a failed slice keeps the job running so the transport retry can claim it', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'transient' }, { nextAttemptDelayMs: 0, maxConsecutiveFailures: 5 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after!.status).toBe('running')
    expect(after!.leaseOwner).toBeNull()
    expect(await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), TTL)).not.toBeNull()
  })

  it('yielding spends no retry budget', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    let lease = await claimed(scope, job.id)
    for (let i = 0; i < 3; i += 1) {
      const next = await store.yieldSlice(sql, lease, { interrupted: false })
      expect(next).toMatchObject({ seq: i + 1, redrives: 0 })
      const claim = await store.claim(sql, job.id, scope, next!, makeOwnerId(), TTL)
      lease = { jobId: job.id, owner: claim!.leaseOwner!, epoch: claim!.leaseEpoch, ttlMs: TTL }
    }
    const after = await store.getJob(sql, job.id, scope)
    expect(after!.consecutiveFailures).toBe(0)
    expect(after!.redrives).toBe(0)
    expect(after!.interruptions).toBe(0)
  })

  it('counts an interrupted yield separately from a budget yield', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.yieldSlice(sql, lease, { interrupted: true })
    expect((await store.getJob(sql, job.id, scope))!.interruptions).toBe(1)
  })

  it('releasing a lease touches no counter and keeps a pending cancellation', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.requestCancel(sql, job.id, scope, null)
    await sql.query(`update durable_work_jobs set consecutive_failures = 2 where id = $1`, [job.id])

    await store.releaseLease(sql, lease, { nextAttemptDelayMs: 1_000 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after!.consecutiveFailures).toBe(2)
    expect(after!.cancelRequestedAt).not.toBeNull()
    expect(after!.leaseOwner).toBeNull()
  })
})

describe('re-drive', () => {
  it('takes an orphan only once its lease is past the grace', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    await claimed(scope, job.id)
    expect(await store.takeOrphan(sql, job.id, { graceMs: 20_000, pendingTtlMs: 900_000, backoffMs: 15_000 })).toBeNull()

    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    const taken = await store.takeOrphan(sql, job.id, { graceMs: 20_000, pendingTtlMs: 900_000, backoffMs: 15_000 })
    expect(taken).toMatchObject({ status: 'pending', redrives: 1, redrivesSinceCommit: 1 })
    expect(taken!.leaseEpoch).toBeGreaterThan(0)
  })

  it('leaves an orphan alone while its scheduled retry is merely queued', async () => {
    // The bug this prevents: taking a healthy job whose retry is waiting behind a busy queue,
    // spending its orphan budget, and parking it as poison after a few busy periods.
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'transient' }, { nextAttemptDelayMs: 60_000, maxConsecutiveFailures: 5 })
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)

    expect(await store.takeOrphan(sql, job.id, { graceMs: 20_000, pendingTtlMs: 900_000, backoffMs: 15_000 })).toBeNull()
  })

  it('never re-drives an orphan that already carries a verdict', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'unrecoverable' }, { nextAttemptDelayMs: null, maxConsecutiveFailures: 5 })
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    expect(await store.takeOrphan(sql, job.id, { graceMs: 20_000, pendingTtlMs: 900_000, backoffMs: 15_000 })).toBeNull()
  })

  it('leaves a cancel-requested orphan to the cancel path', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    await claimed(scope, job.id)
    await store.requestCancel(sql, job.id, scope, null)
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    expect(await store.takeOrphan(sql, job.id, { graceMs: 20_000, pendingTtlMs: 900_000, backoffMs: 15_000 })).toBeNull()
  })

  it('re-drives a pending job whose delivery was lost', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    expect(await store.redrivePending(sql, job.id, { pendingTtlMs: 900_000 })).toBeNull()
    await ageBy(sql, job.id, ['pending_since'], 1_800_000)
    expect(await store.redrivePending(sql, job.id, { pendingTtlMs: 900_000 })).toMatchObject({ status: 'pending', redrives: 1 })
  })

  it('an operator re-drive resets the budgets, clears the markers, and keeps the identity', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'transient' }, { nextAttemptDelayMs: null, maxConsecutiveFailures: 1 })
    await sql.transaction((tx) => store.failTerminalCas(tx, lease, { code: 'retry_exhausted', class: 'terminal', message: 'x' }))
    await sql.query(`update durable_work_jobs set redrives_since_commit = 3, mirror_attempts = 2 where id = $1`, [job.id])

    const redriven = await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: false }))
    expect(redriven).toMatchObject({
      status: 'pending',
      redrives: 1, // identity moves forward…
      redrivesSinceCommit: 0, // …but the budgets reset: the operator is asking for more attempts
      consecutiveFailures: 0,
      mirrorAttempts: 0,
      errorCode: null,
      parkedAt: null,
      finishedAt: null,
    })
  })

  it('refuses to re-drive an unrecoverable failure without force', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.transaction((tx) => store.failTerminalCas(tx, lease, { code: 'unrecoverable', class: 'unrecoverable', message: 'nope' }))

    expect(await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: false }))).toBeNull()
    expect(await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: true }))).not.toBeNull()
  })

  it('never re-drives a completed or cancelled job', async () => {
    const scope = freshScope()
    for (const finish of ['completed', 'cancelled'] as const) {
      const job = await newJob(scope)
      const lease = await claimed(scope, job.id)
      await sql.transaction((tx) => (finish === 'completed' ? store.completeCas(tx, lease) : store.cancelCas(tx, lease)))
      expect(await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: true }))).toBeNull()
    }
  })

  it('clears a never-honoured cancellation, so the re-driven slice is not cancelled at once', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.requestCancel(sql, job.id, scope, null)
    await sql.transaction((tx) => store.failTerminalCas(tx, lease, { code: 'retry_exhausted', class: 'terminal', message: 'x' }))

    const redriven = await sql.transaction((tx) => store.operatorRedrive(tx, job.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: false }))
    expect(redriven!.cancelRequestedAt).toBeNull()
  })

  it('refuses a re-drive that would put two live jobs on one lock key', async () => {
    const scope = freshScope()
    const failed = await newJob(scope, { lockKey: 'sync:3' })
    const lease = await claimed(scope, failed.id)
    await sql.transaction((tx) => store.failTerminalCas(tx, lease, { code: 'retry_exhausted', class: 'terminal', message: 'x' }))
    await newJob(scope, { lockKey: 'sync:3' }) // the key is free now; someone takes it

    await expect(
      sql.transaction((tx) => store.operatorRedrive(tx, failed.id, scope, { graceMs: 20_000, pendingTtlMs: 900_000, force: false })),
    ).rejects.toMatchObject({ code: '23505' })
  })
})

describe('terminal transitions', () => {
  it('are fenced on the epoch, not the owner', async () => {
    // Both callers must match: the ordinary failure path has already released the lease, while
    // a retry of a verdict re-acquired it. The epoch is what they have in common.
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await store.failSlice(sql, lease, { message: 'x', code: null, class: 'transient' }, { nextAttemptDelayMs: null, maxConsecutiveFailures: 1 })
    expect((await store.getJob(sql, job.id, scope))!.leaseOwner).toBeNull()

    const failed = await sql.transaction((tx) => store.failTerminalCas(tx, lease, { code: 'retry_exhausted', class: 'terminal', message: 'x' }))
    expect(failed).toMatchObject({ status: 'failed' })
  })

  it('refuse a stale epoch', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const stale = await claimed(scope, job.id, makeOwnerId('stale'))
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)
    await claimed(scope, job.id, makeOwnerId('fresh'))
    expect(await sql.transaction((tx) => store.completeCas(tx, stale))).toBeNull()
  })

  it('roll the whole transition back when the domain mirror throws', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await expect(
      sql.transaction(async (tx) => {
        await store.completeCas(tx, lease)
        throw new Error('domain mirror failed')
      }),
    ).rejects.toThrow('domain mirror failed')

    expect((await store.getJob(sql, job.id, scope))!.status).toBe('running')
  })

  it('count a failed mirror outside the rolled-back transaction', async () => {
    // A counter written inside the transaction it is counting would roll back with it, and the
    // job would retry its mirror forever with nothing to show for it.
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql
      .transaction(async (tx) => {
        await store.completeCas(tx, lease)
        throw new Error('mirror failed')
      })
      .catch(() => undefined)
    expect(await store.bumpMirrorAttempts(sql, job.id)).toBe(1)
    expect((await store.getJob(sql, job.id, scope))!.mirrorAttempts).toBe(1)
  })
})

describe('cancellation', () => {
  it('records intent without touching status', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    const cancelled = await store.requestCancel(sql, job.id, scope, null)
    expect(cancelled).toMatchObject({ status: 'running' })
    expect(cancelled!.cancelRequestedAt).not.toBeNull()

    const beat = await store.heartbeat(sql, lease)
    expect(beat).toMatchObject({ cancelRequested: true })
  })

  it('keeps the first request when asked twice', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const first = await store.requestCancel(sql, job.id, scope, null)
    await new Promise((r) => setTimeout(r, 10))
    const second = await store.requestCancel(sql, job.id, scope, null)
    expect(second!.cancelRequestedAt!.getTime()).toBe(first!.cancelRequestedAt!.getTime())
  })

  it('will not cancel a job that already finished', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    const lease = await claimed(scope, job.id)
    await sql.transaction((tx) => store.completeCas(tx, lease))
    expect(await store.requestCancel(sql, job.id, scope, null)).toBeNull()
  })

  it('ends a pending job that was cancelled before anyone claimed it', async () => {
    const scope = freshScope()
    const job = await newJob(scope)
    await store.requestCancel(sql, job.id, scope, null)
    const ended = await sql.transaction((tx) => store.cancelPending(tx, job.id))
    expect(ended).toMatchObject({ status: 'cancelled' })
  })
})

describe('scope isolation', () => {
  it('will not read or claim a job from another tenant', async () => {
    const scope = freshScope()
    const other = freshScope()
    const job = await newJob(scope)
    expect(await store.getJob(sql, job.id, other)).toBeNull()
    expect(await store.claim(sql, job.id, other, { seq: 0, redrives: 0 }, makeOwnerId(), TTL)).toBeNull()
  })

  it('will not match a null organization with a set one', async () => {
    const tenantId = randomUUID()
    const job = await newJob({ tenantId, organizationId: null })
    expect(await store.getJob(sql, job.id, { tenantId, organizationId: randomUUID() })).toBeNull()
    expect(await store.getJob(sql, job.id, { tenantId, organizationId: null })).not.toBeNull()
  })
})
