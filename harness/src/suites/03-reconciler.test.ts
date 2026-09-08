// Phase 3: the repair loop.
//
// The property under test is the one the whole package exists for — after any failure, no job
// is left `running` forever. Every scenario here produces that failure for real: a lease that
// nobody renews, a delivery that never arrives, a cancellation whose driver died before it
// could be honoured.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  KindRegistry,
  makeOwnerId,
  reconcileOnce,
  runSlice,
  store,
  type DurableJob,
  type Scope,
} from '@fullstackhouse/open-mercato-durable-work'

import { acquire, type HarnessEnv } from '../env'
import { ageBy, connect, freshScope, migrate, type PgExecutor } from '../db'
import { fakeDelivery, scriptedKind, type ScriptedKindOptions } from '../scripted'

let env: HarnessEnv
let sql: PgExecutor

beforeAll(async () => {
  env = await acquire({ postgres: true, redis: false })
  sql = await connect(env.postgresUrl!, { max: 20 })
  await migrate(sql)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  await env?.stop()
})

const QUEUE = 'durable-work:test'

/** A registry and an enqueue spy per test, so a reconciler pass is inspectable in isolation. */
function harness(options: ScriptedKindOptions & { kind?: string; scope: Scope }) {
  const kind = scriptedKind(options)
  const registry = new KindRegistry()
  registry.register(kind)
  const enqueued: DurableJob[] = []
  return {
    kind,
    registry,
    enqueued,
    // Scoped to this test's tenant. The reconciler is system-wide in production — that is the
    // point of it — but a report counter is only a meaningful assertion when the rows it
    // counted are the rows the test created.
    reconcile: (opts: { graceMs?: number } = {}) =>
      reconcileOnce({
        sql,
        registry,
        tenantId: options.scope.tenantId,
        graceMs: opts.graceMs ?? 20_000,
        enqueue: async (job) => {
          enqueued.push(job)
        },
      }),
  }
}

async function seed(scope: Scope, kindId: string, extra: Record<string, unknown> = {}) {
  const { job } = await store.insertJob(sql, randomUUID(), scope, { kind: kindId, ...extra }, QUEUE)
  return job
}

/** Claims a job and then abandons it, exactly as a SIGKILLed worker leaves the row.
 *  Reads the row's current identity first: after a re-drive the pair has moved on, and a claim
 *  carrying the old one is refused. */
async function abandon(scope: Scope, jobId: string) {
  // Whatever held this job before is gone, so its lease is expired by construction.
  await ageBy(sql, jobId, ['lease_expires_at'], 120_000)
  const current = await store.getJob(sql, jobId, scope)
  const claimed = await store.claim(
    sql,
    jobId,
    scope,
    { seq: current!.continuationSeq, redrives: current!.redrives },
    makeOwnerId('dead'),
    60_000,
  )
  expect(claimed).not.toBeNull()
  await ageBy(sql, jobId, ['lease_expires_at'], 120_000)
}

describe('orphans', () => {
  it('re-drives an idempotent job whose worker died, with a new identity and epoch', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)
    await abandon(scope, job.id)

    const report = await h.reconcile()
    expect(report).toMatchObject({ redriven: 1, parked: 0 })

    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'pending', redrives: 1, redrivesSinceCommit: 1 })
    expect(after!.leaseEpoch).toBeGreaterThan(1)
    expect(h.enqueued.map((j) => j.id)).toEqual([job.id])
  })

  it('parks an orphan by default rather than silently re-running work nobody declared safe', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true } }) // orphanPolicy defaults to 'park'
    const job = await seed(scope, h.kind.kind)
    await abandon(scope, job.id)

    expect(await h.reconcile()).toMatchObject({ parked: 1, redriven: 0 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'failed', errorCode: 'orphaned' })
    expect(after!.parkedAt).not.toBeNull()
  })

  it('leaves a healthy job alone while its lease is live', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)
    await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), 60_000)

    expect(await h.reconcile()).toMatchObject({ scanned: 0 })
    expect((await store.getJob(sql, job.id, scope))!.status).toBe('running')
  })

  it('leaves a job alone while its retry is merely queued behind a busy broker', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)
    const claimed = await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), 60_000)
    await store.failSlice(
      sql,
      { jobId: job.id, owner: claimed!.leaseOwner!, epoch: claimed!.leaseEpoch, ttlMs: 60_000 },
      { message: 'x', code: null, class: 'transient' },
      { nextAttemptDelayMs: 120_000, maxConsecutiveFailures: 5 },
    )
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)

    expect(await h.reconcile()).toMatchObject({ scanned: 0, redriven: 0 })
  })

  it('parks as poison once re-driven repeatedly without committing anything', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive', budget: { poisonRedrivesWithoutCommit: 3 } })
    const job = await seed(scope, h.kind.kind)

    for (let i = 0; i < 3; i += 1) {
      await abandon(scope, job.id)
      await ageBy(sql, job.id, ['next_run_at'], 3_600_000) // the backoff has passed
      await h.reconcile()
    }
    await abandon(scope, job.id)
    await ageBy(sql, job.id, ['next_run_at'], 3_600_000)
    expect(await h.reconcile()).toMatchObject({ parked: 1 })

    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'poison' })
  })

  it('keeps re-driving a job that is making progress, however often it orphans', async () => {
    // The counterpart to the poison test: the budget is spent by re-drives *without* a
    // commit, so a job that commits between failures is never poisoned.
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 20, commit: true }, orphanPolicy: 'redrive', budget: { poisonRedrivesWithoutCommit: 3 } })
    const job = await seed(scope, h.kind.kind)

    for (let i = 0; i < 5; i += 1) {
      await abandon(scope, job.id)
      await ageBy(sql, job.id, ['next_run_at'], 3_600_000)
      await h.reconcile()
      const current = await store.getJob(sql, job.id, scope)
      const claimed = await store.claim(
        sql,
        job.id,
        scope,
        { seq: current!.continuationSeq, redrives: current!.redrives },
        makeOwnerId(),
        60_000,
      )
      // A committed unit of work: this is what resets the orphan budget.
      await store.heartbeat(sql, { jobId: job.id, owner: claimed!.leaseOwner!, epoch: claimed!.leaseEpoch, ttlMs: 60_000 }, { committed: true })
    }
    expect((await store.getJob(sql, job.id, scope))!.status).toBe('running')
    expect((await store.getJob(sql, job.id, scope))!.errorCode).toBeNull()
  })

  it('parks an orphan carrying a verdict with that verdict preserved', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)
    const claimed = await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), 60_000)
    await store.failSlice(
      sql,
      { jobId: job.id, owner: claimed!.leaseOwner!, epoch: claimed!.leaseEpoch, ttlMs: 60_000 },
      { message: 'dead end', code: null, class: 'unrecoverable' },
      { nextAttemptDelayMs: null, maxConsecutiveFailures: 5 },
    )
    await ageBy(sql, job.id, ['lease_expires_at'], 120_000)

    expect(await h.reconcile()).toMatchObject({ parked: 1 })
    // The orphan policy is never consulted for a job that already reached a conclusion.
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'unrecoverable' })
  })

  it('parks a job whose kind no process knows about', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 1 } })
    const job = await seed(scope, 'kind.nobody.registered')
    await abandon(scope, job.id)

    expect(await h.reconcile()).toMatchObject({ parked: 1 })
    const after = await store.getJob(sql, job.id, scope)
    expect(after).toMatchObject({ status: 'failed', errorCode: 'no_handler' })
    // "No mirror to run" is a satisfied mirror, not a pending one — otherwise the job would be
    // selected forever by a mirror-retry that can never succeed.
    expect(after!.domainMirroredAt).not.toBeNull()
  })
})

describe('deliveries that never arrive', () => {
  it('re-drives a pending job whose hand-back was lost', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true } })
    const job = await seed(scope, h.kind.kind)
    await ageBy(sql, job.id, ['pending_since'], 1_800_000)

    expect(await h.reconcile()).toMatchObject({ redriven: 1 })
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'pending', redrives: 1 })
    expect(h.enqueued).toHaveLength(1)
  })

  it('re-drives a job whose creator died between committing and enqueuing', async () => {
    // The transactional-start gap: the row exists, nothing was ever enqueued, and without the
    // reconciler the job would sit pending forever with no error anywhere.
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 1, commit: true } })
    const job = await seed(scope, h.kind.kind)
    expect(job.queueJobId).toBeNull()
    await ageBy(sql, job.id, ['pending_since'], 1_800_000)

    await h.reconcile()
    expect(h.enqueued.map((j) => j.id)).toEqual([job.id])
  })

  it('parks a pending job after too many lost deliveries', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 1 }, budget: { maxRedrives: 2 } })
    const job = await seed(scope, h.kind.kind)

    for (let i = 0; i < 2; i += 1) {
      await ageBy(sql, job.id, ['pending_since', 'next_run_at'], 1_800_000)
      await h.reconcile()
    }
    await ageBy(sql, job.id, ['pending_since', 'next_run_at'], 1_800_000)
    expect(await h.reconcile()).toMatchObject({ parked: 1 })
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'failed', errorCode: 'never_started' })
  })
})

describe('cancellation', () => {
  it('ends a job whose driver died before it could honour the cancellation', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)
    await abandon(scope, job.id)
    await store.requestCancel(sql, job.id, scope, null)

    expect(await h.reconcile()).toMatchObject({ cancelled: 1, redriven: 0 })
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'cancelled' })
  })

  it('never re-drives or parks a job that was asked to stop', async () => {
    // Both queries would otherwise match a dead cancel-requested job: one would restart work
    // somebody explicitly stopped, the other would report it as an orphan failure.
    const scope = freshScope()
    for (const policy of ['redrive', 'park'] as const) {
      const h = harness({ scope, kind: `test.cancel.${policy}`, script: { batches: 3, commit: true }, orphanPolicy: policy })
      const job = await seed(scope, h.kind.kind)
      await abandon(scope, job.id)
      await store.requestCancel(sql, job.id, scope, null)

      await h.reconcile()
      expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'cancelled' })
    }
  })

  it('ends a pending job that was cancelled before anyone claimed it', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 1 } })
    const job = await seed(scope, h.kind.kind)
    await store.requestCancel(sql, job.id, scope, null)

    expect(await h.reconcile()).toMatchObject({ cancelled: 1 })
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'cancelled' })
  })

  it('leaves a live driver to observe the cancellation itself', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 3, commit: true } })
    const job = await seed(scope, h.kind.kind)
    await store.claim(sql, job.id, scope, { seq: 0, redrives: 0 }, makeOwnerId(), 60_000)
    await store.requestCancel(sql, job.id, scope, null)

    expect(await h.reconcile()).toMatchObject({ cancelled: 0 })
    expect((await store.getJob(sql, job.id, scope))!.status).toBe('running')
  })
})

describe('two reconcilers at once', () => {
  it('partition the work rather than acting on the same job twice', async () => {
    const scope = freshScope()
    const a = harness({ scope, kind: 'test.partition', script: { batches: 1, commit: true }, orphanPolicy: 'redrive' })
    const b = harness({ scope, kind: 'test.partition', script: { batches: 1, commit: true }, orphanPolicy: 'redrive' })

    const jobs: string[] = []
    for (let i = 0; i < 12; i += 1) {
      const job = await seed(scope, 'test.partition')
      await abandon(scope, job.id)
      jobs.push(job.id)
    }

    const [reportA, reportB] = await Promise.all([a.reconcile(), b.reconcile()])

    // Every job repaired exactly once between them: `skip locked` is what makes this true,
    // rather than both reconcilers spending a re-drive on the same row.
    const total = reportA.redriven + reportB.redriven
    expect(total).toBe(12)
    for (const id of jobs) {
      expect((await store.getJob(sql, id, scope))!.redrives).toBe(1)
    }
    const enqueuedIds = [...a.enqueued, ...b.enqueued].map((j) => j.id).sort()
    expect(new Set(enqueuedIds).size).toBe(12)
  })
})

describe('the whole loop', () => {
  it('takes a job from a dead worker to completion without losing committed work', async () => {
    const scope = freshScope()
    const h = harness({ scope, script: { batches: 6, commit: true }, orphanPolicy: 'redrive' })
    const job = await seed(scope, h.kind.kind)

    // Two batches run, then the worker vanishes without releasing the lease.
    const partial = scriptedKind({
      kind: h.kind.kind,
      script: {
        batches: 6,
        commit: true,
        onBatch: (index) => {
          if (index === 2) throw new Error('SIGKILL')
        },
      },
    })
    await runSlice({ sql, kind: partial, owner: makeOwnerId('doomed') }, { jobId: job.id, seq: 0, redrives: 0 }, scope, fakeDelivery().ctx).catch(
      () => undefined,
    )
    expect(partial.executed).toEqual([0, 1])

    await ageBy(sql, job.id, ['lease_expires_at', 'next_run_at'], 3_600_000)
    expect(await h.reconcile()).toMatchObject({ redriven: 1 })

    // A fresh worker picks it up from the re-driven identity and finishes the remaining work.
    const resumed = await store.getJob(sql, job.id, scope)
    const finisher = scriptedKind({ kind: h.kind.kind, script: { batches: 6, commit: true } })
    const result = await runSlice(
      { sql, kind: finisher, owner: makeOwnerId('fresh') },
      { jobId: job.id, seq: resumed!.continuationSeq, redrives: resumed!.redrives },
      scope,
      fakeDelivery().ctx,
    )

    expect(result).toEqual({ outcome: 'completed' })
    expect(finisher.executed).toEqual([2, 3, 4, 5]) // resumed, nothing repeated
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'completed' })
  })
})
