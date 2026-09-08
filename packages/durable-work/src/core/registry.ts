// What a caller declares when they hand work to the mechanism, and the process-wide map of
// those declarations.
//
// The registry is process-wide rather than per-container because a job's handler has to be
// resolvable in every process that can act on the job: the worker runs its slices, the web
// process re-drives and cancels it, the reconciler parks it. A registration attached to a
// request-scoped container would be invisible to the next request.

import { UnknownKindError } from './errors'
import type {
  BudgetSettings,
  DurableJob,
  ErrorClass,
  Lease,
  LeaseSettings,
  RetrySettings,
  Scope,
  SliceOutcome,
  SqlExecutor,
} from './types'

/** What a slice is given. Everything it needs to make progress and to stop safely. */
export interface SliceContext<TInput = unknown, TCheckpoint = unknown> {
  job: DurableJob
  scope: Scope
  lease: Lease
  input: TInput
  checkpoint: TCheckpoint | null

  /** Aborts on shutdown, on cancellation, and when the lease is lost. A slice that checks it
   *  at batch boundaries is the difference between a clean stop and a killed process. */
  signal: AbortSignal

  /** Milliseconds this slice may run before it should hand back. */
  budgetMs: number

  /** Stable per (job, slice). Forward it to any external side effect so a redelivered slice
   *  is recognised as the same request rather than a second one. */
  idempotencyKey: string

  /** Extends the lease and reports progress. `committed: true` records that a unit of work
   *  is durably written, which resets the failure and orphan budgets. Throws `LeaseLostError`
   *  when the lease is gone. */
  heartbeat(patch?: { processedCount?: number; totalCount?: number | null; committed?: boolean }): Promise<void>

  /** Records resume state and counts as a committed unit, under the fence. */
  checkpoint_(state: TCheckpoint, patch?: { processedCount?: number; totalCount?: number | null }): Promise<void>

  /** Runs `fn` in a transaction that also re-asserts this lease. If the lease is gone the
   *  transaction rolls back and `LeaseLostError` is thrown — so a worker that lost its lease
   *  mid-write cannot land a write that outlives its right to make one. */
  fencedWrite<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>

  /** True once the slice budget is spent or a stop was requested. Check it at boundaries. */
  shouldYield(): boolean
}

export interface KindDefinition<TInput = unknown, TCheckpoint = unknown> {
  kind: string
  /** Which queue carries this kind. Kinds sharing a queue share a worker's concurrency. */
  queue: string
  /** ACL features an operator needs to re-drive this kind, beyond `durable_work.operate`. */
  requiredFeatures?: string[]
  concurrency?: number

  lease?: Partial<LeaseSettings>
  budget?: Partial<BudgetSettings>
  retry?: { attempts?: number; backoff?: Partial<RetrySettings['backoff']> }

  /** What the reconciler does with an orphan. Defaults to `park`: a job nobody declared
   *  idempotent is not re-run automatically just because its worker died. */
  orphanPolicy?: 'redrive' | 'park'

  /** One slice under a held lease. Return when the budget is spent or the signal aborts. */
  step(ctx: SliceContext<TInput, TCheckpoint>): Promise<SliceOutcome>

  /**
   * Mirrors a terminal transition onto the domain row, inside the terminal transaction.
   *
   * Must be idempotent and must return how many domain rows its update matched: `matched: 0`
   * is treated exactly like a throw, because "mirrored" means "the domain row agrees", not
   * "the callback ran". No events, no enqueues — those belong in `onAfterTransition`, which
   * runs after the commit.
   */
  onTransition?(job: DurableJob, scope: Scope, tx: SqlExecutor): Promise<{ matched: number }>

  /**
   * Re-opens the domain row when an operator re-drives. The mirror image of `onTransition`,
   * in the same transaction, with the same contract.
   *
   * Required whenever `onTransition` is declared — a mirror with no way back would leave an
   * operator able to re-drive the job while the domain row stays terminal.
   */
  onRedrive?(job: DurableJob, scope: Scope, tx: SqlExecutor): Promise<{ matched: number }>

  /** Release external resources before a cancellation commits. Same transaction, same
   *  idempotency rule as `onTransition`. */
  onCancel?(job: DurableJob, scope: Scope, tx: SqlExecutor): Promise<void>

  /** After-commit hooks. Best-effort and at-most-once: a throw is logged, never retried, and
   *  never affects the committed row. Domain events and log writes belong here. */
  onAfterTransition?(job: DurableJob, scope: Scope): Promise<void>
  onAfterRedrive?(job: DurableJob, scope: Scope): Promise<void>

  /** Override the default classification for errors this kind understands. */
  classify?(error: unknown): ErrorClass | null
}

export const DEFAULT_LEASE: LeaseSettings = { ttlMs: 60_000, sliceBudgetMs: 300_000, pendingTtlMs: 900_000 }
export const DEFAULT_BUDGET: BudgetSettings = { maxRedrives: 10, maxConsecutiveFailures: 5, poisonRedrivesWithoutCommit: 3 }
export const DEFAULT_RETRY: RetrySettings = { attempts: 5, backoff: { type: 'exponential', delayMs: 5_000, maxDelayMs: 300_000 } }

export type ResolvedKind<TInput = unknown, TCheckpoint = unknown> = KindDefinition<TInput, TCheckpoint> & {
  lease: LeaseSettings
  budget: BudgetSettings
  retry: RetrySettings
  orphanPolicy: 'redrive' | 'park'
  concurrency: number
}

export function resolveKind<TInput, TCheckpoint>(definition: KindDefinition<TInput, TCheckpoint>): ResolvedKind<TInput, TCheckpoint> {
  if (definition.onTransition && !definition.onRedrive) {
    throw new Error(
      `Kind ${JSON.stringify(definition.kind)} declares onTransition without onRedrive: a domain mirror with no way back would leave an operator able to re-drive the job while the domain row stays terminal.`,
    )
  }
  return {
    ...definition,
    lease: { ...DEFAULT_LEASE, ...definition.lease },
    budget: { ...DEFAULT_BUDGET, ...definition.budget },
    retry: {
      attempts: definition.retry?.attempts ?? DEFAULT_RETRY.attempts,
      backoff: { ...DEFAULT_RETRY.backoff, ...definition.retry?.backoff },
    },
    orphanPolicy: definition.orphanPolicy ?? 'park',
    concurrency: definition.concurrency ?? 1,
  }
}

/** The delay before the transport's next attempt, or null when none is coming. */
export function nextAttemptDelayMs(kind: ResolvedKind, attempt: number): number | null {
  if (attempt >= kind.retry.attempts) return null
  const { type, delayMs, maxDelayMs } = kind.retry.backoff
  const raw = type === 'fixed' ? delayMs : delayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(raw, maxDelayMs)
}

export class KindRegistry {
  private readonly kinds = new Map<string, ResolvedKind<never, never>>()

  register<TInput, TCheckpoint>(definition: KindDefinition<TInput, TCheckpoint>): void {
    const resolved = resolveKind(definition)
    const existing = this.kinds.get(definition.kind)
    // Re-registering the identical definition is a no-op so a module loaded twice (two entry
    // points, a test re-import) is not a crash; a *different* definition under the same id is
    // a genuine conflict and must not be resolved silently by last-write-wins.
    if (existing && existing.step !== definition.step) {
      throw new Error(`Duplicate durable job kind ${JSON.stringify(definition.kind)}: two different handlers registered under one id.`)
    }
    this.kinds.set(definition.kind, resolved as unknown as ResolvedKind<never, never>)
  }

  get(kind: string): ResolvedKind | undefined {
    return this.kinds.get(kind) as ResolvedKind | undefined
  }

  require(kind: string): ResolvedKind {
    const found = this.get(kind)
    if (!found) throw new UnknownKindError(kind)
    return found
  }

  has(kind: string): boolean {
    return this.kinds.has(kind)
  }

  list(): ResolvedKind[] {
    return [...this.kinds.values()] as ResolvedKind[]
  }

  queues(): string[] {
    return [...new Set(this.list().map((k) => k.queue))]
  }

  clear(): void {
    this.kinds.clear()
  }
}

/**
 * The process-wide registry. Modules register into this at import time.
 *
 * Module-scoped, so there is exactly one per copy of this package in the process — which is why
 * anything registering kinds must depend on this package as a PEER, never as a dependency. A
 * nested second copy would give the adopter its own registry: kinds would register into one,
 * the worker would read the other, and nothing would run. No error, no warning, just jobs that
 * sit pending forever while the reconciler eventually parks them `no_handler`.
 */
export const registry = new KindRegistry()
