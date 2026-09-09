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

import { SeamBrokenError } from '../modules/data_sync/lib/version-guard'

export type SyncScope = { tenantId: string; organizationId: string | null; userId?: string | null }
export type SyncTerminalStatus = 'completed' | 'failed' | 'cancelled'

/** The methods this decorator *wraps*, not the whole service: core's engine calls plenty more,
 *  and they are passed through untouched. Anything not listed here is delegated. */
export type SyncRunServiceLike = {
  [method: string]: unknown
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
  [method: string]: unknown
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

    // Spread, not rebuilt.
    //
    // Core's engine calls far more than the three methods decorated here — `startJob`,
    // `updateProgress`, `touchJobHeartbeat`, `markCancelled` and others on the progress
    // service, and more of the run service besides. An object carrying only the overrides
    // looks fine to TypeScript through a structural type and then fails at the first
    // undecorated call, mid-run.
    runService: {
      ...runService,

      /**
       * Records a terminal transition instead of performing it, and answers with the run
       * unchanged.
       *
       * Core's `finalizeRun` compares what comes back to what it asked for, and stays silent
       * when they differ — the branch it has for "another worker already finalized this". So
       * this both captures the outcome and suppresses the progress write, the operational log
       * and the lifecycle event. The run's terminal status is then written by `onTransition`,
       * in the same transaction as the job's own; the three suppressed side effects are
       * replayed by `replayFinalize` after that commit, since an event inside a transaction
       * that can still roll back is a lie waiting to happen.
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
      ...progressService,

      /**
       * Mirrors the run's counters onto the durable job as they move.
       *
       * Core reports progress here after every committed batch. Without this the operator API
       * shows a job that is plainly running with `0 of null` processed, and the one place
       * somebody looks to see whether a multi-day backfill is advancing tells them nothing.
       */
      async updateProgress(progressJobId: string, patch: { processedCount?: number; totalCount?: number | null }, scope: unknown) {
        await ctx
          .heartbeat({ processedCount: patch?.processedCount, totalCount: patch?.totalCount ?? null })
          .catch(() => undefined)
        const inner = progressService.updateProgress as
          | ((id: string, patch: unknown, scope: unknown) => Promise<unknown>)
          | undefined
        return inner?.call(progressService, progressJobId, patch, scope)
      },

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

/**
 * Turns what the recorder saw into the outcome the mechanism understands.
 *
 * @param runStatus the run's status after the slice, used only to tell "already finished" from
 *                  "core finalized this itself" — see the seam check below
 */
export function outcomeOf(recorder: SliceRecorder, runId: string, runStatus?: string): SliceOutcome {
  const captured = recorder.captured()

  if (recorder.stopReason() === 'budget') return 'budget'
  if (recorder.stopReason() === 'cancelled') return 'cancelled'

  if (!captured) {
    // Nothing was recorded. Two very different situations look the same from here, and telling
    // them apart is the whole point:
    //
    //   - the run was already terminal, or gone, before this slice started — nothing to do
    //   - core finalized the run itself, without going through the decorated `markStatus`
    //
    // The second means the seam this package rests on has moved (ADR 0004), and reporting it
    // as success would leave a job that says `completed` beside a run that says `failed`.
    // Committed batches are what distinguishes them: a slice that did real work and then found
    // the run terminal without recording anything did not simply arrive late.
    if (recorder.committedBatches() > 0 && runStatus && runStatus !== 'running' && runStatus !== 'pending') {
      throw new SeamBrokenError(runId, `the run reached "${runStatus}" without the adopter recording it`)
    }
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

/**
 * The services core's `finalizeRun` reaches for once the status is written.
 *
 * Named separately from the slice's dependencies because these are needed at a different
 * moment: the slice runs under a lease, this runs after the job's terminal transition has
 * committed, on whatever worker got there.
 */
export type FinalizeDeps = {
  progressService: ProgressServiceLike
  integrationLogService: { write(entry: Record<string, unknown>, scope: SyncScope): Promise<unknown> }
  integrationStateService?: {
    upsert(integrationId: string, patch: Record<string, unknown>, scope: SyncScope): Promise<unknown>
  } | null
  /** `adapter.operationalTelemetry === true`, which is core's own gate on the two writes below. */
  operationalTelemetry(integrationId: string): boolean
  emitEvent(name: string, payload: Record<string, unknown>): Promise<void>
}

/** The run fields core's tail reads. */
export type FinalizedRun = {
  id: string
  integrationId: string
  entityType: string
  direction: string
  progressJobId?: string | null
  createdCount?: number
  updatedCount?: number
  skippedCount?: number
  failedCount?: number
  batchesCompleted?: number
}

/**
 * Everything core's `finalizeRun` does after the status write, done here instead.
 *
 * Core stops at its "another worker already finalized this" branch on every durable run — that
 * is deliberate, and it is what lets the durable transition own the terminal state (see
 * `markStatus` above). But stopping there also skips the three things that came after it: the
 * progress job is never resolved, the operational log never written, and the lifecycle event
 * never emitted. Left unreplayed, a host loses the progress indicator an operator watches, the
 * integration health state, and `data_sync.run.completed` — which is dispatched to tenant
 * webhooks, so its absence is visible outside the app entirely.
 *
 * This runs after the commit, not inside it: events and enqueues must not sit in a transaction
 * that can still roll back, and the mechanism gives after-commit hooks at-most-once semantics
 * for exactly this. A throw here is logged and dropped rather than retried — the same standing
 * core's own tail has, where a failed webhook has never un-completed a run.
 */
export async function replayFinalize(
  deps: FinalizeDeps,
  run: FinalizedRun,
  status: SyncTerminalStatus,
  errorMessage: string | null,
  scope: SyncScope,
  userId: string | null,
): Promise<void> {
  const progressScope = { tenantId: scope.tenantId, organizationId: scope.organizationId, userId: userId ?? undefined }
  const enabled = deps.operationalTelemetry(run.integrationId)

  if (run.progressJobId) {
    const progress = deps.progressService as unknown as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>
    if (status === 'completed') {
      await progress.completeJob?.(
        run.progressJobId,
        {
          resultSummary: {
            createdCount: run.createdCount,
            updatedCount: run.updatedCount,
            skippedCount: run.skippedCount,
            failedCount: run.failedCount,
            batchesCompleted: run.batchesCompleted,
          },
        },
        progressScope,
      )
    } else if (status === 'failed') {
      await progress.failJob?.(run.progressJobId, { errorMessage: errorMessage ?? 'Sync run failed' }, progressScope)
    } else {
      await progress.markCancelled?.(run.progressJobId, progressScope)
    }
  }

  const health = status === 'completed' ? 'healthy' : status === 'cancelled' ? 'degraded' : 'unhealthy'
  if (enabled && deps.integrationStateService) {
    await deps.integrationStateService.upsert(
      run.integrationId,
      { lastHealthStatus: health, lastHealthCheckedAt: new Date() },
      scope,
    )
  }

  if (enabled) {
    const log =
      status === 'completed'
        ? {
            level: 'info',
            message: 'Sync run completed',
            payload: {
              operationalStatus: 'completed',
              summary: `Sync completed with ${run.createdCount ?? 0} created, ${run.updatedCount ?? 0} updated, ${run.failedCount ?? 0} failed.`,
              createdCount: run.createdCount,
              updatedCount: run.updatedCount,
              skippedCount: run.skippedCount,
              failedCount: run.failedCount,
              batchesCompleted: run.batchesCompleted,
            },
          }
        : status === 'cancelled'
          ? {
              level: 'warn',
              message: 'Sync run cancelled',
              payload: { operationalStatus: 'cancelled', summary: 'The sync run was cancelled before completion.' },
            }
          : {
              level: 'error',
              message: errorMessage ?? 'Sync run failed',
              payload: { operationalStatus: 'failed', summary: errorMessage ?? 'The sync run failed.' },
            }

    await deps.integrationLogService.write({ integrationId: run.integrationId, runId: run.id, ...log }, scope)
  }

  await deps.emitEvent(`data_sync.run.${status}`, {
    runId: run.id,
    integrationId: run.integrationId,
    entityType: run.entityType,
    direction: run.direction,
    // Only the failure event carries this, and a subscriber that switches on it would see
    // every durable failure as an unexplained one if it were dropped.
    ...(status === 'failed' ? { error: errorMessage ?? null } : {}),
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
  })
}
