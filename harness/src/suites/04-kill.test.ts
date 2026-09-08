// A real worker process, killed with SIGKILL in the middle of its work.
//
// This is the scenario the package exists for, reproduced without simulation: a process
// removed from the world between two writes, with no finally block and no shutdown hook. The
// claim being tested is that afterwards the job is repaired, resumes from exactly the last
// committed batch, and re-runs nothing.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { KindRegistry, makeOwnerId, reconcileOnce, resolveKind, store, type Scope } from '@fullstackhouse/open-mercato-durable-work'

import { acquire, type HarnessEnv } from '../env'
import { ageBy, connect, freshScope, migrate, type PgExecutor } from '../db'
import { startReplica } from '../replica'

let env: HarnessEnv
let sql: PgExecutor

beforeAll(async () => {
  env = await acquire({ postgres: true, redis: false })
  sql = await connect(env.postgresUrl!, { max: 10 })
  await migrate(sql)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  await env?.stop()
})

/** Mirrors the kind the child process registers, so the reconciler can repair its jobs. */
function replicaRegistry() {
  const registry = new KindRegistry()
  registry.register(
    resolveKind({
      kind: 'test.replica',
      queue: 'durable-work.test',
      orphanPolicy: 'redrive',
      lease: { ttlMs: 6_000 },
      step: async () => 'drained',
    }),
  )
  return registry
}

async function seed(scope: Scope) {
  const { job } = await store.insertJob(sql, randomUUID(), scope, { kind: 'test.replica' }, 'durable-work.test')
  return job
}

describe('SIGKILL mid-slice', () => {
  it('loses no committed work and repeats no committed batch', async () => {
    const scope = freshScope()
    const job = await seed(scope)

    const first = startReplica({
      postgresUrl: env.postgresUrl!,
      jobId: job.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      batches: 20,
      batchMs: 60,
      label: 'doomed',
    })

    const killedAfter = await first.onCommitted((index) => index >= 3)
    first.kill('SIGKILL')
    await first.exited

    // The row is exactly as an abruptly dead process leaves it: still `running`, still leased
    // by a process that no longer exists, with the work it committed intact.
    const abandoned = await store.getJob(sql, job.id, scope)
    expect(abandoned!.status).toBe('running')
    expect(abandoned!.leaseOwner).not.toBeNull()
    expect(abandoned!.checkpoint).toEqual({ done: killedAfter })

    // Nobody renews the lease, so the reconciler takes it.
    await ageBy(sql, job.id, ['lease_expires_at'], 60_000)
    const report = await reconcileOnce({
      sql,
      registry: replicaRegistry(),
      tenantId: scope.tenantId,
      graceMs: 1_000,
      enqueue: async () => undefined,
    })
    expect(report).toMatchObject({ redriven: 1 })

    const redriven = await store.getJob(sql, job.id, scope)
    expect(redriven).toMatchObject({ status: 'pending', redrives: 1 })

    // A fresh process picks it up and finishes.
    const second = startReplica({
      postgresUrl: env.postgresUrl!,
      jobId: job.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      batches: 20,
      batchMs: 10,
      seq: redriven!.continuationSeq,
      redrives: redriven!.redrives,
      label: 'fresh',
    })
    await second.exited

    const final = await store.getJob(sql, job.id, scope)
    expect(final).toMatchObject({ status: 'completed', processedCount: 20 })

    // The decisive assertion: the second process started from the committed cursor. Batch
    // numbering is cumulative, so the first batch it reports is the one after the last the
    // killed process committed — no work repeated, none skipped.
    const resumedFrom = second.output.find((line) => line.startsWith('committed '))
    expect(resumedFrom).toBe(`committed ${killedAfter + 1}`)
  }, 120_000)

  it('refuses the dead process a write, even if it somehow came back', async () => {
    const scope = freshScope()
    const job = await seed(scope)

    const replica = startReplica({
      postgresUrl: env.postgresUrl!,
      jobId: job.id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      batches: 20,
      batchMs: 60,
    })
    await replica.onCommitted((index) => index >= 2)
    const stolen = await store.getJob(sql, job.id, scope)
    replica.kill('SIGKILL')
    await replica.exited

    // Someone else takes the job.
    await ageBy(sql, job.id, ['lease_expires_at'], 60_000)
    await store.claim(sql, job.id, scope, { seq: stolen!.continuationSeq, redrives: stolen!.redrives }, makeOwnerId('new'), 60_000)

    // The dead process's lease is worthless: no heartbeat, no checkpoint, nothing.
    const ghost = { jobId: job.id, owner: stolen!.leaseOwner!, epoch: stolen!.leaseEpoch, ttlMs: 60_000 }
    expect(await store.heartbeat(sql, ghost)).toBeNull()
    expect(await store.writeCheckpoint(sql, ghost, { done: 999 })).toBe(false)
    expect((await store.getJob(sql, job.id, scope))!.checkpoint).toEqual(stolen!.checkpoint)
  }, 120_000)

  it('lets two processes race for one job and admits exactly one', async () => {
    const scope = freshScope()
    const job = await seed(scope)

    const replicas = [1, 2, 3].map((n) =>
      startReplica({
        postgresUrl: env.postgresUrl!,
        jobId: job.id,
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        batches: 5,
        batchMs: 30,
        label: `racer-${n}`,
      }),
    )
    await Promise.all(replicas.map((r) => r.exited))

    const outcomes = replicas.map((r) => r.output.find((line) => line.startsWith('result ')) ?? '')
    expect(outcomes.filter((line) => line.includes('"completed"'))).toHaveLength(1)
    expect(outcomes.filter((line) => line.includes('"refused"'))).toHaveLength(2)

    // And the work ran once, not three times.
    expect(await store.getJob(sql, job.id, scope)).toMatchObject({ status: 'completed', processedCount: 5 })
  }, 120_000)
})
