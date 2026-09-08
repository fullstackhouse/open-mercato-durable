// What the mechanism needs from a broker, and nothing more.
//
// The interface is small on purpose. Lease, epoch fencing, slices and budgets all live above
// it, in the job row — because none of the candidate brokers fences (pg-boss completes a job
// on `state = 'active'` alone; neither it nor Graphile Worker has an epoch column), so that
// guarantee had to be ours regardless. Once it is ours, what remains for a transport is
// genuinely just delivery, and a transport becomes a replaceable detail rather than the
// design's centre. See docs/adr/0001-transport-adapters.md.

import type { Delivery, RetrySettings, SqlExecutor } from '../core/types'

export type TransportName = 'memory' | 'bullmq' | 'pgboss'

/** The state of a delivery, as far as the broker knows. Used to tell "the broker still holds
 *  this" from "nothing is scheduled" — the reconciler's two very different situations. */
export type DeliveryState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown'

export type EnqueueOptions = {
  /** How long the broker should hold the delivery before making it available. */
  delayMs?: number
  retry: RetrySettings
  /**
   * Enqueue inside the caller's transaction, so the job row and its delivery commit together.
   *
   * Only pg-boss can honour this — it accepts a caller-supplied client on `send`. Adapters
   * that cannot must ignore it, and the service must therefore enqueue *after* commit for
   * them. This is the one capability difference between the adapters that callers can see.
   */
  tx?: SqlExecutor
}

export type HandlerContext = {
  transportJobId: string
  /** 1-based. Together with the kind's retry settings this decides the next delay. */
  attempt: number
  maxAttempts: number
  /** Aborts when the process is shutting down, so a slice can stop at a batch boundary
   *  instead of being killed between two writes. */
  signal: AbortSignal
  /**
   * Hands the rest of the work back as a fresh delivery, without spending a retry attempt.
   *
   * Native where the broker supports it (BullMQ moves the job to delayed and keeps its id);
   * emulated elsewhere by enqueuing the next delivery and completing the current one. Either
   * way the contract is the same: after `handBack` resolves, the handler must return.
   */
  handBack(next: Delivery, opts?: { delayMs?: number }): Promise<void>
}

export type DeliveryHandler = (delivery: Delivery, ctx: HandlerContext) => Promise<void>

export type BindOptions = {
  concurrency: number
  /** How long a delivery may be in flight before the broker considers the worker dead. Must
   *  exceed the slice budget, or the broker will redeliver work that is still running — which
   *  the lease then refuses, wasting a whole slice. */
  activeTimeoutMs: number
}

export interface BoundWorker {
  queue: string
  close(opts?: { timeoutMs?: number }): Promise<void>
}

export interface TransportAdapter {
  readonly name: TransportName
  /** True when `enqueue` honours `tx`. Callers branch on this rather than on the name. */
  readonly supportsTransactionalEnqueue: boolean

  enqueue(queue: string, delivery: Delivery, opts: EnqueueOptions): Promise<{ transportJobId: string }>
  remove(queue: string, transportJobId: string): Promise<void>
  getState(queue: string, transportJobId: string): Promise<DeliveryState>

  /** A repeating delivery, used for the reconciler tick. Idempotent by `id`. */
  upsertTick(opts: { id: string; queue: string; everyMs: number }): Promise<void>

  bind(queue: string, handler: DeliveryHandler, opts: BindOptions): Promise<BoundWorker>

  /** Stops accepting work and waits, up to `timeoutMs`, for in-flight deliveries to end. */
  close(opts?: { timeoutMs?: number }): Promise<void>
}
