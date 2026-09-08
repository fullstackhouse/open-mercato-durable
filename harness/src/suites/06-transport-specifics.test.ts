// The two guarantees that are not the same on every adapter.
//
// Everything in the conformance suite must hold everywhere. These two are different in kind:
// one is a capability only pg-boss has, the other is a durability property of Redis. Asserting
// them separately keeps the shared suite honest — it stays the set of things that are true
// regardless of what carries the delivery.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PgBossTransport, queueNameFor, store, type Delivery } from '@fullstackhouse/open-mercato-durable-work'

import { acquire, transportUnderTest, type HarnessEnv } from '../env'
import { connect, freshScope, migrate, type PgExecutor } from '../db'

const transport = transportUnderTest()
let env: HarnessEnv
let sql: PgExecutor

beforeAll(async () => {
  env = await acquire({ postgres: true, redis: transport === 'bullmq' })
  sql = await connect(env.postgresUrl!)
  await migrate(sql)
}, 180_000)

afterAll(async () => {
  await sql?.end()
  await env?.stop()
})

const RETRY = { attempts: 1, backoff: { type: 'fixed' as const, delayMs: 0, maxDelayMs: 0 } }

describe.runIf(transport === 'pgboss')('transactional start (pg-boss only)', () => {
  it('commits the job row and its delivery together', async () => {
    const scope = freshScope()
    const queue = queueNameFor('tx-commit')
    const boss = new PgBossTransport({
      connectionString: env.postgresUrl!,
      schema: `dwtx_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    })
    try {
      const jobId = randomUUID()
      const seen: Delivery[] = []
      await boss.bind(queue, async (d) => void seen.push(d), { concurrency: 1, activeTimeoutMs: 30_000 })

      await sql.transaction(async (tx) => {
        await store.insertJob(tx, jobId, scope, { kind: 'test.tx' }, queue)
        await boss.enqueue(queue, { jobId, seq: 0, redrives: 0 }, { retry: RETRY, tx })
      })

      expect(await store.getJob(sql, jobId, scope)).not.toBeNull()
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !seen.length) await new Promise((r) => setTimeout(r, 50))
      expect(seen.map((d) => d.jobId)).toEqual([jobId])
    } finally {
      await boss.close({ timeoutMs: 5_000 })
    }
  }, 90_000)

  it('leaves neither the job row nor a delivery behind when the transaction rolls back', async () => {
    // The gap this closes: with any other transport there is a window between commit and
    // enqueue where a crash leaves a job nobody will ever deliver. The reconciler closes that
    // window, but closing it after fifteen minutes is not the same as never opening it.
    const scope = freshScope()
    const queue = queueNameFor('tx-rollback')
    const boss = new PgBossTransport({
      connectionString: env.postgresUrl!,
      schema: `dwtx_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    })
    try {
      const jobId = randomUUID()
      const seen: Delivery[] = []
      await boss.bind(queue, async (d) => void seen.push(d), { concurrency: 1, activeTimeoutMs: 30_000 })

      await expect(
        sql.transaction(async (tx) => {
          await store.insertJob(tx, jobId, scope, { kind: 'test.tx' }, queue)
          await boss.enqueue(queue, { jobId, seq: 0, redrives: 0 }, { retry: RETRY, tx })
          throw new Error('the caller changed its mind')
        }),
      ).rejects.toThrow('changed its mind')

      expect(await store.getJob(sql, jobId, scope)).toBeNull()
      await new Promise((r) => setTimeout(r, 3_000))
      expect(seen).toEqual([]) // and no delivery for a job that does not exist
    } finally {
      await boss.close({ timeoutMs: 5_000 })
    }
  }, 90_000)
})

describe.runIf(transport === 'bullmq')('tick durability (BullMQ only)', () => {
  it('keeps ticking after the broker loses everything', async () => {
    // A tick that lives only in a worker's memory stops when that worker restarts, and nothing
    // notices. This asserts the schedule is the broker's: FLUSHALL removes every key, and the
    // scheduler is re-established rather than silently gone.
    const { default: IORedis } = await import('ioredis')
    const { BullMQTransport } = await import('@fullstackhouse/open-mercato-durable-work')

    const prefix = `{dw-flush-${randomUUID().slice(0, 8)}}`
    const connection = new IORedis(env.redisUrl!, { maxRetriesPerRequest: null })
    const adapter = new BullMQTransport({ connection, prefix })
    const queue = queueNameFor('tick-durability')

    try {
      let ticks = 0
      await adapter.bind(queue, async () => void (ticks += 1), { concurrency: 1, activeTimeoutMs: 30_000 })
      await adapter.upsertTick({ id: 'flush-tick', queue, everyMs: 1_000 })

      const waitFor = async (target: number, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          if (ticks >= target) return true
          await new Promise((r) => setTimeout(r, 50))
        }
        return false
      }
      expect(await waitFor(2, 20_000)).toBe(true)

      const before = ticks
      await connection.flushall()
      // Re-upserting is what a worker does at boot; the point is that doing so restores the
      // schedule rather than requiring anyone to notice it was lost.
      await adapter.upsertTick({ id: 'flush-tick', queue, everyMs: 1_000 })
      expect(await waitFor(before + 2, 20_000)).toBe(true)
    } finally {
      await adapter.close({ timeoutMs: 5_000 })
      connection.disconnect()
    }
  }, 90_000)
})
