// One replica of the soak: a real worker process, bound to a real transport, doing real work
// until something kills it.
//
// Deliberately has no shutdown handling. The soak's whole subject is what happens when a
// process is removed from the world without warning, and a replica that tidied up on the way
// out would only ever demonstrate that tidy shutdowns work.

import { randomUUID } from 'node:crypto'

import {
  BullMQTransport,
  MemoryTransport,
  PgBossTransport,
  registry,
  resolveKind,
  startWorker,
  type SliceOutcome,
  type TransportAdapter,
} from '@fullstackhouse/open-mercato-durable-work'

import { connect } from '../db'
import { SOAK_BATCHES, SOAK_KIND, SOAK_QUEUE } from './shared'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name]
  if (value == null || value === '') {
    if (fallback === undefined) throw new Error(`${name} is required`)
    return fallback
  }
  return value
}

async function makeTransport(name: string, postgresUrl: string, redisUrl: string | null): Promise<TransportAdapter> {
  if (name === 'bullmq') {
    if (!redisUrl) throw new Error('bullmq needs HARNESS_REDIS_URL')
    const { default: IORedis } = await import('ioredis')
    return new BullMQTransport({ connection: new IORedis(redisUrl, { maxRetriesPerRequest: null }) })
  }
  if (name === 'pgboss') return new PgBossTransport({ connectionString: postgresUrl, schema: env('SOAK_BOSS_SCHEMA', 'soak_boss') })
  return new MemoryTransport()
}

const postgresUrl = env('SOAK_PG_URL')
const sql = await connect(postgresUrl, { max: 6 })

// Every fenced write is recorded, and the recording happens *inside* the fence. That is what
// makes the soak's central assertion checkable after the fact: if two owners ever hold one
// slice at once, both of their rows are here to prove it.
registry.register(
  resolveKind<unknown, { done: number }>({
    kind: SOAK_KIND,
    queue: SOAK_QUEUE,
    orphanPolicy: 'redrive',
    // Short, so a killed replica is noticed in seconds rather than a minute.
    lease: { ttlMs: 6_000, sliceBudgetMs: 8_000, pendingTtlMs: 20_000 },
    budget: { poisonRedrivesWithoutCommit: 50, maxRedrives: 50, maxConsecutiveFailures: 50 },
    retry: { attempts: 20, backoff: { type: 'fixed', delayMs: 250, maxDelayMs: 250 } },
    async step(ctx): Promise<SliceOutcome> {
      let done = ctx.checkpoint?.done ?? 0
      while (done < SOAK_BATCHES) {
        if (ctx.signal.aborted || ctx.shouldYield()) return 'budget'
        await new Promise((resolve) => setTimeout(resolve, 25))

        await ctx.fencedWrite(async (tx) => {
          await tx.query(
            `insert into soak_audit (id, job_id, seq, batch, owner, at) values ($1, $2, $3, $4, $5, now())`,
            [randomUUID(), ctx.job.id, ctx.job.continuationSeq, done, ctx.lease.owner],
          )
        })

        done += 1
        await ctx.checkpoint_({ done }, { processedCount: done, totalCount: SOAK_BATCHES })
      }
      return 'drained'
    },
  }),
)

const transport = await makeTransport(env('SOAK_TRANSPORT', 'memory'), postgresUrl, process.env.HARNESS_REDIS_URL ?? null)

const worker = await startWorker({
  sql,
  transport,
  registry,
  concurrency: Number(env('SOAK_CONCURRENCY', '3')),
  tickMs: 2_000,
  reconcilerGraceMs: 2_000,
  log: (event, fields) => {
    if (event.includes('parked') || event.includes('lease_lost')) process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`)
  },
})

process.stdout.write(`${JSON.stringify({ event: 'replica.ready', owner: worker.owner })}\n`)
await new Promise(() => undefined)
