// How a `data_sync` run becomes durable work without core's engine being changed or copied.
//
// Core's engine already survives being displaced by another worker: it asks a cancellation
// question at every batch boundary, and it stays silent when a terminal write is refused. A
// durable adopter is exactly a worker in that position, so all this does is answer those two
// questions differently — and route the cursor commit through the lease fence.
//
// See docs/adr/0004: the original plan was to fork the batch loop. Reading the engine showed
// the seams were already there.

import type { SliceContext, SliceOutcome, SqlExecutor } from '@fullstackhouse/open-mercato-durable-work'

export type SyncScope = { tenantId: string; organizationId: string | null; userId?: string | null }
export type SyncTerminalStatus = 'completed' | 'failed' | 'cancelled'

/** The subset of core's run service this decorator wraps. Structural, so the package does not
 *  bind to a concrete class it only needs three methods of. */
export type SyncRunServiceLike = {
  getRun(runId: string, scope: SyncScope): Promise<{ status: string; progressJobId?: string | null } | null>
  markStatus(runId: string, status: string, scope: SyncScope, error?: string): Promise<unknown>
  commitBatchProgress(
    runId: string,
    delta: Record<string, unknown>,
    cursor: unknown,
    scope: SyncScope,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

export type ProgressServiceLike = {
  isCancellationRequested(progressJobId: string, tenantId: string, organizationId: string | null): Promise<boolean>
}

/** What core's engine tried to do, captured rather than applied. */
export type CapturedOutcome = { status: SyncTerminalStatus; error?: string } | null

export type SliceRecorder = {
  runService: SyncRunServiceLike
  progressService: ProgressServiceLike
  /** What the engine tried to finalize the run as, if anything. */
  captured(): CapturedOutcome
  /** Why the slice stopped early, when it did. */
  stopReason(): 'budget' | 'cancelled' | null
  /** Batches whose cursor this slice committed. Zero means the slice made no progress. */
  committedBatches(): number
}

/**
 * Wraps core's two services for the duration of one slice.
 *
 * @param ctx  the slice this recorder belongs to; its lease is what fences the cursor commits
 */
export function recordSlice(
  ctx: SliceContext,
  runService: SyncRunServiceLike,
  progressService: ProgressServiceLike,
): SliceRecorder {
  let captured: CapturedOutcome = null
  let stopReason: 'budget' | 'cancelled' | null = null
  let committed = 0

  return {
    captured: () => captured,
    stopReason: () => stopReason,
    committedBatches: () => committed,

    runService: {
      getRun: (runId, scope) => runService.getRun(runId, scope),

      /**
       * Records a terminal transition instead of performing it, and answers with the run
       * unchanged.
       *
       * Core's `finalizeRun` compares what comes back to what it asked for, and stays silent
       * when they differ — the branch it has for "another worker already finalized this". So
       * this both captures the outcome and suppresses the progress write, the operational log
       * and the lifecycle event, leaving all three to the durable terminal transition, which
       * writes them in the same transaction as the job's own terminal state.
       */
      async markStatus(runId, status, scope, error) {
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          captured = { status, error }
          return runService.getRun(runId, scope)
        }
        return runService.markStatus(runId, status, scope, error)
      },

      /**
       * Commits the batch cursor under the lease.
       *
       * This is the write that must not outlive the right to make it: a worker whose lease
       * expired mid-batch would otherwise advance the cursor of a run another worker is now
       * driving, and the two would interleave over one stream.
       */
      async commitBatchProgress(runId, delta, cursor, scope, options) {
        const result = await ctx.fencedWrite(async () => runService.commitBatchProgress(runId, delta, cursor, scope, options))
        committed += 1
        // A committed unit of work resets the failure and orphan budgets: a run that is making
        // progress has not earned the suspicion those counters represent, however many times
        // it was interrupted getting there.
        await ctx.heartbeat({ committed: true })
        return result
      },
    },

    progressService: {
      /**
       * Core asks this once per batch and stops the stream cleanly when it is true. That makes
       * it the slice's hand-back point as well as its cancellation point — the two need the
       * same clean stop, and differ only in what happens afterwards.
       */
      async isCancellationRequested(progressJobId, tenantId, organizationId) {
        if (await progressService.isCancellationRequested(progressJobId, tenantId, organizationId)) {
          stopReason = 'cancelled'
          return true
        }
        if (ctx.signal.aborted || ctx.shouldYield()) {
          stopReason = 'budget'
          return true
        }
        return false
      },
    },
  }
}

/** A run that ended `failed` inside core's engine. Thrown so the durable error taxonomy and the
 *  retry budget apply to it, instead of the run being thrown away at the first blip. */
export class SyncRunFailedError extends Error {
  readonly durableErrorClass = 'transient' as const
  constructor(
    readonly runId: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncRunFailedError'
  }
}

/** Turns what the recorder saw into the outcome the mechanism understands. */
export function outcomeOf(recorder: SliceRecorder, runId: string): SliceOutcome {
  const captured = recorder.captured()

  if (recorder.stopReason() === 'budget') return 'budget'
  if (recorder.stopReason() === 'cancelled') return 'cancelled'

  if (!captured) {
    // The engine returned without finalizing: the run was already terminal, or missing. Either
    // way there is nothing left for this slice to do.
    return 'drained'
  }
  if (captured.status === 'failed') throw new SyncRunFailedError(runId, captured.error ?? 'Sync run failed')
  if (captured.status === 'cancelled') return 'cancelled'
  return 'drained'
}

/** Maps a durable terminal state onto the run's own, inside the terminal transaction. */
export async function mirrorRunStatus(
  tx: SqlExecutor,
  runId: string,
  status: SyncTerminalStatus,
  errorMessage: string | null,
): Promise<{ matched: number }> {
  // Fenced on the run still being open, so a run finished by another path is not overwritten —
  // "mirrored" means the domain row agrees, and a row that already disagrees for a good reason
  // must not be forced.
  const result = await tx.query(
    `update sync_runs
        set status = $2, last_error = $3, updated_at = now()
      where id = $1 and deleted_at is null and status in ('pending','running')`,
    [runId, status, errorMessage],
  )
  return { matched: result.rowCount }
}

/** Re-opens a run when an operator re-drives its job. The mirror image of the above. */
export async function reopenRun(tx: SqlExecutor, runId: string): Promise<{ matched: number }> {
  const result = await tx.query(
    `update sync_runs
        set status = 'running', last_error = null, updated_at = now()
      where id = $1 and deleted_at is null and status in ('failed','pending','running')`,
    [runId],
  )
  return { matched: result.rowCount }
}
