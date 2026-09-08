// Shared plumbing for the operator routes.

import { NextResponse } from 'next/server'
import { getAuthFromRequest } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'

import type { DurableWorkService } from '../../../core/service'
import type { DurableJob, Scope } from '../../../core/types'

export type RouteContext = { service: DurableWorkService; scope: Scope; userId: string | null }

/**
 * Resolves the caller's scope and the service, or the response to return instead.
 *
 * The scope comes from the session, never from the request body or the path. An operator API
 * that let a caller name a tenant would be a way to re-drive somebody else's work.
 */
export async function routeContext(req: Request): Promise<RouteContext | NextResponse> {
  const auth = await getAuthFromRequest(req)
  if (!auth || !auth.tenantId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const container = await createRequestContainer()
  return {
    service: container.resolve('durableWorkService') as DurableWorkService,
    scope: { tenantId: auth.tenantId, organizationId: auth.orgId ?? null },
    userId: auth.sub ?? null,
  }
}

/** The wire shape. Timestamps as ISO strings, plus two things only the server can decide. */
export function toDto(job: DurableJob) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    input: job.input,
    checkpoint: job.checkpoint,
    subject: job.subjectType ? { type: job.subjectType, id: job.subjectId } : null,
    lockKey: job.lockKey,
    idempotencyKey: job.idempotencyKey,
    processedCount: job.processedCount,
    totalCount: job.totalCount,
    redrives: job.redrives,
    interruptions: job.interruptions,
    consecutiveFailures: job.consecutiveFailures,
    mirrorAttempts: job.mirrorAttempts,
    leaseOwner: job.leaseOwner,
    leaseEpoch: job.leaseEpoch,
    leaseExpiresAt: iso(job.leaseExpiresAt),
    heartbeatAt: iso(job.heartbeatAt),
    nextRunAt: iso(job.nextRunAt),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    parkedAt: iso(job.parkedAt),
    cancelRequestedAt: iso(job.cancelRequestedAt),
    errorClass: job.errorClass,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    createdAt: iso(job.createdAt),
    updatedAt: iso(job.updatedAt),
    // Derived on the server because the client cannot see the kind's grace, its pending TTL
    // or its mirror budget — and a UI that guessed would offer buttons that then 409.
    redrivable: isRedrivable(job),
    stuck: isStuck(job),
  }
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null)

/** `completed` and `cancelled` are done on purpose: the first succeeded, the second was asked
 *  for. Everything else that has stopped can be re-driven. */
function isRedrivable(job: DurableJob): boolean {
  if (job.status === 'completed' || job.status === 'cancelled') return false
  if (job.status === 'failed') return true
  return job.status === 'running' && job.leaseExpiresAt != null && job.leaseExpiresAt.getTime() < Date.now()
}

/** "Nobody is driving this and nothing is scheduled" — the state an operator needs to see. */
function isStuck(job: DurableJob): boolean {
  if (job.status !== 'running') return false
  const expired = job.leaseExpiresAt != null && job.leaseExpiresAt.getTime() < Date.now() - 20_000
  const nothingScheduled = job.nextRunAt == null || job.nextRunAt.getTime() < Date.now() - 900_000
  return expired && nothingScheduled
}
