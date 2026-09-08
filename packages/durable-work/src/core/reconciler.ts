// The server-side repair loop: what makes "no job stays running forever" true.
//
// Three queries, in a fixed order, each selecting a bounded batch with `for update skip
// locked` in its own short transaction. The order is not cosmetic — see the note on Q3.
//
// Everything here is decided from the row, never from anything a process remembers. That is
// what lets any process run the reconciler, lets two run at once, and lets the whole fleet
// restart without losing track of a single job.

import { errorMessageOf } from './errors'
import type { KindRegistry, ResolvedKind } from './registry'
import { runAfterTransition, runTerminalTransition } from './terminal'
import {
  cancelPending,
  markMirrored,
  park,
  redrivePending,
  selectCancelling,
  selectOrphans,
  selectStalePending,
  takeOrphan,
} from './store'
import type { DurableJob, Lease, Scope, SqlTransactor } from './types'

export type ReconcileReport = {
  scanned: number
  cancelled: number
  redriven: number
  parked: number
  errors: number
}

export type ReconcilerDeps = {
  sql: SqlTransactor
  registry: KindRegistry
  /** Enqueues a delivery for a job that has just been re-driven. */
  enqueue: (job: DurableJob) => Promise<void>
  /** How long past its expiry a lease is tolerated before the job counts as orphaned. Short,
   *  because lease expiry is a database-clock fact about a driver. */
  graceMs?: number
  batchSize?: number
  /** Repair only this tenant's jobs. Unset means every tenant, which is what a single worker
   *  should do; set it to shard the loop across a fleet. */
  tenantId?: string
  log?: (event: string, fields: Record<string, unknown>) => void
}

const DEFAULT_GRACE_MS = 20_000
const DEFAULT_BATCH = 100
/** Backoff between successive re-drives of the same job, so a job that keeps orphaning does
 *  not spin. Doubles per re-drive since the last committed unit, capped. */
const REDRIVE_BASE_MS = 15_000
const REDRIVE_CAP_MS = 600_000

const scopeOf = (job: DurableJob): Scope => ({ tenantId: job.tenantId, organizationId: job.organizationId })
const leaseOf = (job: DurableJob): Lease => ({ jobId: job.id, owner: job.leaseOwner ?? 'reconciler', epoch: job.leaseEpoch, ttlMs: 0 })

/**
 * One pass. Safe to run concurrently with itself: every query takes its rows with
 * `skip locked`, so two reconcilers partition the work rather than fighting over it.
 */
export async function reconcileOnce(deps: ReconcilerDeps): Promise<ReconcileReport> {
  const report: ReconcileReport = { scanned: 0, cancelled: 0, redriven: 0, parked: 0, errors: 0 }
  const limit = deps.batchSize ?? DEFAULT_BATCH
  const graceMs = deps.graceMs ?? DEFAULT_GRACE_MS

  // Q3 — cancellations first.
  //
  // A running job whose driver died after an operator asked to cancel it matches both "dead
  // cancel" and "orphan". Without a precedence, the orphan query would park it as orphaned
  // with the cancellation never honoured, or re-drive it — restarting work somebody
  // explicitly asked to stop. So cancellations are settled before anything else looks.
  for (const job of await select(deps, (tx) => selectCancelling(tx, limit, deps.tenantId))) {
    report.scanned += 1
    try {
      if (await endCancelled(deps, job)) report.cancelled += 1
    } catch (error) {
      report.errors += 1
      deps.log?.('durable_work.reconcile_cancel_failed', { jobId: job.id, error: errorMessageOf(error) })
    }
  }

  // Q1 — orphans: a job whose driver stopped heartbeating.
  for (const job of await select(deps, (tx) => selectOrphans(tx, { graceMs, pendingTtlMs: widestPendingTtl(deps), limit, tenantId: deps.tenantId }))) {
    report.scanned += 1
    try {
      const outcome = await repairOrphan(deps, job, graceMs)
      if (outcome === 'redriven') report.redriven += 1
      if (outcome === 'parked') report.parked += 1
    } catch (error) {
      report.errors += 1
      deps.log?.('durable_work.reconcile_orphan_failed', { jobId: job.id, error: errorMessageOf(error) })
    }
  }

  // Q2 — pending jobs whose delivery never arrived: a lost hand-back, or an enqueue that
  // never reached the broker because the process died between commit and enqueue.
  for (const job of await select(deps, (tx) => selectStalePending(tx, { pendingTtlMs: widestPendingTtl(deps), limit, tenantId: deps.tenantId }))) {
    report.scanned += 1
    try {
      const outcome = await repairPending(deps, job)
      if (outcome === 'redriven') report.redriven += 1
      if (outcome === 'parked') report.parked += 1
    } catch (error) {
      report.errors += 1
      deps.log?.('durable_work.reconcile_pending_failed', { jobId: job.id, error: errorMessageOf(error) })
    }
  }

  return report
}

/** Selection commits — and so releases its locks — before any per-row work runs. Holding a
 *  row lock across a domain mirror would block a second reconciler for the length of that
 *  mirror, and turn a slow domain into a stalled repair loop. */
async function select(deps: ReconcilerDeps, query: (tx: Parameters<Parameters<SqlTransactor['transaction']>[0]>[0]) => Promise<DurableJob[]>): Promise<DurableJob[]> {
  return deps.sql.transaction(query)
}

/** Selection is a coarse filter, so it uses the widest tolerance any registered kind declares
 *  and lets the per-row statements re-check with that row's own kind. Selecting on the
 *  narrowest instead would silently exclude jobs of a more tolerant kind from being repaired
 *  at all; over-selecting only costs a re-check. */
function widestPendingTtl(deps: ReconcilerDeps): number {
  const kinds = deps.registry.list()
  return kinds.length ? Math.max(...kinds.map((k) => k.lease.pendingTtlMs)) : 900_000
}

async function endCancelled(deps: ReconcilerDeps, job: DurableJob): Promise<boolean> {
  const kind = deps.registry.get(job.kind)

  if (job.status === 'pending') {
    // No lease to fence on; `pending` is the fence.
    const ended = await deps.sql.transaction(async (tx) => {
      const row = await cancelPending(tx, job.id)
      if (!row) return null
      if (kind?.onCancel) await kind.onCancel(row, scopeOf(row), tx)
      if (kind?.onTransition) {
        const { matched } = await kind.onTransition(row, scopeOf(row), tx)
        if (matched < 1) throw new Error(`Domain mirror matched no rows for job ${row.id}`)
      }
      await markMirrored(tx, row.id)
      return row
    })
    if (!ended) return false
    if (kind) await runAfterTransition(kind, ended, scopeOf(ended))
    deps.log?.('durable_work.job_cancelled', { jobId: job.id, by: 'reconciler' })
    return true
  }

  // A `running` job whose lease has expired: nobody is driving it, so the reconciler settles
  // the cancellation on its behalf. A live lease is left alone — its own slice will observe
  // the request at the next heartbeat, which is both faster and safer.
  if (job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()) return false

  if (!kind) {
    const parked = await park(deps.sql, job.id, 'no_handler', 'No handler registered for this kind')
    return parked != null
  }
  const result = await runTerminalTransition(deps.sql, kind, leaseOf(job), scopeOf(job), { type: 'cancel' })
  if (!result) return false
  await runAfterTransition(kind, result.job, scopeOf(result.job))
  deps.log?.('durable_work.job_cancelled', { jobId: job.id, by: 'reconciler' })
  return true
}

async function repairOrphan(deps: ReconcilerDeps, job: DurableJob, graceMs: number): Promise<'redriven' | 'parked' | 'skipped'> {
  const kind = deps.registry.get(job.kind)

  // In order; the first match wins.
  if (!kind) return (await parkJob(deps, job, undefined, 'no_handler', 'No handler registered for this kind')) ? 'parked' : 'skipped'
  if (job.errorCode === 'unrecoverable' || job.errorCode === 'retry_exhausted') {
    // The slice already reached a conclusion but could not commit it. Park with that verdict
    // preserved — the orphan policy is never consulted for a job that has already decided.
    return (await parkJob(deps, job, kind, job.errorCode, job.errorMessage)) ? 'parked' : 'skipped'
  }
  if (kind.orphanPolicy !== 'redrive') {
    return (await parkJob(deps, job, kind, 'orphaned', job.errorMessage ?? 'Worker stopped without releasing the lease')) ? 'parked' : 'skipped'
  }
  if (job.redrivesSinceCommit >= kind.budget.poisonRedrivesWithoutCommit) {
    // Re-driven this many times without committing anything: the job is not making progress
    // and re-running it again is guessing. A human decides from here.
    return (await parkJob(deps, job, kind, 'poison', 'Re-driven repeatedly without committing progress')) ? 'parked' : 'skipped'
  }

  const backoffMs = Math.min(REDRIVE_BASE_MS * 2 ** job.redrivesSinceCommit, REDRIVE_CAP_MS)
  const taken = await takeOrphan(deps.sql, job.id, { graceMs, pendingTtlMs: kind.lease.pendingTtlMs, backoffMs })
  if (!taken) return 'skipped' // the row moved under us; another pass will see it
  await deps.enqueue(taken)
  deps.log?.('durable_work.job_orphaned', { jobId: job.id, redrives: taken.redrives, backoffMs })
  return 'redriven'
}

async function repairPending(deps: ReconcilerDeps, job: DurableJob): Promise<'redriven' | 'parked' | 'skipped'> {
  const kind = deps.registry.get(job.kind)
  if (!kind) return (await parkJob(deps, job, undefined, 'no_handler', 'No handler registered for this kind')) ? 'parked' : 'skipped'

  // A lost hand-back is cheap and is not evidence that the work is bad, so this budget is
  // deliberately wider than the poison budget the orphan path uses.
  if (job.redrivesSinceCommit >= kind.budget.maxRedrives) {
    return (await parkJob(deps, job, kind, 'never_started', 'Delivery never arrived after repeated re-drives')) ? 'parked' : 'skipped'
  }

  const redriven = await redrivePending(deps.sql, job.id, { pendingTtlMs: kind.lease.pendingTtlMs })
  if (!redriven) return 'skipped'
  await deps.enqueue(redriven)
  deps.log?.('durable_work.job_redriven', { jobId: job.id, redrives: redriven.redrives, reason: 'never_started' })
  return 'redriven'
}

/** Parks through the terminal protocol when the kind has a mirror to run, and through the
 *  plain statement when it does not — an unregistered kind has no domain row to agree with,
 *  so "no mirror" is a satisfied mirror rather than a pending one. */
async function parkJob(
  deps: ReconcilerDeps,
  job: DurableJob,
  kind: ResolvedKind | undefined,
  reason: string,
  message: string | null,
): Promise<boolean> {
  if (!kind?.onTransition) {
    const parked = await park(deps.sql, job.id, reason as never, message)
    if (parked) {
      await deps.sql.query(`update durable_work_jobs set domain_mirrored_at = now() where id = $1`, [job.id])
      deps.log?.('durable_work.job_parked', { jobId: job.id, reason })
    }
    return parked != null
  }

  const parked = await deps.sql.transaction(async (tx) => {
    const row = await park(tx, job.id, reason as never, message)
    if (!row) return null
    const { matched } = await kind.onTransition!(row, scopeOf(row), tx)
    if (matched < 1) throw new Error(`Domain mirror matched no rows for job ${row.id}`)
    await markMirrored(tx, row.id)
    return row
  })
  if (!parked) return false
  await runAfterTransition(kind, parked, scopeOf(parked))
  deps.log?.('durable_work.job_parked', { jobId: job.id, reason })
  return true
}
