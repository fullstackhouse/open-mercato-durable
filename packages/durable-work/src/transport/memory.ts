// An in-process transport, for unit tests and fault injection.
//
// Not a toy: it implements the same delivery semantics as the real adapters — attempts,
// backoff, delayed availability, hand-back that spends no attempt, a real abort signal on
// close — and it runs the same conformance suite. Its purpose is to make failures *reachable*
// (duplicate a delivery, stall one, drop one) that a real broker only produces by accident.
//
// Explicitly not for production: nothing survives the process.

import { deliveryId } from '../core/ids'
import type { Delivery, RetrySettings } from '../core/types'
import type {
  BindOptions,
  BoundWorker,
  DeliveryHandler,
  DeliveryState,
  EnqueueOptions,
  TransportAdapter,
} from './types'

type Entry = {
  id: string
  queue: string
  delivery: Delivery
  availableAt: number
  attempt: number
  retry: RetrySettings
  state: DeliveryState
}

function backoffFor(retry: RetrySettings, attempt: number): number {
  const { type, delayMs, maxDelayMs } = retry.backoff
  const raw = type === 'fixed' ? delayMs : delayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(raw, maxDelayMs)
}

export type MemoryFaults = {
  /** Deliver each accepted delivery twice. The lease must refuse the second. */
  duplicateDeliveries?: boolean
  /** Swallow enqueues matching this predicate, simulating a broker that lost the message.
   *  The reconciler is what must notice. */
  dropEnqueue?: (delivery: Delivery) => boolean
  /** Hold a delivery indefinitely instead of running it. */
  stall?: (delivery: Delivery) => boolean
}

export class MemoryTransport implements TransportAdapter {
  readonly name = 'memory' as const
  readonly supportsTransactionalEnqueue = false

  private readonly entries = new Map<string, Entry>()
  private readonly handlers = new Map<string, { handler: DeliveryHandler; opts: BindOptions }>()
  private readonly ticks = new Map<string, { queue: string; everyMs: number; timer: NodeJS.Timeout }>()
  private readonly inFlight = new Set<Promise<void>>()
  private readonly abort = new AbortController()
  private pump: NodeJS.Timeout | null = null
  private closed = false

  constructor(private readonly faults: MemoryFaults = {}) {}

  async enqueue(queue: string, delivery: Delivery, opts: EnqueueOptions): Promise<{ transportJobId: string }> {
    const id = deliveryId(delivery)
    if (this.faults.dropEnqueue?.(delivery)) return { transportJobId: id }
    // Same id, same delivery: the broker deduplicates, which is what a caller-supplied job id
    // buys. The database refuses a duplicate anyway; this only saves the wasted claim.
    this.entries.set(id, {
      id,
      queue,
      delivery,
      availableAt: Date.now() + (opts.delayMs ?? 0),
      attempt: 0,
      retry: opts.retry,
      state: (opts.delayMs ?? 0) > 0 ? 'delayed' : 'waiting',
    })
    this.start()
    return { transportJobId: id }
  }

  async remove(_queue: string, transportJobId: string): Promise<void> {
    this.entries.delete(transportJobId)
  }

  async getState(_queue: string, transportJobId: string): Promise<DeliveryState> {
    return this.entries.get(transportJobId)?.state ?? 'unknown'
  }

  async upsertTick(opts: { id: string; queue: string; everyMs: number }): Promise<void> {
    this.ticks.get(opts.id)?.timer.unref?.()
    clearInterval(this.ticks.get(opts.id)?.timer)
    const timer = setInterval(() => {
      void this.enqueue(opts.queue, { jobId: opts.id, seq: 0, redrives: 0 }, { retry: TICK_RETRY })
    }, opts.everyMs)
    timer.unref?.()
    this.ticks.set(opts.id, { queue: opts.queue, everyMs: opts.everyMs, timer })
  }

  async bind(queue: string, handler: DeliveryHandler, opts: BindOptions): Promise<BoundWorker> {
    this.handlers.set(queue, { handler, opts })
    this.start()
    return {
      queue,
      close: async () => {
        this.handlers.delete(queue)
      },
    }
  }

  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.closed = true
    this.abort.abort()
    for (const tick of this.ticks.values()) clearInterval(tick.timer)
    this.ticks.clear()
    if (this.pump) clearInterval(this.pump)
    this.pump = null
    // Bounded: a handler that ignores its abort signal must not be able to hang shutdown
    // forever. Dropping the wait is the honest outcome — the lease still protects the row.
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, opts.timeoutMs ?? 30_000).unref?.())
    await Promise.race([Promise.allSettled([...this.inFlight]).then(() => undefined), deadline])
  }

  /** Test hook: how many deliveries the broker still holds. */
  size(): number {
    return this.entries.size
  }

  private start(): void {
    if (this.pump || this.closed) return
    this.pump = setInterval(() => void this.drain(), 5)
    this.pump.unref?.()
  }

  private async drain(): Promise<void> {
    if (this.closed) return
    const now = Date.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.state === 'active' || entry.availableAt > now) continue
      const bound = this.handlers.get(entry.queue)
      if (!bound) continue
      if (this.faults.stall?.(entry.delivery)) continue
      const running = [...this.inFlight].length
      if (running >= bound.opts.concurrency) return
      entry.state = 'active'
      entry.attempt += 1
      const promise = this.run(entry, bound.handler, bound.opts).finally(() => this.inFlight.delete(promise))
      this.inFlight.add(promise)
      if (this.faults.duplicateDeliveries) {
        const twin = this.run({ ...entry }, bound.handler, bound.opts).finally(() => this.inFlight.delete(twin))
        this.inFlight.add(twin)
      }
    }
  }

  private async run(entry: Entry, handler: DeliveryHandler, opts: BindOptions): Promise<void> {
    let handedBack = false
    try {
      await handler(entry.delivery, {
        transportJobId: entry.id,
        attempt: entry.attempt,
        maxAttempts: entry.retry.attempts,
        signal: this.abort.signal,
        handBack: async (next, handBackOpts) => {
          handedBack = true
          this.entries.delete(entry.id)
          await this.enqueue(entry.queue, next, { retry: entry.retry, delayMs: handBackOpts?.delayMs })
        },
      })
      if (!handedBack) {
        entry.state = 'completed'
        this.entries.delete(entry.id)
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'NoFurtherAttempts') {
        entry.state = 'failed'
        this.entries.delete(entry.id)
        return
      }
      if (entry.attempt >= entry.retry.attempts) {
        entry.state = 'failed'
        this.entries.delete(entry.id)
        return
      }
      entry.state = 'delayed'
      entry.availableAt = Date.now() + backoffFor(entry.retry, entry.attempt)
    } finally {
      void opts
    }
  }
}

/** The tick is a heartbeat, not work: one attempt, no backoff to reason about. */
const TICK_RETRY: RetrySettings = { attempts: 1, backoff: { type: 'fixed', delayMs: 0, maxDelayMs: 0 } }
