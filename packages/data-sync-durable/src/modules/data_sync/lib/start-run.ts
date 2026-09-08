// The durable start path.
//
// Same signature and same return shape as core's `startDataSyncRun`, so every caller — the run
// route, `sync_excel`, `sync_akeneo`'s first import — keeps working untouched. What changes is
// what gets created: a durable job instead of a queue message, in the same transaction as the
// run row where the transport allows it.

import type { DurableWorkService } from '@fullstackhouse/open-mercato-durable-work'

import { IMPORT_KIND, EXPORT_KIND, syncIdempotencyKey, syncLockKey } from '../../../kinds/data-sync-run'

export type {
  DataSyncStartScope,
  StartDataSyncRunInput,
} from '@open-mercato/core/modules/data_sync/lib/start-run'

type StartScope = { organizationId: string; tenantId: string; userId?: string | null }

type StartInput = {
  integrationId: string
  entityType: string
  direction: 'import' | 'export'
  cursor?: string | null
  triggeredBy?: string | null
  batchSize?: number
  parameters?: Record<string, unknown> | null
  createProgressJob?: boolean
  progressJob?: {
    jobType?: string
    name?: string
    description?: string
    cancellable?: boolean
    meta?: Record<string, unknown>
  }
}

type ProgressServiceLike = {
  createJob(input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ id: string }>
}

type SyncRunServiceLike = {
  createRun(input: Record<string, unknown>, scope: Record<string, unknown>): Promise<{ id: string }>
}

export async function startDataSyncRun(params: {
  syncRunService: SyncRunServiceLike
  progressService: ProgressServiceLike
  durableWorkService: DurableWorkService
  scope: StartScope
  input: StartInput
}) {
  const { syncRunService, progressService, durableWorkService, scope, input } = params

  // Always created, never optional as it is in core.
  //
  // Core consults the progress row's cancellation flag once per batch, and that check is what
  // gives a slice its hand-back point. A run without a progress job has no batch boundary to
  // stop at, so it could only be interrupted between whole runs — which for a multi-day
  // backfill is the same as not being interruptible. See docs/adr/0004.
  const progressJob = await progressService.createJob(
    {
      jobType: input.progressJob?.jobType ?? `data_sync:${input.direction}`,
      name: input.progressJob?.name ?? `Data sync ${input.integrationId} — ${input.entityType}`,
      description: input.progressJob?.description ?? `${input.entityType} ${input.direction}`,
      cancellable: true,
      meta: {
        integrationId: input.integrationId,
        entityType: input.entityType,
        direction: input.direction,
        ...(input.progressJob?.meta ?? {}),
      },
    },
    { tenantId: scope.tenantId, organizationId: scope.organizationId, userId: scope.userId },
  )

  const run = await syncRunService.createRun(
    {
      integrationId: input.integrationId,
      entityType: input.entityType,
      direction: input.direction,
      cursor: input.cursor ?? null,
      triggeredBy: input.triggeredBy ?? scope.userId ?? null,
      parameters: input.parameters ?? null,
      progressJobId: progressJob.id,
    },
    { organizationId: scope.organizationId, tenantId: scope.tenantId },
  )

  await durableWorkService.startAndEnqueue(
    {
      kind: input.direction === 'import' ? IMPORT_KIND : EXPORT_KIND,
      input: { runId: run.id, batchSize: input.batchSize ?? 100, direction: input.direction },
      // One live run per integration, entity and direction. Two imports of the same entity
      // would interleave over a single cursor and silently lose rows.
      lockKey: syncLockKey(input.integrationId, input.entityType, input.direction),
      // Makes a retried start return the job that already exists instead of a second one.
      idempotencyKey: syncIdempotencyKey(run.id),
      subject: { type: 'data_sync.run', id: run.id },
      progressJobId: progressJob.id,
      createdBy: scope.userId ?? null,
    },
    { tenantId: scope.tenantId, organizationId: scope.organizationId },
  )

  return { run, progressJob }
}
