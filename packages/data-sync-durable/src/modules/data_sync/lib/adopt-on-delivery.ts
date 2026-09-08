// What happens when a run arrives on core's queue rather than through the durable start path.
//
// `sync_excel`, `sync_akeneo`'s first import, the scheduler, and anything else that imports
// core's `startDataSyncRun` directly still enqueue a plain queue message. Core's own worker is
// no longer registered — ours has its id — so without this those runs would simply never start.
//
// Rather than running them non-durably, the delivery is *adopted*: a durable job is created for
// the run it names and the queue message ends there. The run then gets the same lease, the same
// resumable slices and the same repair loop as one started durably. A caller that never heard
// of this package gets the guarantees anyway.

import type { JobContext, QueuedJob } from '@open-mercato/queue'
import type { DurableWorkService } from '@fullstackhouse/open-mercato-durable-work'
import { createLogger } from '@open-mercato/shared/lib/logger'

import { EXPORT_KIND, IMPORT_KIND, syncIdempotencyKey, syncLockKey } from '../../../kinds/data-sync-run'

const logger = createLogger('data_sync').child({ component: 'adopt-on-delivery' })

type SyncJobPayload = {
  runId: string
  batchSize: number
  scope: { organizationId: string; tenantId: string; userId?: string | null }
}

type HandlerContext = JobContext & { resolve: <T = unknown>(name: string) => T }

type RunRow = {
  id: string
  integrationId: string
  entityType: string
  direction: string
  status: string
}

export function adoptOnDelivery(direction: 'import' | 'export') {
  return async function handle(job: QueuedJob<SyncJobPayload>, ctx: HandlerContext): Promise<void> {
    const { runId, batchSize, scope } = job.payload
    const durable = ctx.resolve<DurableWorkService>('durableWorkService')
    const runService = ctx.resolve<{ getRun(id: string, scope: unknown): Promise<RunRow | null> }>('dataSyncRunService')

    const run = await runService.getRun(runId, scope)
    if (!run) {
      logger.warn('Ignoring a delivery for a run that no longer exists', { runId })
      return
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      logger.warn('Ignoring a delivery for a run that already finished', { runId, status: run.status })
      return
    }

    // Idempotent by the run id, so a redelivery of the same queue message adopts once. The
    // lock key is the same one the durable start path uses, so a run that is already being
    // driven refuses this rather than being driven twice.
    await durable.startAndEnqueue(
      {
        kind: direction === 'import' ? IMPORT_KIND : EXPORT_KIND,
        input: { runId, batchSize: batchSize ?? 100, direction },
        lockKey: syncLockKey(run.integrationId, run.entityType, run.direction),
        idempotencyKey: syncIdempotencyKey(runId),
        subject: { type: 'data_sync.run', id: runId },
        createdBy: scope.userId ?? null,
      },
      { tenantId: scope.tenantId, organizationId: scope.organizationId },
    )

    logger.info('Adopted a core-path sync run as durable work', { runId, direction })
  }
}
