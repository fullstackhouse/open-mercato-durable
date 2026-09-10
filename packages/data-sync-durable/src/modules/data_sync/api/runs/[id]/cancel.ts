// Core's cancel route, with the durable job told about it.
//
// Wrapped for the same reason as `api/run.ts`: core's route is the one an operator actually
// reaches, and it knows nothing about durable work. It writes `cancelled` onto the run and
// cancels the progress job — which does stop a slice that is running, because the slice checks
// the progress job's cancellation flag at every batch boundary.
//
// What it does not do is tell the *job*. Left there, `cancel_requested_at` is never set, so the
// reconciler's cancelling sweep has nothing to find and a kind's `onCancel` — where external
// resources are released — never runs. A job sitting between slices is worse: nothing stops the
// next delivery from starting another one.
//
// After core's call, not before: if the durable cancel ran first, the job could reach its
// terminal state and mirror `cancelled` onto a run that core is still about to write, and the
// operator's own request would be the one racing.
//
// Never fails the request. The operator asked to cancel a run and the run is cancelled; a
// failure to also stop the job is reported in a header and repaired by the reconciler, which is
// what it is for.

import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  POST as corePost,
  openApi as coreOpenApi,
} from '@open-mercato/core/modules/data_sync/api/runs/[id]/cancel'
import type { DurableWorkService, SqlExecutor } from '@fullstackhouse/open-mercato-durable-work'

import { cancelDurableJobForRun } from '../../../../../kinds/data-sync-run'

const logger = createLogger('data_sync').child({ component: 'durable-cancel' })

const DURABLE_HEADER = 'x-durable-work'

// Copied from core: the generator reads this by AST and cannot follow a re-export.
export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['data_sync.run'] },
}

export const openApi = coreOpenApi

export async function POST(req: Request, ctx: { params?: Promise<{ id?: string }> | { id?: string } }) {
  const response = await corePost(req, ctx)
  if (response.status !== 200) return response

  try {
    const rawParams =
      ctx.params && typeof (ctx.params as Promise<unknown>).then === 'function'
        ? await (ctx.params as Promise<{ id?: string }>)
        : (ctx.params as { id?: string } | undefined)
    const runId = rawParams?.id
    const auth = await getAuthFromRequest(req)
    if (!runId || !auth?.tenantId) {
      response.headers.set(DURABLE_HEADER, 'deferred')
      return response
    }

    const container = await createRequestContainer()
    const outcome = await cancelDurableJobForRun(
      {
        sql: container.resolve('durableWorkSql') as SqlExecutor,
        durable: container.resolve('durableWorkService') as DurableWorkService,
      },
      runId,
      { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
      auth.sub ?? null,
    )
    response.headers.set(DURABLE_HEADER, outcome)
  } catch (error) {
    logger.warn('Could not cancel the durable job for a cancelled run; the reconciler will settle it', {
      err: error as Error,
    })
    response.headers.set(DURABLE_HEADER, 'deferred')
    response.headers.set(`${DURABLE_HEADER}-reason`, error instanceof Error ? error.message.slice(0, 200) : 'unknown')
  }

  return response
}
