// Core's run route, with the durable job created alongside the run.
//
// Wrapped rather than copied. Core's route is 180 lines of validation, ACL guards, cursor
// resolution and parameter normalisation, and duplicating that is precisely the liability
// ADR 0004 removed for the engine — the same argument applies here.
//
// Why the wrapper is needed at all: replacing `lib/start-run.ts` redirects only callers that
// import *our* deep path. Core's own route imports its own sibling, so a run started through
// it never reaches our start path. This is where that is fixed.
//
// The durable job is created after core's transaction rather than inside it, which is weaker
// than the transactional start our own path gives. It is not a hole: core also enqueues onto
// its queue, our adopt-on-delivery worker is registered under core's worker id, and both paths
// carry the same idempotency key — so a crash between the two ends with the delivery adopting
// the run instead. What the wrapper buys is that the job normally exists immediately, rather
// than whenever the queue gets to it.

import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import { POST as corePost, openApi as coreOpenApi } from '@open-mercato/core/modules/data_sync/api/run'
import type { DurableWorkService } from '@fullstackhouse/open-mercato-durable-work'

import { EXPORT_KIND, IMPORT_KIND, syncIdempotencyKey, syncLockKey } from '../../../kinds/data-sync-run'

const logger = createLogger('data_sync').child({ component: 'durable-run-route' })

// Copied from core, because the generator reads it by AST and cannot follow a re-export.
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['data_sync.run'] },
}

export const openApi = coreOpenApi

type StartedRun = { id: string; progressJobId: string | null }
type RunRow = { id: string; integrationId: string; entityType: string; direction: string; progressJobId?: string | null }

/**
 * Says what happened to the durable job, without changing core's response body.
 *
 *   created  — the job exists now
 *   deferred — it does not, and the queue delivery will adopt the run instead
 *
 * A header rather than a log line because the difference matters to whoever called: `created`
 * means the run is already under a lease, `deferred` means it is not yet. Buried in a log,
 * that distinction is unavailable to exactly the people who need it, including a test.
 */
const DURABLE_HEADER = 'x-durable-work'

export async function POST(req: Request) {
  const response = await corePost(req)
  if (response.status !== 201) return response

  // Cloned: the caller still gets core's response untouched, whatever happens below.
  const started = (await response.clone().json()) as StartedRun

  try {
    const auth = await getAuthFromRequest(req)
    if (!auth?.tenantId) {
      response.headers.set(DURABLE_HEADER, 'deferred')
      return response
    }

    const container = await createRequestContainer()
    const durable = container.resolve('durableWorkService') as DurableWorkService
    const runService = container.resolve('dataSyncRunService') as {
      getRun(id: string, scope: unknown): Promise<RunRow | null>
    }
    const scope = { tenantId: auth.tenantId, organizationId: auth.orgId ?? null }

    const run = await runService.getRun(started.id, { ...scope, organizationId: auth.orgId })
    if (!run) {
      response.headers.set(DURABLE_HEADER, 'deferred')
      return response
    }

    await durable.startAndEnqueue(
      {
        kind: run.direction === 'export' ? EXPORT_KIND : IMPORT_KIND,
        input: { runId: run.id, batchSize: 100, direction: run.direction === 'export' ? 'export' : 'import' },
        lockKey: syncLockKey(run.integrationId, run.entityType, run.direction),
        idempotencyKey: syncIdempotencyKey(run.id),
        subject: { type: 'data_sync.run', id: run.id },
        progressJobId: run.progressJobId ?? started.progressJobId ?? null,
        createdBy: auth.sub ?? null,
      },
      scope,
    )
    response.headers.set(DURABLE_HEADER, 'created')
  } catch (error) {
    // Never fails the request. The run exists and core has already enqueued it, so the
    // adopt-on-delivery worker will make it durable; turning that into a 500 would refuse a
    // run that is going to happen anyway.
    logger.warn('Could not create the durable job for a started run; the queue delivery will adopt it', {
      runId: started.id,
      err: error,
    })
    response.headers.set(DURABLE_HEADER, 'deferred')
    response.headers.set(`${DURABLE_HEADER}-reason`, error instanceof Error ? error.message.slice(0, 200) : 'unknown')
  }

  return response
}
