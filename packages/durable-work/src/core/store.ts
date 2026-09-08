// Every statement that may write a job row lives here, and nowhere else.
//
// They are hand-written SQL rather than ORM calls because each one is a compare-and-set whose
// WHERE clause *is* the guarantee — "only the owner of epoch N may write this row", "only one
// live job per lock key". An ORM would put a translation layer between that predicate and the
// person reviewing it, and these predicates are exactly what has to be reviewable.
//
// Two rules hold throughout:
//   1. Time is the database's. A duration crosses the boundary; a worker-computed timestamp
//      never does. A worker five minutes ahead of Postgres would otherwise push every
//      reconciler predicate five minutes out.
//   2. A verdict is decided inside the statement that has the row locked, from the row's
//      current counters — never from a value the caller read earlier.

import {
  IDEMPOTENCY_INDEX,
  LOCK_KEY_INDEX,
  NO_ORG,
  TABLE,
} from './schema'
import { LockKeyHeldError } from './errors'
import type {
  DurableJob,
  DurableJobStatus,
  ErrorClass,
  Lease,
  ParkReason,
  Scope,
  SqlExecutor,
  SliceVerdict,
  StartJobInput,
} from './types'

/** Selected by every statement that returns a row, so the mapper always sees every column. */
const COLUMNS = `
  id, tenant_id, organization_id, kind, status, created_by, created_at, updated_at,
  input, checkpoint, meta,
  idempotency_key, lock_key, subject_type, subject_id, progress_job_id,
  lease_owner, lease_epoch, lease_expires_at, heartbeat_at,
  queue_name, queue_job_id, continuation_seq, redrives, next_run_at, pending_since,
  redrives_since_commit, consecutive_failures, interruptions, mirror_attempts, last_committed_at,
  started_at, finished_at, parked_at, cancel_requested_at, cancelled_by,
  error_class, error_code, error_message, domain_mirrored_at,
  processed_count, total_count`

type Row = Record<string, unknown>

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
const date = (value: unknown): Date | null => (value == null ? null : value instanceof Date ? value : new Date(String(value)))

export function mapRow(row: Row): DurableJob {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    organizationId: row.organization_id == null ? null : String(row.organization_id),
    kind: String(row.kind),
    status: String(row.status) as DurableJobStatus,
    createdBy: row.created_by == null ? null : String(row.created_by),
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,

    input: row.input ?? null,
    checkpoint: row.checkpoint ?? null,
    meta: (row.meta ?? null) as Record<string, unknown> | null,

    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    lockKey: row.lock_key == null ? null : String(row.lock_key),
    subjectType: row.subject_type == null ? null : String(row.subject_type),
    subjectId: row.subject_id == null ? null : String(row.subject_id),
    progressJobId: row.progress_job_id == null ? null : String(row.progress_job_id),

    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseEpoch: num(row.lease_epoch),
    leaseExpiresAt: date(row.lease_expires_at),
    heartbeatAt: date(row.heartbeat_at),

    queueName: row.queue_name == null ? null : String(row.queue_name),
    queueJobId: row.queue_job_id == null ? null : String(row.queue_job_id),
    continuationSeq: num(row.continuation_seq),
    redrives: num(row.redrives),
    nextRunAt: date(row.next_run_at),
    pendingSince: date(row.pending_since),

    redrivesSinceCommit: num(row.redrives_since_commit),
    consecutiveFailures: num(row.consecutive_failures),
    interruptions: num(row.interruptions),
    mirrorAttempts: num(row.mirror_attempts),
    lastCommittedAt: date(row.last_committed_at),

    startedAt: date(row.started_at),
    finishedAt: date(row.finished_at),
    parkedAt: date(row.parked_at),
    cancelRequestedAt: date(row.cancel_requested_at),
    cancelledBy: row.cancelled_by == null ? null : String(row.cancelled_by),
    errorClass: row.error_class == null ? null : (String(row.error_class) as ErrorClass),
    errorCode: row.error_code == null ? null : String(row.error_code),
    errorMessage: row.error_message == null ? null : String(row.error_message),
    domainMirroredAt: date(row.domain_mirrored_at),

    processedCount: num(row.processed_count),
    totalCount: row.total_count == null ? null : num(row.total_count),
  }
}

const one = (result: { rows: Row[] }): DurableJob | null => (result.rows.length ? mapRow(result.rows[0]!) : null)

/** Scope predicate. A null organization matches only a null organization — it is a real value
 *  ("tenant-wide"), not a wildcard, and treating it as one would leak jobs across orgs. */
const SCOPE = `tenant_id = $2 and (organization_id = $3 or ($3::uuid is null and organization_id is null))`

function isUniqueViolation(error: unknown, index: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown } | null
  if (!e || e.code !== '23505') return false
  if (typeof e.constraint === 'string') return e.constraint === index
  return typeof e.message === 'string' && e.message.includes(index)
}

// ---------------------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------------------

export type InsertResult = { job: DurableJob; created: boolean }

/**
 * Inserts a job, or returns the existing one when `idempotencyKey` has been used before.
 *
 * Runs on the caller's executor so it can be part of their transaction: creating the domain
 * row and the job row together is the entire point of the transactional-start guarantee, and
 * an enqueue that happens before that transaction commits is a delivery for a job that may
 * never exist.
 */
export async function insertJob(
  sql: SqlExecutor,
  id: string,
  scope: Scope,
  input: StartJobInput,
  queueName: string,
): Promise<InsertResult> {
  const params = [
    id,
    scope.tenantId,
    scope.organizationId,
    input.kind,
    input.input ?? null,
    input.meta ?? null,
    input.idempotencyKey ?? null,
    input.lockKey ?? null,
    input.subject?.type ?? null,
    input.subject?.id ?? null,
    input.progressJobId ?? null,
    input.createdBy ?? null,
    queueName,
    input.totalCount ?? null,
  ]

  try {
    const inserted = await sql.query<Row>(
      `insert into ${TABLE} (
         id, tenant_id, organization_id, kind, status,
         input, meta, idempotency_key, lock_key, subject_type, subject_id, progress_job_id,
         created_by, queue_name, total_count, pending_since, created_at, updated_at
       ) values (
         $1, $2, $3, $4, 'pending',
         $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11,
         $12, $13, $14, now(), now(), now()
       ) returning ${COLUMNS}`,
      params,
    )
    return { job: mapRow(inserted.rows[0]!), created: true }
  } catch (error) {
    // Re-issuing the same idempotency key is not an error: it is the caller asking for the
    // job they already started, which is what makes `start` safe to retry.
    if (input.idempotencyKey && isUniqueViolation(error, IDEMPOTENCY_INDEX)) {
      const existing = await findByIdempotencyKey(sql, scope, input.idempotencyKey)
      if (existing) return { job: existing, created: false }
    }
    if (input.lockKey && isUniqueViolation(error, LOCK_KEY_INDEX)) {
      const holder = await findLiveByLockKey(sql, scope, input.lockKey)
      throw new LockKeyHeldError(input.lockKey, holder?.id)
    }
    throw error
  }
}

export async function findByIdempotencyKey(sql: SqlExecutor, scope: Scope, key: string): Promise<DurableJob | null> {
  return one(await sql.query<Row>(`select ${COLUMNS} from ${TABLE} where tenant_id = $1 and idempotency_key = $2`, [scope.tenantId, key]))
}

export async function findLiveByLockKey(sql: SqlExecutor, scope: Scope, lockKey: string): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `select ${COLUMNS} from ${TABLE}
        where lock_key = $1 and tenant_id = $2
          and coalesce(organization_id, '${NO_ORG}'::uuid) = coalesce($3::uuid, '${NO_ORG}'::uuid)
          and status in ('pending','running')
        limit 1`,
      [lockKey, scope.tenantId, scope.organizationId],
    ),
  )
}

export async function getJob(sql: SqlExecutor, id: string, scope: Scope): Promise<DurableJob | null> {
  return one(await sql.query<Row>(`select ${COLUMNS} from ${TABLE} where id = $1 and ${SCOPE}`, [id, scope.tenantId, scope.organizationId]))
}

// ---------------------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------------------

/**
 * Accepts one delivery and takes the lease.
 *
 * Refuses unless `(continuation_seq, redrives)` still match what the delivery carries — that
 * pair is the fence against a straggling redelivery of a slice that has already moved on.
 *
 * Reads no scheduled time. `next_run_at` is written on the database's clock but every delivery
 * that carries one was scheduled by the *transport's* clock, so a `next_run_at <= now()` clause
 * would refuse a retry that arrives a few milliseconds early and lose it permanently. Stale
 * deliveries are refused by identity alone.
 *
 * Writes `next_run_at = null`: the scheduled delivery is now consumed. Without that, a worker
 * SIGKILLed mid-slice would leave a timestamp for a delivery no broker holds, and the
 * reconciler would wait out the whole pending TTL instead of the much shorter lease grace.
 */
export async function claim(
  sql: SqlExecutor,
  id: string,
  scope: Scope,
  delivery: { seq: number; redrives: number },
  owner: string,
  ttlMs: number,
): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set status = 'running',
              lease_owner = $4,
              lease_epoch = lease_epoch + 1,
              lease_expires_at = now() + ($5::bigint * interval '1 millisecond'),
              heartbeat_at = now(),
              pending_since = null,
              next_run_at = null,
              started_at = coalesce(started_at, now()),
              updated_at = now()
        where id = $1 and ${SCOPE}
          and status in ('pending','running')
          and continuation_seq = $6 and redrives = $7
          and (lease_expires_at is null or lease_expires_at < now())
      returning ${COLUMNS}`,
      [id, scope.tenantId, scope.organizationId, owner, ttlMs, delivery.seq, delivery.redrives],
    ),
  )
}

export type HeartbeatPatch = { processedCount?: number; totalCount?: number | null; committed?: boolean }

/**
 * Extends the lease and optionally records progress. Returns null when the lease is gone —
 * the slice must then abort, because someone else now owns the job.
 *
 * `committed: true` means the slice durably committed a unit of work. That resets both
 * budgets: a job that is making progress has not earned any of the suspicion those counters
 * represent, however many times it was interrupted getting there.
 *
 * Touches no indexed column, so it stays a HOT update. That matters at the cadence a
 * multi-day run heartbeats at.
 */
export async function heartbeat(
  sql: SqlExecutor,
  lease: Lease,
  patch: HeartbeatPatch = {},
): Promise<{ cancelRequested: boolean } | null> {
  const result = await sql.query<Row>(
    `update ${TABLE}
        set lease_expires_at = now() + ($4::bigint * interval '1 millisecond'),
            heartbeat_at = now(),
            processed_count = coalesce($5::int, processed_count),
            total_count = case when $6::boolean then $7::int else total_count end,
            consecutive_failures  = case when $8::boolean then 0 else consecutive_failures end,
            redrives_since_commit = case when $8::boolean then 0 else redrives_since_commit end,
            last_committed_at     = case when $8::boolean then now() else last_committed_at end
      where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
    returning cancel_requested_at`,
    [
      lease.jobId,
      lease.owner,
      lease.epoch,
      lease.ttlMs,
      patch.processedCount ?? null,
      // `totalCount: null` is a meaningful value ("unknown"), so presence and value are
      // carried separately rather than collapsing both onto SQL NULL.
      Object.prototype.hasOwnProperty.call(patch, 'totalCount'),
      patch.totalCount ?? null,
      patch.committed === true,
    ],
  )
  if (!result.rows.length) return null
  return { cancelRequested: result.rows[0]!.cancel_requested_at != null }
}

/**
 * Re-asserts the lease inside the caller's transaction.
 *
 * This is what makes `fencedWrite` a fence rather than a hope: the slice's domain writes and
 * this check commit or roll back together, so a worker whose lease expired mid-transaction
 * cannot land a write that outlives its right to make one.
 */
export async function assertLease(tx: SqlExecutor, lease: Lease): Promise<boolean> {
  const result = await tx.query<Row>(
    `select 1 from ${TABLE}
      where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
      for update`,
    [lease.jobId, lease.owner, lease.epoch],
  )
  return result.rows.length > 0
}

/** Records a checkpoint under the fence, and counts as a committed unit. */
export async function writeCheckpoint(
  tx: SqlExecutor,
  lease: Lease,
  checkpoint: unknown,
  patch: HeartbeatPatch = {},
): Promise<boolean> {
  const result = await tx.query<Row>(
    `update ${TABLE}
        set checkpoint = $4::jsonb,
            lease_expires_at = now() + ($5::bigint * interval '1 millisecond'),
            heartbeat_at = now(),
            processed_count = coalesce($6::int, processed_count),
            total_count = case when $7::boolean then $8::int else total_count end,
            consecutive_failures = 0,
            redrives_since_commit = 0,
            last_committed_at = now(),
            updated_at = now()
      where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
    returning id`,
    [
      lease.jobId,
      lease.owner,
      lease.epoch,
      checkpoint ?? null,
      lease.ttlMs,
      patch.processedCount ?? null,
      Object.prototype.hasOwnProperty.call(patch, 'totalCount'),
      patch.totalCount ?? null,
    ],
  )
  return result.rows.length > 0
}

/**
 * Hands the remaining work back: the slice spent its budget or was asked to stop.
 *
 * Bumps `continuation_seq`, which invalidates the current delivery id and mints the next one.
 * Spends no retry attempt and touches no failure counter — yielding is the mechanism working,
 * not failing, and counting it would eventually park a perfectly healthy long job.
 */
export async function yieldSlice(
  sql: SqlExecutor,
  lease: Lease,
  opts: { interrupted: boolean },
): Promise<{ seq: number; redrives: number } | null> {
  const result = await sql.query<Row>(
    `update ${TABLE}
        set status = 'pending',
            continuation_seq = continuation_seq + 1,
            interruptions = interruptions + case when $4::boolean then 1 else 0 end,
            lease_owner = null,
            lease_expires_at = now(),
            pending_since = now(),
            next_run_at = now(),
            updated_at = now()
      where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
    returning continuation_seq, redrives`,
    [lease.jobId, lease.owner, lease.epoch, opts.interrupted],
  )
  if (!result.rows.length) return null
  return { seq: num(result.rows[0]!.continuation_seq), redrives: num(result.rows[0]!.redrives) }
}

/**
 * The slice threw. Stays `running` and releases the lease so the transport's next attempt can
 * claim the same `(seq, redrives)`.
 *
 * The verdict is decided *here*, from the counter this statement increments — never from a
 * value read at claim time. A committed heartbeat earlier in this same slice reset
 * `consecutive_failures` to zero, and the CASE below sees that reset, so a slice that made
 * progress cannot be failed terminally on a stale count.
 */
export async function failSlice(
  sql: SqlExecutor,
  lease: Lease,
  error: { message: string; code: string | null; class: ErrorClass },
  opts: { nextAttemptDelayMs: number | null; maxConsecutiveFailures: number },
): Promise<{ consecutiveFailures: number; verdict: SliceVerdict | null } | null> {
  const result = await sql.query<Row>(
    `update ${TABLE}
        set lease_owner = null,
            lease_expires_at = now(),
            next_run_at = case when $4::bigint is null then null else now() + ($4::bigint * interval '1 millisecond') end,
            consecutive_failures = consecutive_failures + 1,
            error_class = $5,
            error_message = $6,
            error_code = case
              when $7::boolean then 'unrecoverable'
              when consecutive_failures + 1 >= $8::int then 'retry_exhausted'
              else $9 end,
            updated_at = now()
      where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
    returning consecutive_failures, error_code`,
    [
      lease.jobId,
      lease.owner,
      lease.epoch,
      opts.nextAttemptDelayMs,
      error.class,
      error.message,
      error.class === 'unrecoverable',
      opts.maxConsecutiveFailures,
      error.code,
    ],
  )
  if (!result.rows.length) return null
  const code = result.rows[0]!.error_code
  const verdict = code === 'unrecoverable' || code === 'retry_exhausted' ? (code as SliceVerdict) : null
  return { consecutiveFailures: num(result.rows[0]!.consecutive_failures), verdict }
}

/**
 * Releases the lease without counting anything.
 *
 * Used when a terminal transaction rolled back while this delivery still held the lease. A
 * mirror failure is not a slice failure: counting it would burn the retry budget for something
 * the work itself did not do, and would clear a cancellation the operator is still waiting on.
 */
export async function releaseLease(
  sql: SqlExecutor,
  lease: Lease,
  opts: { nextAttemptDelayMs: number | null },
): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set lease_owner = null,
              lease_expires_at = now(),
              next_run_at = case when $4::bigint is null then null else now() + ($4::bigint * interval '1 millisecond') end,
              updated_at = now()
        where id = $1 and status = 'running' and lease_owner = $2 and lease_epoch = $3
      returning ${COLUMNS}`,
      [lease.jobId, lease.owner, lease.epoch, opts.nextAttemptDelayMs],
    ),
  )
}

// ---------------------------------------------------------------------------------------
// Terminal transitions — run inside the terminal transaction (see terminal.ts)
// ---------------------------------------------------------------------------------------

/**
 * Fenced on the epoch alone, not on the owner.
 *
 * The fence has to match both of its callers' lease states: on the ordinary failure path
 * `failSlice` has already nulled `lease_owner`, while on the retry-of-a-verdict path the
 * claim re-acquired it. The epoch is what both have in common and is what actually identifies
 * the generation of the lease.
 */
export async function completeCas(tx: SqlExecutor, lease: Lease, patch: { processedCount?: number; totalCount?: number | null } = {}): Promise<DurableJob | null> {
  return one(
    await tx.query<Row>(
      `update ${TABLE}
          set status = 'completed', finished_at = now(), lease_owner = null, lease_expires_at = now(),
              next_run_at = null, error_class = null, error_code = null, error_message = null,
              processed_count = coalesce($3::int, processed_count),
              total_count = coalesce($4::int, total_count),
              updated_at = now()
        where id = $1 and status = 'running' and lease_epoch = $2
      returning ${COLUMNS}`,
      [lease.jobId, lease.epoch, patch.processedCount ?? null, patch.totalCount ?? null],
    ),
  )
}

export async function failTerminalCas(
  tx: SqlExecutor,
  lease: Lease,
  verdict: { code: string; class: ErrorClass; message: string | null },
): Promise<DurableJob | null> {
  return one(
    await tx.query<Row>(
      `update ${TABLE}
          set status = 'failed', finished_at = now(), lease_owner = null, lease_expires_at = now(),
              next_run_at = null, error_code = $3, error_class = $4,
              error_message = coalesce($5, error_message), updated_at = now()
        where id = $1 and status = 'running' and lease_epoch = $2
      returning ${COLUMNS}`,
      [lease.jobId, lease.epoch, verdict.code, verdict.class, verdict.message],
    ),
  )
}

export async function cancelCas(tx: SqlExecutor, lease: Lease): Promise<DurableJob | null> {
  return one(
    await tx.query<Row>(
      `update ${TABLE}
          set status = 'cancelled', finished_at = now(), lease_owner = null, lease_expires_at = now(),
              next_run_at = null, updated_at = now()
        where id = $1 and status = 'running' and lease_epoch = $2
      returning ${COLUMNS}`,
      [lease.jobId, lease.epoch],
    ),
  )
}

/** Marks the domain mirror as landed. Called inside the same transaction as the CAS above. */
export async function markMirrored(tx: SqlExecutor, id: string): Promise<void> {
  await tx.query(`update ${TABLE} set domain_mirrored_at = now() where id = $1`, [id])
}

/**
 * Counts a failed mirror attempt.
 *
 * Deliberately its own autocommit statement, never part of the transaction it is counting —
 * that transaction rolled back, and a counter written inside it would roll back with it,
 * leaving a job that retries its mirror forever with nothing to show for it.
 */
export async function bumpMirrorAttempts(sql: SqlExecutor, id: string): Promise<number> {
  const result = await sql.query<Row>(
    `update ${TABLE} set mirror_attempts = mirror_attempts + 1, updated_at = now() where id = $1 returning mirror_attempts`,
    [id],
  )
  return result.rows.length ? num(result.rows[0]!.mirror_attempts) : 0
}

// ---------------------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------------------

/** Records the intent. A running slice observes it at its next heartbeat; a pending job is
 *  ended by the reconciler. Cancellation is never a write to `status` from outside. */
export async function requestCancel(sql: SqlExecutor, id: string, scope: Scope, by: string | null): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set cancel_requested_at = coalesce(cancel_requested_at, now()), cancelled_by = coalesce(cancelled_by, $4), updated_at = now()
        where id = $1 and ${SCOPE} and status in ('pending','running')
      returning ${COLUMNS}`,
      [id, scope.tenantId, scope.organizationId, by],
    ),
  )
}

/** Ends a job that was cancelled while it was not running. Used by the reconciler's cancel
 *  query, where there is no lease to fence on — the `pending` status is the fence. */
export async function cancelPending(tx: SqlExecutor, id: string): Promise<DurableJob | null> {
  return one(
    await tx.query<Row>(
      `update ${TABLE}
          set status = 'cancelled', finished_at = now(), lease_owner = null, lease_expires_at = now(),
              next_run_at = null, pending_since = null, updated_at = now()
        where id = $1 and status = 'pending' and cancel_requested_at is not null
      returning ${COLUMNS}`,
      [id],
    ),
  )
}

// ---------------------------------------------------------------------------------------
// The re-drive family. Three statements, one core; they differ only in predicate and budget.
// ---------------------------------------------------------------------------------------

const REDRIVE_CORE = `status = 'pending', lease_owner = null, lease_epoch = lease_epoch + 1,
  lease_expires_at = now(), redrives = redrives + 1, pending_since = now(), updated_at = now()`

/**
 * The reconciler takes an orphan: a running job whose driver stopped heartbeating.
 *
 * Two tolerances, deliberately different. `lease_expires_at` is a database-clock fact about a
 * driver, so a short grace suffices. `next_run_at` is when the *transport* makes a delivery
 * available, not when a worker picks it up — behind a busy queue that can be minutes — so a
 * scheduled delivery gets the same generous tolerance a pending job gets. Using the short
 * grace for both would take healthy jobs whose retry is merely queued, spend their orphan
 * budget, and park them as poison after a few busy periods.
 */
export async function takeOrphan(
  sql: SqlExecutor,
  id: string,
  opts: { graceMs: number; pendingTtlMs: number; backoffMs: number },
): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set ${REDRIVE_CORE}, redrives_since_commit = redrives_since_commit + 1,
              next_run_at = now() + ($4::bigint * interval '1 millisecond')
        where id = $1 and status = 'running'
          and lease_expires_at < now() - ($2::bigint * interval '1 millisecond')
          and (next_run_at is null or next_run_at < now() - ($3::bigint * interval '1 millisecond'))
          and cancel_requested_at is null
          and (error_code is null or error_code not in ('unrecoverable','retry_exhausted'))
      returning ${COLUMNS}`,
      [id, opts.graceMs, opts.pendingTtlMs, opts.backoffMs],
    ),
  )
}

/** Re-drives a pending job whose delivery was never picked up — a lost hand-back or an
 *  enqueue that never reached the broker. */
export async function redrivePending(sql: SqlExecutor, id: string, opts: { pendingTtlMs: number }): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set ${REDRIVE_CORE}, redrives_since_commit = redrives_since_commit + 1, next_run_at = now()
        where id = $1 and status = 'pending'
          and cancel_requested_at is null
          and greatest(pending_since, coalesce(next_run_at, pending_since)) < now() - ($2::bigint * interval '1 millisecond')
      returning ${COLUMNS}`,
      [id, opts.pendingTtlMs],
    ),
  )
}

/** Parks a job the reconciler will not re-drive again. `failed` with a reason, and re-drivable
 *  only by an operator — which is the point: something needs a human before it runs again. */
export async function park(sql: SqlExecutor, id: string, reason: ParkReason, message: string | null): Promise<DurableJob | null> {
  return one(
    await sql.query<Row>(
      `update ${TABLE}
          set status = 'failed', parked_at = now(), finished_at = now(),
              lease_owner = null, lease_expires_at = now(), next_run_at = null, pending_since = null,
              error_code = $2, error_class = coalesce(error_class, 'terminal'),
              error_message = coalesce($3, error_message), updated_at = now()
        where id = $1 and status in ('pending','running')
      returning ${COLUMNS}`,
      [id, reason, message],
    ),
  )
}

/**
 * The operator's way out of `failed` — parked or terminal — and the manual take of an
 * expired lease.
 *
 * Resets both budgets, because an operator asking for a re-drive is explicitly asking for more
 * attempts. Does not reset `redrives`: that is identity, not budget, and a retained transport
 * job may still carry the old pair. Clears `cancel_requested_at` too, so a job that failed
 * before its slice ever observed the cancellation is not immediately cancelled again by the
 * re-driven slice's first heartbeat — the explicit re-drive supersedes the never-honoured
 * request.
 *
 * `completed` and `cancelled` are never re-drivable: the first is done, the second was asked
 * for. Start a new job instead.
 */
export async function operatorRedrive(
  tx: SqlExecutor,
  id: string,
  scope: Scope,
  opts: { graceMs: number; pendingTtlMs: number; force: boolean },
): Promise<DurableJob | null> {
  return one(
    await tx.query<Row>(
      `update ${TABLE}
          set ${REDRIVE_CORE}, redrives_since_commit = 0, consecutive_failures = 0, mirror_attempts = 0,
              parked_at = null, error_code = null, error_class = null, finished_at = null,
              domain_mirrored_at = null, cancel_requested_at = null, cancelled_by = null, next_run_at = now()
        where id = $1 and ${SCOPE}
          and ($6::boolean or error_code is distinct from 'unrecoverable')
          and (status = 'failed'
            or (status = 'running'
                and lease_expires_at < now() - ($4::bigint * interval '1 millisecond')
                and (next_run_at is null or next_run_at < now() - ($5::bigint * interval '1 millisecond'))))
      returning ${COLUMNS}`,
      [id, scope.tenantId, scope.organizationId, opts.graceMs, opts.pendingTtlMs, opts.force],
    ),
  )
}

/** Records the delivery the transport accepted, so a later cancel can remove it. */
export async function recordEnqueue(sql: SqlExecutor, id: string, queueJobId: string, queueName: string): Promise<void> {
  await sql.query(`update ${TABLE} set queue_job_id = $2, queue_name = $3 where id = $1`, [id, queueJobId, queueName])
}

// ---------------------------------------------------------------------------------------
// Reconciler candidate selection
// ---------------------------------------------------------------------------------------

/** `for update skip locked` is what lets two reconcilers run at once: each takes a disjoint
 *  slice of the candidates rather than one blocking the other or both acting on the same row. */
const SKIP_LOCKED = 'for update skip locked'

/** The reconciler is system-wide by default. The optional tenant filter exists so a fleet can
 *  shard the loop — one worker per tenant group — rather than having every worker scan every
 *  tenant's rows and skip-lock its way past them. */
export async function selectCancelling(tx: SqlExecutor, limit: number, tenantId?: string): Promise<DurableJob[]> {
  const result = await tx.query<Row>(
    `select ${COLUMNS} from ${TABLE}
      where cancel_requested_at is not null and status in ('pending','running')
        and ($2::uuid is null or tenant_id = $2)
      order by cancel_requested_at asc limit $1 ${SKIP_LOCKED}`,
    [limit, tenantId ?? null],
  )
  return result.rows.map(mapRow)
}

export async function selectOrphans(
  tx: SqlExecutor,
  opts: { graceMs: number; pendingTtlMs: number; limit: number; tenantId?: string },
): Promise<DurableJob[]> {
  const result = await tx.query<Row>(
    `select ${COLUMNS} from ${TABLE}
      where status = 'running'
        and lease_expires_at < now() - ($1::bigint * interval '1 millisecond')
        and (next_run_at is null or next_run_at < now() - ($2::bigint * interval '1 millisecond'))
        and cancel_requested_at is null
        and ($4::uuid is null or tenant_id = $4)
      order by lease_expires_at asc limit $3 ${SKIP_LOCKED}`,
    [opts.graceMs, opts.pendingTtlMs, opts.limit, opts.tenantId ?? null],
  )
  return result.rows.map(mapRow)
}

export async function selectStalePending(
  tx: SqlExecutor,
  opts: { pendingTtlMs: number; limit: number; tenantId?: string },
): Promise<DurableJob[]> {
  const result = await tx.query<Row>(
    `select ${COLUMNS} from ${TABLE}
      where status = 'pending'
        and cancel_requested_at is null
        and greatest(pending_since, coalesce(next_run_at, pending_since)) < now() - ($1::bigint * interval '1 millisecond')
        and ($3::uuid is null or tenant_id = $3)
      order by pending_since asc limit $2 ${SKIP_LOCKED}`,
    [opts.pendingTtlMs, opts.limit, opts.tenantId ?? null],
  )
  return result.rows.map(mapRow)
}

// ---------------------------------------------------------------------------------------
// Read side
// ---------------------------------------------------------------------------------------

export type ListFilter = {
  kind?: string
  status?: DurableJobStatus
  subject?: { type: string; id: string }
  page?: number
  pageSize?: number
}

export async function listJobs(sql: SqlExecutor, scope: Scope, filter: ListFilter = {}): Promise<{ items: DurableJob[]; total: number }> {
  const page = Math.max(1, filter.page ?? 1)
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 20))
  // Written out rather than reusing SCOPE: that constant is numbered for statements whose
  // first parameter is the job id, and renumbering it by string replacement is precisely the
  // kind of cleverness that silently changes a predicate.
  const where: string[] = ['tenant_id = $1 and (organization_id = $2 or ($2::uuid is null and organization_id is null))']
  const params: unknown[] = [scope.tenantId, scope.organizationId]
  const push = (clause: string, value: unknown) => {
    params.push(value)
    where.push(clause.replace('$?', `$${params.length}`))
  }
  if (filter.kind) push('kind = $?', filter.kind)
  if (filter.status) push('status = $?', filter.status)
  if (filter.subject) {
    push('subject_type = $?', filter.subject.type)
    push('subject_id = $?', filter.subject.id)
  }
  const clause = where.join(' and ')
  const total = await sql.query<Row>(`select count(*)::int as n from ${TABLE} where ${clause}`, params)
  const items = await sql.query<Row>(
    `select ${COLUMNS} from ${TABLE} where ${clause} order by created_at desc limit ${pageSize} offset ${(page - 1) * pageSize}`,
    params,
  )
  return { items: items.rows.map(mapRow), total: num(total.rows[0]?.n) }
}
