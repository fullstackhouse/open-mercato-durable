// The worker process: binds each kind's queue, runs the reconciler tick, and drains on
// shutdown instead of being killed mid-batch.

import { deliveryId, makeOwnerId, parseDeliveryId, queueNameFor } from './ids'
import { errorMessageOf, NoFurtherAttempts } from './errors'
import { reconcileOnce, type ReconcileReport } from './reconciler'
import { registry as globalRegistry, type KindRegistry, type ResolvedKind } from './registry'
import { runSlice } from './run-slice'
import { getJob, recordEnqueue } from './store'
import type { DurableJob, Delivery, Scope, SqlTransactor } from './types'
import type { BoundWorker, TransportAdapter } from '../transport/types'

export const RECONCILE_TICK_ID = 'durable-work-reconcile'
export const RECONCILE_QUEUE = queueNameFor('reconcile')

export type WorkerOptions = {
  sql: SqlTransactor
  transport: TransportAdapter
  registry?: KindRegistry
  /** Restrict this process to a subset of kinds. Everything registered runs by default. */
  kinds?: string[]
  concurrency?: number
  /** How often the reconciler runs. */
  tickMs?: number
  reconcilerGraceMs?: number
  drainTimeoutMs?: number
  owner?: string
  log?: (event: string, fields: Record<string, unknown>) => void
}

export type DurableWorker = {
  owner: string
  /** Runs one reconciler pass immediately. Exposed for the CLI and for tests that would
   *  otherwise have to wait out a tick. */
  reconcile(): Promise<ReconcileReport>
  stop(): Promise<void>
}

/** Enqueues a delivery for a job, and records the id so a cancellation can remove it. */
export async function enqueueJob(
  sql: SqlTransactor,
  transport: TransportAdapter,
  kind: ResolvedKind,
  job: DurableJob,
  opts: { tx?: Parameters<typeof recordEnqueue>[0] } = {},
): Promise<void> {
  const delivery: Delivery = { jobId: job.id, seq: job.continuationSeq, redrives: job.redrives }
  // The delay comes from the row's own `next_run_at`, computed on the database clock. Reading
  // it back as a duration here — rather than passing a timestamp to the broker — keeps the
  // two clocks from having to agree.
  const delayMs = job.nextRunAt ? Math.max(0, job.nextRunAt.getTime() - Date.now()) : 0
  const { transportJobId } = await transport.enqueue(job.queueName ?? kind.queue, delivery, {
    delayMs,
    retry: kind.retry,
    tx: opts.tx,
  })
  await recordEnqueue(opts.tx ?? sql, job.id, transportJobId, job.queueName ?? kind.queue)
}

export async function startWorker(options: WorkerOptions): Promise<DurableWorker> {
  const registry = options.registry ?? globalRegistry
  const owner = options.owner ?? makeOwnerId()
  const log = options.log ?? (() => undefined)
  const { sql, transport } = options

  const kinds = registry.list().filter((k) => !options.kinds || options.kinds.includes(k.kind))
  const byQueue = new Map<string, ResolvedKind[]>()
  for (const kind of kinds) byQueue.set(kind.queue, [...(byQueue.get(kind.queue) ?? []), kind])

  const bound: BoundWorker[] = []

  for (const [queue, queueKinds] of byQueue) {
    const concurrency = options.concurrency ?? Math.max(...queueKinds.map((k) => k.concurrency))
    // The broker must tolerate a delivery being in flight for longer than a whole slice, or it
    // redelivers work that is still running — which the lease then refuses, wasting the slice.
    const activeTimeoutMs = Math.max(...queueKinds.map((k) => k.lease.sliceBudgetMs)) * 2

    bound.push(
      await transport.bind(
        queue,
        async (delivery, ctx) => {
          const job = await loadJob(sql, delivery)
          if (!job) {
            log('durable_work.delivery_orphaned', { jobId: delivery.jobId, queue })
            return
          }
          const kind = registry.get(job.kind)
          if (!kind) {
            // Nothing in this process can run it. Leave it alone rather than failing it: a
            // rolling deploy legitimately has processes that do not yet know a new kind, and
            // the reconciler parks it if nobody ever claims it.
            log('durable_work.no_handler', { jobId: job.id, kind: job.kind })
            return
          }
          const scope: Scope = { tenantId: job.tenantId, organizationId: job.organizationId }
          const result = await runSlice({ sql, kind, owner, log }, delivery, scope, ctx)
          if (result.outcome === 'yielded' && !ctx.signal.aborted) {
            // The transport's hand-back may have been refused (a lock lost at exactly the
            // wrong moment). The row is already `pending` at the next seq, so re-enqueuing
            // under the new identity cannot collide with anything the broker still holds.
            const current = await getJob(sql, job.id, scope)
            if (current && current.status === 'pending') await enqueueJob(sql, transport, kind, current).catch((error) => {
              log('durable_work.reenqueue_failed', { jobId: job.id, error: errorMessageOf(error) })
            })
          }
        },
        { concurrency, activeTimeoutMs },
      ),
    )
  }

  const reconcile = () =>
    reconcileOnce({
      sql,
      registry,
      graceMs: options.reconcilerGraceMs,
      log,
      enqueue: async (job) => {
        const kind = registry.get(job.kind)
        if (kind) await enqueueJob(sql, transport, kind, job)
      },
    })

  // The tick is a repeating delivery owned by the broker rather than a job that re-enqueues
  // itself: a self-re-enqueue is lost the moment one tick fails, and nothing would notice.
  let tickWorker: BoundWorker | null = null
  if (options.tickMs !== 0) {
    tickWorker = await transport.bind(
      RECONCILE_QUEUE,
      async () => {
        const report = await reconcile()
        if (report.scanned) log('durable_work.reconciled', report as unknown as Record<string, unknown>)
      },
      { concurrency: 1, activeTimeoutMs: 120_000 },
    )
    await transport.upsertTick({ id: RECONCILE_TICK_ID, queue: RECONCILE_QUEUE, everyMs: options.tickMs ?? 15_000 })
    bound.push(tickWorker)
  }

  return {
    owner,
    reconcile,
    async stop() {
      // Close the transport first: it stops accepting new deliveries and aborts the signal
      // every in-flight slice is watching, so they hand back at their next boundary rather
      // than being cut off between two writes.
      await transport.close({ timeoutMs: options.drainTimeoutMs ?? 30_000 })
      await Promise.allSettled(bound.map((worker) => worker.close({ timeoutMs: options.drainTimeoutMs ?? 30_000 })))
    },
  }
}

async function loadJob(sql: SqlTransactor, delivery: Delivery): Promise<DurableJob | null> {
  // The delivery carries only ids, so the row is read unscoped here and every statement after
  // it re-scopes from the row's own tenant. A delivery cannot name a scope it should not see:
  // it can only name a job id that already exists.
  const result = await sql.query<Record<string, unknown>>(
    `select tenant_id, organization_id from durable_work_jobs where id = $1`,
    [delivery.jobId],
  )
  if (!result.rows.length) return null
  const row = result.rows[0]!
  return getJob(sql, delivery.jobId, {
    tenantId: String(row.tenant_id),
    organizationId: row.organization_id == null ? null : String(row.organization_id),
  })
}

export { deliveryId, parseDeliveryId, NoFurtherAttempts }
