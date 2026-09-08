// The BullMQ adapter: the production default wherever an Open Mercato app already runs Redis.
//
// `bullmq` and `ioredis` are optional peers and are imported lazily, so an app that only uses
// the pg-boss adapter never has to install them.
//
// Supports BullMQ 5 and 6. Both carry everything the mechanism needs — a caller-supplied job
// id, the three-argument processor (so a real AbortSignal), `moveToDelayed` for a hand-back
// that spends no attempt, and job schedulers for the tick. The range matches
// `@open-mercato/queue`'s own peer range deliberately: a host on 5 must be able to install
// this package, because two BullMQ majors against one Redis is not a thing to arrange by
// accident.

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

type BullMQModule = typeof import('bullmq')
type BullQueue = InstanceType<BullMQModule['Queue']>
type BullJob = InstanceType<BullMQModule['Job']>
// Structural rather than `InstanceType<Worker>`: the concrete worker type is parameterised by
// the processor's return type and by a backend generic that differs between BullMQ 5 and 6,
// and nothing here needs more of it than shutdown.
type ClosableWorker = { close(force?: boolean): Promise<void>; on(event: 'error', listener: () => void): unknown }

export type BullMQTransportOptions = {
  /** An ioredis connection or the options to build one. Passed through untouched. */
  connection: unknown
  prefix?: string
}

let cached: BullMQModule | null = null
async function bullmq(): Promise<BullMQModule> {
  if (cached) return cached
  try {
    cached = await import('bullmq')
    return cached
  } catch (error) {
    throw new Error(
      'The bullmq transport requires the optional peer dependencies `bullmq` and `ioredis`. Install them, or use DURABLE_WORK_TRANSPORT=pgboss.',
      { cause: error },
    )
  }
}

function backoffFor(retry: RetrySettings) {
  return retry.backoff.type === 'fixed'
    ? { type: 'fixed' as const, delay: retry.backoff.delayMs }
    : { type: 'exponential' as const, delay: retry.backoff.delayMs }
}

export class BullMQTransport implements TransportAdapter {
  readonly name = 'bullmq' as const
  /** BullMQ writes to Redis, so it cannot join a Postgres transaction. Callers that need a
   *  job row and its delivery to commit together must enqueue after commit — and accept the
   *  gap the reconciler exists to close. */
  readonly supportsTransactionalEnqueue = false

  private readonly queues = new Map<string, BullQueue>()
  private readonly workers: ClosableWorker[] = []
  private readonly shutdown = new AbortController()

  constructor(private readonly options: BullMQTransportOptions) {}

  private async queue(name: string): Promise<BullQueue> {
    const existing = this.queues.get(name)
    if (existing) return existing
    const { Queue } = await bullmq()
    const queue = new Queue(name, { connection: this.options.connection as never, prefix: this.options.prefix })
    this.queues.set(name, queue)
    return queue
  }

  async enqueue(queueName: string, delivery: Delivery, opts: EnqueueOptions): Promise<{ transportJobId: string }> {
    const queue = await this.queue(queueName)
    const jobId = deliveryId(delivery)
    // A caller-supplied job id makes the broker deduplicate a re-enqueue of the same delivery.
    // It is a convenience, not the guarantee: the lease refuses a duplicate regardless, which
    // is the version of this that survives a Redis flush.
    await queue.add('delivery', delivery, {
      jobId,
      delay: opts.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
      attempts: opts.retry.attempts,
      backoff: backoffFor(opts.retry),
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400 },
    })
    return { transportJobId: jobId }
  }

  async remove(queueName: string, transportJobId: string): Promise<void> {
    const queue = await this.queue(queueName)
    // A job that is currently active cannot be removed; that is fine — the lease is what stops
    // it, and this is only an optimisation to keep a cancelled job from being delivered.
    await queue.remove(transportJobId).catch(() => undefined)
  }

  async getState(queueName: string, transportJobId: string): Promise<DeliveryState> {
    const queue = await this.queue(queueName)
    const job = await queue.getJob(transportJobId)
    if (!job) return 'unknown'
    const state = await job.getState()
    switch (state) {
      case 'waiting':
      case 'waiting-children':
      case 'prioritized':
        return 'waiting'
      case 'delayed':
        return 'delayed'
      case 'active':
        return 'active'
      case 'completed':
        return 'completed'
      case 'failed':
        return 'failed'
      default:
        return 'unknown'
    }
  }

  async upsertTick(opts: { id: string; queue: string; everyMs: number }): Promise<void> {
    const queue = await this.queue(opts.queue)
    // A job scheduler rather than a self-re-enqueueing job: the schedule lives in Redis, so it
    // survives every worker restarting at once, and one missed tick does not end the loop.
    await queue.upsertJobScheduler(
      opts.id,
      { every: opts.everyMs },
      // Delivery-shaped like every other payload, so a bound handler never has to tell a tick
      // from a delivery — and no adapter has to inspect a payload to decide.
      { name: 'tick', data: { jobId: opts.id, seq: 0, redrives: 0 } },
    )
  }

  async bind(queueName: string, handler: DeliveryHandler, opts: BindOptions): Promise<BoundWorker> {
    const { Worker, DelayedError, UnrecoverableError } = await bullmq()

    const worker = new Worker(
      queueName,
      async (job: BullJob, token?: string, signal?: AbortSignal) => {
        const delivery = job.data as Delivery
        let handedBack = false

        // BullMQ's signal aborts when the job's lock is lost; ours aborts on shutdown. A slice
        // needs to stop for either reason, so it watches both.
        const combined = new AbortController()
        const relay = () => combined.abort()
        signal?.addEventListener('abort', relay, { once: true })
        this.shutdown.signal.addEventListener('abort', relay, { once: true })

        try {
          await handler(delivery, {
            transportJobId: job.id ?? deliveryId(delivery),
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 1,
            signal: combined.signal,
            handBack: async (next, handBackOpts) => {
              handedBack = true
              // Native hand-back: the job keeps its id and its attempt count, and only its
              // payload moves on. That is what makes yielding free — a re-enqueue would
              // start a new job, and a retry would spend an attempt.
              await job.updateData(next as unknown as never)
              await job.moveToDelayed(Date.now() + (handBackOpts?.delayMs ?? 0), token)
            },
          })
        } catch (error) {
          // BullMQ retries on any throw, so "there is nothing left to attempt" has to be said
          // in its own vocabulary. Without this translation a job that has already reached a
          // terminal state is redelivered for every remaining attempt — each one refused by
          // the claim, each one a wasted slice and a misleading log line.
          if ((error as { name?: string })?.name === 'NoFurtherAttempts') {
            throw new UnrecoverableError((error as Error).message)
          }
          throw error
        } finally {
          signal?.removeEventListener('abort', relay)
          this.shutdown.signal.removeEventListener('abort', relay)
        }

        // BullMQ requires this to propagate out of the processor for the move to take effect.
        if (handedBack) throw new DelayedError()
      },
      {
        connection: this.options.connection as never,
        prefix: this.options.prefix,
        concurrency: opts.concurrency,
        // Must exceed a whole slice, or BullMQ redelivers work that is still running — which
        // the lease then refuses, wasting the slice and inflating the stall counter.
        lockDuration: opts.activeTimeoutMs,
      },
    )

    // Errors here are the broker's, not a job's; swallowing them would make a broken Redis
    // look like an idle queue.
    worker.on('error', () => undefined)
    this.workers.push(worker as unknown as ClosableWorker)
    return { queue: queueName, close: async (o) => void (await worker.close(o?.timeoutMs === 0)) }
  }

  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    // Abort first: in-flight slices see the signal and hand back at their next boundary,
    // rather than being cut off wherever they happen to be.
    this.shutdown.abort()
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, opts.timeoutMs ?? 30_000).unref?.())
    await Promise.race([Promise.allSettled(this.workers.map((w) => w.close())).then(() => undefined), deadline])
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()))
  }
}
