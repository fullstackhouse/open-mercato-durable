// The child process a kill-test kills. Claims one job and runs one slice, announcing each
// committed batch on stdout so the parent can kill it at an exact point in the work.
//
// Deliberately has no shutdown handling. A process that tidies up on the way out would prove
// only that tidy shutdowns work, and the failure worth defending against is the untidy one.

import { makeOwnerId, resolveKind, runSlice, type SliceOutcome } from '@fullstackhouse/open-mercato-durable-work'

import { connect } from './db'

const env = (name: string, fallback?: string): string => {
  const value = process.env[name]
  if (value == null || value === '') {
    if (fallback !== undefined) return fallback
    throw new Error(`${name} is required`)
  }
  return value
}

const jobId = env('REPLICA_JOB_ID')
const batches = Number(env('REPLICA_BATCHES'))
const batchMs = Number(env('REPLICA_BATCH_MS'))
const label = env('REPLICA_LABEL', 'replica')

const sql = await connect(env('REPLICA_PG_URL'), { max: 2 })

const kind = resolveKind<unknown, { done: number }>({
  kind: 'test.replica',
  queue: 'durable-work.test',
  orphanPolicy: 'redrive',
  lease: { ttlMs: 6_000 },
  async step(ctx): Promise<SliceOutcome> {
    let done = ctx.checkpoint?.done ?? 0
    while (done < batches) {
      if (ctx.signal.aborted) return 'budget'
      await new Promise((resolve) => setTimeout(resolve, batchMs))
      done += 1
      await ctx.checkpoint_({ done }, { processedCount: done, totalCount: batches })
      // Announced only after the checkpoint has committed, so "the parent saw batch N" and
      // "batch N is durable" are the same statement — which is what the assertion rests on.
      process.stdout.write(`committed ${done}\n`)
    }
    return 'drained'
  },
})

const controller = new AbortController()
const result = await runSlice(
  { sql, kind, owner: makeOwnerId(label) },
  { jobId, seq: Number(env('REPLICA_SEQ', '0')), redrives: Number(env('REPLICA_REDRIVES', '0')) },
  { tenantId: env('REPLICA_TENANT_ID'), organizationId: process.env.REPLICA_ORG_ID || null },
  {
    transportJobId: `replica-${jobId}`,
    attempt: 1,
    maxAttempts: 5,
    signal: controller.signal,
    handBack: async () => undefined,
  },
).catch((error) => ({ outcome: 'threw' as const, error: String(error) }))

process.stdout.write(`result ${JSON.stringify(result)}\n`)
await sql.end()
