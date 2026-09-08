// The job kinds a `data_sync` run becomes.
//
// A slice is one call into core's own engine, with the run service and the progress service
// decorated for its duration. The engine does all the work it always did; what changes is where
// its cursor commits go (through the lease fence), when it stops (at a batch boundary when the
// slice budget is spent), and who writes the terminal state (the durable transition, in the
// same transaction as the job's own).

import type { KindDefinition, SliceContext, SliceOutcome, SqlExecutor } from '@fullstackhouse/open-mercato-durable-work'

import {
  mirrorRunStatus,
  outcomeOf,
  recordSlice,
  reopenRun,
  type ProgressServiceLike,
  type SyncRunServiceLike,
  type SyncScope,
} from '../engine/durable-run'

export const IMPORT_KIND = 'data_sync.import'
export const EXPORT_KIND = 'data_sync.export'
export const DATA_SYNC_QUEUE = 'durable-work.data-sync'

export type SyncRunInput = {
  runId: string
  batchSize: number
  direction: 'import' | 'export'
}

/** What a slice needs from the host, resolved per slice from the container. */
export type SyncEngineLike = {
  runImport(runId: string, batchSize: number, scope: SyncScope): Promise<void>
  runExport(runId: string, batchSize: number, scope: SyncScope): Promise<void>
}

export type DataSyncKindDeps = {
  /** Resolved per slice, because each slice runs on its own EntityManager. */
  resolve(): Promise<{
    engine: (services: { runService: SyncRunServiceLike; progressService: ProgressServiceLike }) => SyncEngineLike
    runService: SyncRunServiceLike
    progressService: ProgressServiceLike
  }>
}

async function runSlice(ctx: SliceContext<SyncRunInput>, deps: DataSyncKindDeps): Promise<SliceOutcome> {
  const input = ctx.job.input as SyncRunInput
  const scope: SyncScope = { tenantId: ctx.scope.tenantId, organizationId: ctx.scope.organizationId }
  const { engine, runService, progressService } = await deps.resolve()

  const recorder = recordSlice(ctx, runService, progressService)
  const decorated = engine({ runService: recorder.runService, progressService: recorder.progressService })

  if (input.direction === 'export') await decorated.runExport(input.runId, input.batchSize, scope)
  else await decorated.runImport(input.runId, input.batchSize, scope)

  return outcomeOf(recorder, input.runId)
}

/**
 * Builds both kinds.
 *
 * `orphanPolicy: 'redrive'` is deliberate and is the one place the adopter asserts something
 * about the work rather than the mechanism: a sync run keeps a committed cursor, so re-running
 * it after a worker died resumes rather than repeats. That is what makes automatic recovery
 * safe here when the mechanism's default is to park and wait for a human.
 */
export function dataSyncKinds(deps: DataSyncKindDeps): KindDefinition<SyncRunInput, never>[] {
  const shared = {
    queue: DATA_SYNC_QUEUE,
    requiredFeatures: ['data_sync.run'],
    orphanPolicy: 'redrive' as const,
    // Long enough that a slow adapter page does not look like a dead worker, short enough that
    // a dead worker is noticed in about a minute.
    lease: { ttlMs: 60_000, sliceBudgetMs: 300_000, pendingTtlMs: 900_000 },

    async onTransition(job: { id: string; input: unknown; status: string; errorMessage: string | null }, _scope: unknown, tx: SqlExecutor) {
      const { runId } = job.input as SyncRunInput
      const status = job.status === 'completed' ? 'completed' : job.status === 'cancelled' ? 'cancelled' : 'failed'
      return mirrorRunStatus(tx, runId, status, job.errorMessage)
    },

    async onRedrive(job: { input: unknown }, _scope: unknown, tx: SqlExecutor) {
      return reopenRun(tx, (job.input as SyncRunInput).runId)
    },
  }

  return [
    { ...shared, kind: IMPORT_KIND, step: (ctx) => runSlice(ctx, deps) } as KindDefinition<SyncRunInput, never>,
    { ...shared, kind: EXPORT_KIND, step: (ctx) => runSlice(ctx, deps) } as KindDefinition<SyncRunInput, never>,
  ]
}

/** The single-runner key: one live run per integration, entity and direction. Two imports of
 *  the same entity would interleave over one cursor. */
export function syncLockKey(integrationId: string, entityType: string, direction: string): string {
  return `data_sync:${integrationId}:${entityType}:${direction}`
}

/** Makes starting a run twice for the same run id return the first job rather than a second. */
export function syncIdempotencyKey(runId: string): string {
  return `data_sync.run:${runId}`
}
