// The API everything else talks to: starting work, operating on it, and reading it.
//
// Deliberately thin. The guarantees live in the statements and in `runSlice`; this is where
// they are composed into the handful of operations a caller actually performs.

import { randomUUID } from 'node:crypto'

import { LockKeyHeldError } from './errors'
import { queueNameFor } from './ids'
import { reconcileOnce, type ReconcileReport } from './reconciler'
import { registry as globalRegistry, type KindRegistry } from './registry'
import { runAfterTransition } from './terminal'
import {
  cancelPending,
  findLiveByLockKey,
  getJob,
  listJobs,
  markMirrored,
  operatorRedrive,
  requestCancel,
  type ListFilter,
} from './store'
import * as store from './store'
import { enqueueJob } from './worker'
import type { DurableJob, Scope, SqlExecutor, SqlTransactor, StartJobInput } from './types'
import type { TransportAdapter } from '../transport/types'

export type StartResult = {
  job: DurableJob
  /** False when an existing job was returned for a repeated idempotency key. */
  created: boolean
  /**
   * Publishes the delivery.
   *
   * Separate from `start` on purpose. With a transport that cannot enqueue inside the caller's
   * transaction, enqueuing before the commit would publish a delivery for a job that may never
   * exist. So the caller commits first and then calls this — and if the process dies in
   * between, the reconciler picks the job up.
   */
  enqueue: () => Promise<void>
}

export type RedriveRefusal = { refused: 'lock_key_held' | 'not_redrivable' | 'unrecoverable_requires_force'; heldBy?: string }

export type DurableWorkServiceDeps = {
  sql: SqlTransactor
  transport: TransportAdapter
  registry?: KindRegistry
  graceMs?: number
  log?: (event: string, fields: Record<string, unknown>) => void
}

export class DurableWorkService {
  private readonly registry: KindRegistry

  constructor(private readonly deps: DurableWorkServiceDeps) {
    this.registry = deps.registry ?? globalRegistry
  }

  /**
   * Creates a job.
   *
   * `tx` is the caller's transaction, and passing it is the whole point for anyone whose
   * domain row and job row must agree: they commit together or not at all.
   */
  async start(input: StartJobInput, scope: Scope, opts: { tx?: SqlExecutor } = {}): Promise<StartResult> {
    const kind = this.registry.require(input.kind)
    const sql = opts.tx ?? this.deps.sql
    const queue = kind.queue || queueNameFor('default')

    const { job, created } = await store.insertJob(sql, randomUUID(), scope, input, queue)

    return {
      job,
      created,
      enqueue: async () => {
        if (!created) return // the existing job already has, or will get, a delivery
        await enqueueJob(this.deps.sql, this.deps.transport, kind, job)
      },
    }
  }

  /** Starts a job and publishes it, transactionally where the transport allows it. */
  async startAndEnqueue(input: StartJobInput, scope: Scope): Promise<StartResult> {
    if (this.deps.transport.supportsTransactionalEnqueue) {
      const kind = this.registry.require(input.kind)
      return this.deps.sql.transaction(async (tx) => {
        const started = await this.start(input, scope, { tx })
        if (started.created) await enqueueJob(this.deps.sql, this.deps.transport, kind, started.job, { tx })
        return { ...started, enqueue: async () => undefined }
      })
    }
    const started = await this.start(input, scope)
    await started.enqueue()
    return started
  }

  get(id: string, scope: Scope): Promise<DurableJob | null> {
    return getJob(this.deps.sql, id, scope)
  }

  list(scope: Scope, filter: ListFilter = {}): Promise<{ items: DurableJob[]; total: number }> {
    return listJobs(this.deps.sql, scope, filter)
  }

  /**
   * Asks a job to stop.
   *
   * Never writes a terminal status directly on a running job: the driver has to be given the
   * chance to stop cleanly at a boundary, and it observes this at its next heartbeat. A job
   * that nobody is driving is ended here and now, because there is nobody to observe anything.
   */
  async cancel(id: string, scope: Scope, by: string | null = null): Promise<DurableJob | null> {
    const requested = await requestCancel(this.deps.sql, id, scope, by)
    if (!requested) return null

    if (requested.status === 'pending') {
      const kind = this.registry.get(requested.kind)
      const ended = await this.deps.sql
        .transaction(async (tx) => {
          const row = await cancelPending(tx, id)
          if (!row) return null
          if (kind?.onCancel) await kind.onCancel(row, scope, tx)
          if (kind?.onTransition) {
            const { matched } = await kind.onTransition(row, scope, tx)
            if (matched < 1) throw new Error(`Domain mirror matched no rows for job ${row.id}`)
          }
          await markMirrored(tx, row.id)
          return row
        })
        // A failed mirror must not lose the operator's request: the row keeps
        // `cancel_requested_at`, so the reconciler settles it on a later tick.
        .catch(() => null)

      if (ended) {
        if (requested.queueJobId && requested.queueName) {
          await this.deps.transport.remove(requested.queueName, requested.queueJobId).catch(() => undefined)
        }
        if (kind) await runAfterTransition(kind, ended, scope)
        return ended
      }
    }
    return requested
  }

  /**
   * The operator's way back from a failed job.
   *
   * Refuses rather than guesses in three situations, because each has a different answer:
   * another live job holds the lock key (wait or cancel that one), the job is not in a state
   * a re-drive applies to (completed and cancelled jobs are done), and an unrecoverable
   * failure (someone must say explicitly that running it again is right).
   */
  async redrive(
    id: string,
    scope: Scope,
    opts: { force?: boolean } = {},
  ): Promise<DurableJob | RedriveRefusal> {
    const existing = await getJob(this.deps.sql, id, scope)
    if (!existing) return { refused: 'not_redrivable' }
    if (!opts.force && existing.errorCode === 'unrecoverable') return { refused: 'unrecoverable_requires_force' }

    if (existing.lockKey) {
      const holder = await findLiveByLockKey(this.deps.sql, scope, existing.lockKey)
      if (holder && holder.id !== id) return { refused: 'lock_key_held', heldBy: holder.id }
    }

    const kind = this.registry.get(existing.kind)
    try {
      const redriven = await this.deps.sql.transaction(async (tx) => {
        const row = await operatorRedrive(tx, id, scope, {
          graceMs: this.deps.graceMs ?? 20_000,
          pendingTtlMs: kind?.lease.pendingTtlMs ?? 900_000,
          force: opts.force ?? false,
        })
        if (!row) return null
        // The domain row is re-opened in the same transaction that re-opens the job row. A
        // mirror with no way back would leave an operator able to restart the job while the
        // domain record stayed terminal.
        if (kind?.onRedrive) {
          const { matched } = await kind.onRedrive(row, scope, tx)
          if (matched < 1) throw new Error(`Domain re-open matched no rows for job ${row.id}`)
        }
        return row
      })
      if (!redriven) return { refused: 'not_redrivable' }

      if (kind) {
        await enqueueJob(this.deps.sql, this.deps.transport, kind, redriven)
        if (kind.onAfterRedrive) await kind.onAfterRedrive(redriven, scope).catch(() => undefined)
      }
      this.deps.log?.('durable_work.job_redriven', { jobId: id, by: 'operator', redrives: redriven.redrives })
      return redriven
    } catch (error) {
      // The partial unique index is the last word on the single-runner guarantee: a job that
      // started between the check above and this statement raises here, and the answer is the
      // same refusal rather than a second live runner.
      if ((error as { code?: string })?.code === '23505') {
        const holder = existing.lockKey ? await findLiveByLockKey(this.deps.sql, scope, existing.lockKey) : null
        return { refused: 'lock_key_held', heldBy: holder?.id }
      }
      throw error
    }
  }

  reconcile(opts: { batchSize?: number; tenantId?: string } = {}): Promise<ReconcileReport> {
    return reconcileOnce({
      sql: this.deps.sql,
      registry: this.registry,
      graceMs: this.deps.graceMs,
      log: this.deps.log,
      batchSize: opts.batchSize,
      tenantId: opts.tenantId,
      enqueue: async (job) => {
        const kind = this.registry.get(job.kind)
        if (kind) await enqueueJob(this.deps.sql, this.deps.transport, kind, job)
      },
    })
  }
}

export { LockKeyHeldError }
