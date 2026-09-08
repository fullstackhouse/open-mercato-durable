// The public vocabulary of the mechanism. Kept free of Open Mercato and of any transport:
// `core/` talks to Postgres through `SqlExecutor` and to a broker through `TransportAdapter`,
// so the same code runs in the OM module, in the CLI worker and in the failure harness.

export type DurableJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Why a slice returned. `budget` hands the rest of the work back without spending a retry. */
export type SliceOutcome = 'drained' | 'budget' | 'cancelled'

/** What the reconciler does with a job whose driver died. Default `park`: a job that nobody
 *  declared idempotent is not re-run automatically. */
export type OrphanPolicy = 'redrive' | 'park'

/** How an error was classified. `transient` is the default for anything unrecognised — the
 *  transport retries it. `terminal` fails the job now but leaves it re-drivable. `unrecoverable`
 *  fails it now and requires `{ force: true }` to re-drive. */
export type ErrorClass = 'transient' | 'terminal' | 'unrecoverable'

/** Written by the mechanism into `error_code`. Park reasons come from the reconciler, verdicts
 *  from a slice; an operator re-drive clears either. */
export type ParkReason = 'orphaned' | 'poison' | 'never_started' | 'no_handler'
export type SliceVerdict = 'unrecoverable' | 'retry_exhausted'

/** Every statement is tenant- and organization-scoped. A null organization is a real value
 *  (it means tenant-wide), which is why the lock-key index coalesces it to the zero uuid
 *  rather than relying on NULL-distinctness. */
export type Scope = { tenantId: string; organizationId: string | null }

/** What a worker holds while it runs a slice. There is deliberately no worker-clock expiry
 *  here: expiry is a fact about the database's clock, and only the database may judge it. */
export type Lease = { jobId: string; owner: string; epoch: number; ttlMs: number }

/** The identity of one delivery. A job may be delivered many times; only the delivery whose
 *  (seq, redrives) still matches the row may claim it. */
export type Delivery = { jobId: string; seq: number; redrives: number }

/** One row of `durable_work_jobs`, in camelCase. The row IS the authority for liveness:
 *  status, lease, budgets and cancellation intent are read from nowhere else. */
export type DurableJob = {
  id: string
  tenantId: string
  organizationId: string | null
  kind: string
  status: DurableJobStatus
  createdBy: string | null
  createdAt: Date
  updatedAt: Date

  input: unknown
  checkpoint: unknown
  meta: Record<string, unknown> | null

  idempotencyKey: string | null
  lockKey: string | null
  subjectType: string | null
  subjectId: string | null
  progressJobId: string | null

  leaseOwner: string | null
  leaseEpoch: number
  leaseExpiresAt: Date | null
  heartbeatAt: Date | null

  queueName: string | null
  queueJobId: string | null
  continuationSeq: number
  redrives: number
  nextRunAt: Date | null
  pendingSince: Date | null

  redrivesSinceCommit: number
  consecutiveFailures: number
  interruptions: number
  mirrorAttempts: number
  lastCommittedAt: Date | null

  startedAt: Date | null
  finishedAt: Date | null
  parkedAt: Date | null
  cancelRequestedAt: Date | null
  cancelledBy: string | null
  errorClass: ErrorClass | null
  errorCode: string | null
  errorMessage: string | null
  domainMirroredAt: Date | null

  processedCount: number
  totalCount: number | null
}

/** The minimum a caller must supply to create a job. `kind` selects the handler; `lockKey`
 *  is the single-runner key; `idempotencyKey` makes `start` safe to call twice. */
export type StartJobInput = {
  kind: string
  input?: unknown
  idempotencyKey?: string | null
  lockKey?: string | null
  subject?: { type: string; id: string } | null
  progressJobId?: string | null
  createdBy?: string | null
  meta?: Record<string, unknown> | null
  totalCount?: number | null
}

/** A minimal SQL surface. Deliberately not MikroORM: the statements are hand-written because
 *  every one of them is a compare-and-set whose predicate is the actual specification, and an
 *  ORM would put a layer between that predicate and review. */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number }>
}

export interface SqlTransactor extends SqlExecutor {
  /** Runs `fn` inside one transaction. A throw rolls back and the throw propagates. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>
}

/** Effective per-kind settings after defaults are applied. */
export type LeaseSettings = { ttlMs: number; sliceBudgetMs: number; pendingTtlMs: number }
export type BudgetSettings = { maxRedrives: number; maxConsecutiveFailures: number; poisonRedrivesWithoutCommit: number }
export type RetrySettings = { attempts: number; backoff: { type: 'exponential' | 'fixed'; delayMs: number; maxDelayMs: number } }
