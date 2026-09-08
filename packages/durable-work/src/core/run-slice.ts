// The worker body: what happens between a delivery arriving and the job row being right again.
//
// The shape is dictated by one rule — after every fenced statement, "matched zero rows" means
// somebody else owns this job now. When that happens the delivery ends *quietly*: no
// hand-back (it would redeliver an identity the row refuses), no rethrow (that costs a
// transport attempt and redelivers the same refused identity), no failure counted (the row is
// not ours to count against). The new driver owns the row and this delivery is history.

import { LeaseLostError, NoFurtherAttempts, classifyError, errorCodeOf, errorMessageOf } from './errors'
import { nextAttemptDelayMs, type ResolvedKind, type SliceContext } from './registry'
import { sliceIdempotencyKey } from './ids'
import {
  assertLease,
  claim,
  failSlice,
  heartbeat,
  releaseLease,
  writeCheckpoint,
  yieldSlice,
} from './store'
import { runAfterTransition, runTerminalTransition } from './terminal'
import type { Delivery, DurableJob, Lease, Scope, SliceOutcome, SqlExecutor, SqlTransactor } from './types'
import type { HandlerContext } from '../transport/types'

export type RunSliceDeps = {
  sql: SqlTransactor
  kind: ResolvedKind
  owner: string
  /** Structured observability. Every branch below reports; silence is the one outcome that
   *  would make a stuck job impossible to explain after the fact. */
  log?: (event: string, fields: Record<string, unknown>) => void
  now?: () => number
}

export type RunSliceResult =
  | { outcome: 'refused'; reason: 'identity' | 'leased' }
  | { outcome: 'lease_lost' }
  | { outcome: 'completed' }
  | { outcome: 'failed'; verdict: 'unrecoverable' | 'retry_exhausted' }
  | { outcome: 'cancelled' }
  | { outcome: 'yielded'; seq: number; redrives: number }
  | { outcome: 'retry' }

/**
 * Runs one slice of one job.
 *
 * @param delivery what the transport delivered — the identity that has to still match the row
 * @param ctx      the transport's handle on this delivery (attempt number, signal, hand-back)
 */
export async function runSlice(
  deps: RunSliceDeps,
  delivery: Delivery,
  scope: Scope,
  ctx: HandlerContext,
): Promise<RunSliceResult> {
  const { sql, kind, owner } = deps
  const log = deps.log ?? (() => undefined)
  const now = deps.now ?? (() => Date.now())

  const claimed = await claim(sql, delivery.jobId, scope, delivery, owner, kind.lease.ttlMs)
  if (!claimed) {
    // Either the identity moved on (a straggling redelivery) or the lease is still alive
    // (a duplicate delivery racing its twin). Both end the same way; the distinction is
    // recorded because it is the difference between a broker quirk and a real overlap.
    log('durable_work.delivery_refused', { jobId: delivery.jobId, seq: delivery.seq, redrives: delivery.redrives })
    return { outcome: 'refused', reason: 'identity' }
  }

  const lease: Lease = { jobId: claimed.id, owner, epoch: claimed.leaseEpoch, ttlMs: kind.lease.ttlMs }
  const abort = new AbortController()
  const deadline = now() + kind.lease.sliceBudgetMs
  let cancelObserved = false
  let leaseLost = false

  const onExternalAbort = () => abort.abort()
  ctx.signal.addEventListener('abort', onExternalAbort, { once: true })

  // The heartbeat is what keeps the lease alive and what notices a cancellation. A third of
  // the TTL leaves room for two missed beats before anyone else may take the job.
  const beat = async (patch?: Parameters<typeof heartbeat>[2]) => {
    const result = await heartbeat(sql, lease, patch)
    if (!result) {
      leaseLost = true
      abort.abort()
      throw new LeaseLostError(lease)
    }
    if (result.cancelRequested && !cancelObserved) {
      cancelObserved = true
      abort.abort()
    }
  }
  const timer = setInterval(() => {
    void beat().catch(() => undefined)
  }, Math.max(1_000, Math.floor(kind.lease.ttlMs / 3)))
  timer.unref?.()

  const finish = () => {
    clearInterval(timer)
    ctx.signal.removeEventListener('abort', onExternalAbort)
  }

  try {
    // A verdict already on the claimed row means a previous delivery decided this job is over
    // but could not commit that decision — the domain mirror failed. Retry the decision, never
    // the work: the page that produced the verdict is not run again.
    const verdict = claimed.errorCode
    if (verdict === 'unrecoverable' || verdict === 'retry_exhausted') {
      return await retryTerminalFail(deps, claimed, lease, scope, ctx, verdict, log)
    }

    // The step's errors and the terminal paths' errors need opposite handling, so they are
    // caught separately. Collapsing them into one catch let an error raised *by* the cancel
    // path fall back into that same path and mirror the cancellation twice.
    let outcome: SliceOutcome
    try {
      outcome = await kind.step(makeContext(deps, claimed, lease, scope, abort, deadline, beat, now))
    } catch (error) {
      if (leaseLost || error instanceof LeaseLostError) {
        log('durable_work.lease_lost', { jobId: lease.jobId, seq: delivery.seq, redrives: delivery.redrives, epoch: lease.epoch })
        return { outcome: 'lease_lost' }
      }
      if (cancelObserved) return await cancel(deps, lease, scope, ctx, log)
      // An abort from the transport (shutdown) is not a failure: hand the rest back so the
      // next process resumes from the committed cursor rather than replaying the slice.
      if (ctx.signal.aborted) return await handBack(deps, lease, ctx, { interrupted: true }, log)
      return await fail(deps, lease, scope, ctx, error, log)
    }

    switch (cancelObserved ? 'cancelled' : outcome) {
      case 'drained':
        try {
          return await complete(deps, lease, scope, ctx, log)
        } catch (error) {
          // A mirror rollback on the completion path IS treated as a slice failure: the work
          // is done but the system does not yet agree it is, and retrying the slice is how
          // that gets resolved — `step` runs, finds nothing left, drains again, and the
          // terminal transaction is retried. The cancellation path deliberately differs.
          return await fail(deps, lease, scope, ctx, error, log)
        }
      case 'cancelled':
        return await cancel(deps, lease, scope, ctx, log)
      case 'budget':
        return await handBack(deps, lease, ctx, { interrupted: ctx.signal.aborted }, log)
    }
  } finally {
    finish()
  }
}

function makeContext(
  deps: RunSliceDeps,
  job: DurableJob,
  lease: Lease,
  scope: Scope,
  abort: AbortController,
  deadline: number,
  beat: (patch?: Parameters<typeof heartbeat>[2]) => Promise<void>,
  now: () => number,
): SliceContext {
  const { sql, kind } = deps
  return {
    job,
    scope,
    lease,
    input: job.input,
    checkpoint: job.checkpoint ?? null,
    signal: abort.signal,
    budgetMs: kind.lease.sliceBudgetMs,
    idempotencyKey: sliceIdempotencyKey(job.id, job.continuationSeq),
    heartbeat: beat,
    checkpoint_: async (state, patch) => {
      const ok = await writeCheckpoint(sql, lease, state, patch)
      if (!ok) {
        abort.abort()
        throw new LeaseLostError(lease)
      }
    },
    fencedWrite: async <T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => {
      return sql.transaction(async (tx) => {
        // Asserted *inside* the transaction, before the caller's writes, so the lease check
        // and those writes commit or roll back together. Checking it outside would prove only
        // that the lease was held a moment before.
        if (!(await assertLease(tx, lease))) {
          abort.abort()
          throw new LeaseLostError(lease)
        }
        return fn(tx)
      })
    },
    shouldYield: () => abort.signal.aborted || now() >= deadline,
  }
}

async function complete(
  deps: RunSliceDeps,
  lease: Lease,
  scope: Scope,
  ctx: HandlerContext,
  log: NonNullable<RunSliceDeps['log']>,
): Promise<RunSliceResult> {
  const result = await runTerminalTransition(deps.sql, deps.kind, lease, scope, { type: 'complete' })
  if (!result) {
    log('durable_work.lease_lost', { jobId: lease.jobId, at: 'complete' })
    return { outcome: 'lease_lost' }
  }
  log('durable_work.job_completed', { jobId: lease.jobId })
  await runAfterTransition(deps.kind, result.job, scope, (e) => log('durable_work.after_transition_failed', { jobId: lease.jobId, error: errorMessageOf(e) }))
  void ctx
  return { outcome: 'completed' }
}

async function cancel(
  deps: RunSliceDeps,
  lease: Lease,
  scope: Scope,
  ctx: HandlerContext,
  log: NonNullable<RunSliceDeps['log']>,
): Promise<RunSliceResult> {
  try {
    const result = await runTerminalTransition(deps.sql, deps.kind, lease, scope, { type: 'cancel' })
    if (!result) return { outcome: 'lease_lost' }
    log('durable_work.job_cancelled', { jobId: lease.jobId })
    await runAfterTransition(deps.kind, result.job, scope, (e) => log('durable_work.after_transition_failed', { jobId: lease.jobId, error: errorMessageOf(e) }))
    return { outcome: 'cancelled' }
  } catch (error) {
    // A mirror failure during a cancellation is not a slice failure. Counting it would burn
    // the retry budget and could end the job as `failed` — but a cancellation must always end
    // as `cancelled`, or the operator who asked for it is told something untrue.
    await releaseLease(deps.sql, lease, { nextAttemptDelayMs: nextAttemptDelayMs(deps.kind, ctx.attempt) })
    log('durable_work.cancel_mirror_failed', { jobId: lease.jobId, error: errorMessageOf(error) })
    throw error
  }
}

async function handBack(
  deps: RunSliceDeps,
  lease: Lease,
  ctx: HandlerContext,
  opts: { interrupted: boolean },
  log: NonNullable<RunSliceDeps['log']>,
): Promise<RunSliceResult> {
  const next = await yieldSlice(deps.sql, lease, opts)
  if (!next) {
    log('durable_work.lease_lost', { jobId: lease.jobId, at: 'yield' })
    return { outcome: 'lease_lost' }
  }
  // The row is already `pending` at seq + 1, so this id cannot collide with anything the
  // broker still holds. If the hand-back itself fails, the reconciler is the backstop — which
  // is why it is safe to log and move on rather than unwind.
  try {
    await ctx.handBack({ jobId: lease.jobId, seq: next.seq, redrives: next.redrives })
  } catch (error) {
    log('durable_work.hand_back_failed', { jobId: lease.jobId, seq: next.seq, error: errorMessageOf(error) })
  }
  log('durable_work.job_yielded', { jobId: lease.jobId, seq: next.seq, interrupted: opts.interrupted })
  return { outcome: 'yielded', ...next }
}

async function fail(
  deps: RunSliceDeps,
  lease: Lease,
  scope: Scope,
  ctx: HandlerContext,
  error: unknown,
  log: NonNullable<RunSliceDeps['log']>,
): Promise<RunSliceResult> {
  const { sql, kind } = deps
  const errorClass = kind.classify?.(error) ?? classifyError(error)
  const delayMs = errorClass === 'transient' ? nextAttemptDelayMs(kind, ctx.attempt) : null

  const outcome = await failSlice(
    sql,
    lease,
    { message: errorMessageOf(error), code: errorCodeOf(error), class: errorClass },
    { nextAttemptDelayMs: delayMs, maxConsecutiveFailures: kind.budget.maxConsecutiveFailures },
  )
  if (!outcome) {
    log('durable_work.lease_lost', { jobId: lease.jobId, at: 'fail' })
    return { outcome: 'lease_lost' }
  }

  // A `terminal` error has no verdict of its own but must not be retried either; the statement
  // above only mints `retry_exhausted` and `unrecoverable`, so terminal is decided here.
  const verdict = outcome.verdict ?? (errorClass === 'terminal' ? 'retry_exhausted' : null)
  if (!verdict) {
    log('durable_work.slice_failed', { jobId: lease.jobId, consecutiveFailures: outcome.consecutiveFailures, error: errorMessageOf(error) })
    throw error // the transport retries this delivery; the released lease lets the retry claim
  }

  try {
    const result = await runTerminalTransition(sql, kind, lease, scope, {
      type: 'fail',
      code: verdict,
      class: errorClass,
      message: errorMessageOf(error),
    })
    if (!result) return { outcome: 'lease_lost' }
    log('durable_work.job_failed', { jobId: lease.jobId, verdict, error: errorMessageOf(error) })
    await runAfterTransition(kind, result.job, scope, (e) => log('durable_work.after_transition_failed', { jobId: lease.jobId, error: errorMessageOf(e) }))
    // Ends the delivery without a further attempt: the row is already `failed`, so a retry
    // would claim a row that refuses it and waste the attempt.
    throw new NoFurtherAttempts(verdict)
  } catch (terminalError) {
    if (terminalError instanceof NoFurtherAttempts) throw terminalError
    // The mirror failed. The row keeps the verdict and stays `running` with its lease
    // released, so the transport's next attempt re-runs the *decision* and never the work;
    // when the attempts run out the reconciler parks it with the verdict preserved.
    log('durable_work.terminal_mirror_failed', { jobId: lease.jobId, verdict, error: errorMessageOf(terminalError) })
    throw error
  }
}

/** A delivery that claimed a row already carrying a verdict: retry the decision, not the work. */
async function retryTerminalFail(
  deps: RunSliceDeps,
  job: DurableJob,
  lease: Lease,
  scope: Scope,
  ctx: HandlerContext,
  verdict: 'unrecoverable' | 'retry_exhausted',
  log: NonNullable<RunSliceDeps['log']>,
): Promise<RunSliceResult> {
  try {
    const result = await runTerminalTransition(deps.sql, deps.kind, lease, scope, {
      type: 'fail',
      code: verdict,
      class: job.errorClass ?? 'terminal',
      message: job.errorMessage,
    })
    if (!result) return { outcome: 'lease_lost' }
    log('durable_work.job_failed', { jobId: lease.jobId, verdict, retriedTerminal: true })
    await runAfterTransition(deps.kind, result.job, scope, (e) => log('durable_work.after_transition_failed', { jobId: lease.jobId, error: errorMessageOf(e) }))
    throw new NoFurtherAttempts(verdict)
  } catch (error) {
    if (error instanceof NoFurtherAttempts) throw error
    // This path re-acquired the lease (the claim did), and `failSlice` never ran — so nothing
    // else will release it. Without this release the row would sit under a live lease, every
    // remaining transport retry would be refused by `claim`, and the retry chain would end.
    await releaseLease(deps.sql, lease, { nextAttemptDelayMs: nextAttemptDelayMs(deps.kind, ctx.attempt) })
    log('durable_work.terminal_mirror_failed', { jobId: lease.jobId, verdict, retriedTerminal: true, error: errorMessageOf(error) })
    throw error
  }
}
