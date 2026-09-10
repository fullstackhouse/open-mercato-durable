// The pg-boss adapter: production without Redis, and the only adapter that can enqueue a
// delivery inside the caller's transaction.
//
// That one capability is why it exists. `send(..., { db })` composes its statements on a
// client the caller supplies, so a domain row, its job row and its delivery all commit or all
// roll back. With any other transport there is a window between commit and enqueue where a
// crash leaves a job nobody will ever deliver — the reconciler closes it, but closing it after
// fifteen minutes is not the same as never opening it.
//
// pg-boss is a peer dependency and is imported lazily.

import { deliveryId } from '../core/ids'
import type { Delivery, SqlExecutor } from '../core/types'
import type {
  BindOptions,
  BoundWorker,
  DeliveryHandler,
  DeliveryState,
  EnqueueOptions,
  TransportAdapter,
} from './types'

// pg-boss's surface, described structurally rather than imported.
//
// `typeof import('pg-boss')` is more faithful and is the wrong tool here. This package's
// `exports` map points its `types` condition at these sources, so a host typechecks this file —
// and pg-boss is an *optional* peer. A host running the BullMQ transport, which therefore never
// installs pg-boss, failed its own typecheck on a file it never loads. Found in a real adopter,
// not in this repo, because here the dependency is always present.
//
// Only what this adapter calls is described. pg-boss 12 exports the class by name, not as a
// default. The runtime import below is unchanged and still a literal, so bundlers can see it.
type PgBossSendOptions = {
  singletonKey?: string
  singletonSeconds?: number
  startAfter?: number
  retryLimit?: number
  retryDelay?: number
  retryBackoff?: boolean
  retryDelayMax?: number
  db?: unknown
}

type PgBossJob = { id: string; data: Delivery; state?: string; signal?: AbortSignal }

type PgBossInstance = {
  start(): Promise<unknown>
  stop(options?: { graceful?: boolean; close?: boolean; timeout?: number }): Promise<unknown>
  createQueue(name: string, options?: { expireInSeconds?: number }): Promise<unknown>
  send(name: string, data: object, options?: PgBossSendOptions): Promise<string | null>
  deleteJob(name: string, id: string): Promise<unknown>
  getJobById(name: string, id: string): Promise<{ state?: string } | null>
  work(name: string, options: { batchSize?: number }, handler: (jobs: PgBossJob[]) => Promise<unknown>): Promise<string>
  offWork(name: string, options?: { id?: string }): Promise<unknown>
}

type PgBossModule = { PgBoss: new (options: { connectionString: string; schema?: string; max?: number }) => PgBossInstance }

export type PgBossTransportOptions = {
  connectionString: string
  /** Keeps pg-boss's own tables out of `public`, so they are obviously not the app's. */
  schema?: string
  /** Reuse an already-started instance instead of owning its lifecycle. */
  instance?: PgBossInstance
  /**
   * Cap on pg-boss's own connection pool.
   *
   * It matters more than it looks. This transport opens a pool *besides* the app's — the
   * mechanism's own SQL rides the host's EntityManager, but pg-boss does not — and a host that
   * runs the worker in-process gets one per process that touches the transport: the web process
   * and any spawned queue worker. Multiplied by replicas during a rolling deploy, pg-boss's own
   * default is enough to eat a Postgres `max_connections` budget that was sized without it.
   */
  max?: number
}

let cached: PgBossModule | null = null
async function pgboss(): Promise<PgBossModule> {
  if (cached) return cached
  try {
    // `@ts-expect-error` is the wrong tool here: in this repo the dependency IS installed, so
    // there is no error to expect and the build would fail on the assertion itself. The error
    // exists only in a host that never installed this optional peer — the case being suppressed.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional peer: absent in a host that runs another transport, and this file
    // must still typecheck there. The structural types above are why nothing else needs it.
    cached = (await import('pg-boss')) as unknown as PgBossModule
    return cached
  } catch (error) {
    throw new Error(
      'The pgboss transport requires the optional peer dependency `pg-boss`. Install it, or use DURABLE_WORK_TRANSPORT=bullmq.',
      { cause: error },
    )
  }
}

/**
 * Adapts a `SqlExecutor` to the shape pg-boss expects from a caller-supplied client.
 *
 * pg-boss only ever calls `executeSql`, so the whole surface is one method. Passing our own
 * executor through — rather than requiring a raw `pg` client — is what lets the caller's
 * transaction be a MikroORM one, a node-postgres one, or the harness's, without any of them
 * knowing about the others.
 */
function asDb(tx: SqlExecutor) {
  return {
    async executeSql(text: string, values: unknown[]) {
      const result = await tx.query(text, values)
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount }
    },
  }
}

/** A tick, in the same shape as any other delivery. */
const tickDelivery = (id: string): Delivery => ({ jobId: id, seq: 0, redrives: 0 })

export class PgBossTransport implements TransportAdapter {
  readonly name = 'pgboss' as const
  readonly supportsTransactionalEnqueue = true

  private boss: PgBossInstance | null = null
  private starting: Promise<PgBossInstance> | null = null
  private readonly ownsInstance: boolean
  private readonly ensuredQueues = new Set<string>()
  private readonly workerIds: Array<{ queue: string; id: string }> = []
  private readonly ticks: NodeJS.Timeout[] = []
  private readonly shutdown = new AbortController()

  constructor(private readonly options: PgBossTransportOptions) {
    this.boss = options.instance ?? null
    this.ownsInstance = !options.instance
  }

  private async ready(): Promise<PgBossInstance> {
    if (this.boss) return this.boss
    if (!this.starting) {
      this.starting = (async () => {
        const { PgBoss } = await pgboss()
        const instance = new PgBoss({
          connectionString: this.options.connectionString,
          schema: this.options.schema ?? 'durable_work_boss',
          ...(this.options.max ? { max: this.options.max } : {}),
        })
        await instance.start()
        this.boss = instance
        return instance
      })()
    }
    return this.starting
  }

  /** pg-boss 10+ requires a queue to exist before anything is sent to it. `expireInSeconds`
   *  belongs to the queue, not to the worker: it is how long a delivery may stay active before
   *  pg-boss reclaims it, so it must exceed a whole slice or work that is still running gets
   *  handed to a second worker — which the lease then refuses, wasting the slice. */
  private async ensureQueue(name: string, expireInSeconds?: number): Promise<PgBossInstance> {
    const boss = await this.ready()
    if (this.ensuredQueues.has(name)) return boss
    await boss.createQueue(name, expireInSeconds ? { expireInSeconds } : undefined)
    this.ensuredQueues.add(name)
    return boss
  }

  async enqueue(queue: string, delivery: Delivery, opts: EnqueueOptions): Promise<{ transportJobId: string }> {
    const boss = await this.ensureQueue(queue)
    const key = deliveryId(delivery)
    const sent = await boss.send(queue, delivery as unknown as object, {
      // pg-boss job ids are uuids, so the delivery identity travels as the singleton key —
      // which is also what makes a re-enqueue of the same delivery a no-op.
      singletonKey: key,
      startAfter: opts.delayMs && opts.delayMs > 0 ? Math.ceil(opts.delayMs / 1000) : undefined,
      retryLimit: opts.retry.attempts,
      retryDelay: Math.max(1, Math.round(opts.retry.backoff.delayMs / 1000)),
      // pg-boss rejects a max delay unless backoff is on, so the cap travels only with it.
      ...(opts.retry.backoff.type === 'exponential'
        ? { retryBackoff: true, retryDelayMax: Math.max(1, Math.round(opts.retry.backoff.maxDelayMs / 1000)) }
        : { retryBackoff: false }),
      ...(opts.tx ? { db: asDb(opts.tx) } : {}),
    })
    // `send` returns null when the singleton key collapsed this into an existing job. That is
    // the intended outcome, not a failure: the delivery is already scheduled.
    return { transportJobId: sent ?? key }
  }

  async remove(queue: string, transportJobId: string): Promise<void> {
    const boss = await this.ready()
    await boss.deleteJob(queue, transportJobId).catch(() => undefined)
  }

  async getState(queue: string, transportJobId: string): Promise<DeliveryState> {
    const boss = await this.ready()
    const job = await boss.getJobById(queue, transportJobId).catch(() => null)
    if (!job) return 'unknown'
    switch (job.state) {
      case 'created':
      case 'retry':
        return 'waiting'
      case 'active':
        return 'active'
      case 'completed':
        return 'completed'
      case 'cancelled':
      case 'failed':
        return 'failed'
      default:
        return 'unknown'
    }
  }

  async upsertTick(opts: { id: string; queue: string; everyMs: number }): Promise<void> {
    await this.ensureQueue(opts.queue)
    // pg-boss's own scheduler is cron-based, so its finest granularity is a minute — too
    // coarse for a repair loop. A per-process timer with a singleton key gives the cadence we
    // need and still collapses the fleet's ticks into one job per window. The trade-off is
    // stated rather than hidden: with zero workers up there is no tick, exactly as with a
    // broker-owned schedule that nobody polls.
    const everySeconds = Math.max(1, Math.round(opts.everyMs / 1000))
    const fire = async () => {
      if (this.shutdown.signal.aborted) return
      const boss = await this.ready()
      // Delivery-shaped, like every other payload on every adapter: a tick is a delivery
      // whose handler happens to ignore it, not a second kind of message.
      await boss
        .send(opts.queue, tickDelivery(opts.id), { singletonKey: opts.id, singletonSeconds: everySeconds })
        .catch(() => undefined)
    }
    void fire()
    const timer = setInterval(() => void fire(), opts.everyMs)
    timer.unref?.()
    this.ticks.push(timer)
  }

  async bind(queue: string, handler: DeliveryHandler, opts: BindOptions): Promise<BoundWorker> {
    const boss = await this.ensureQueue(queue, Math.ceil(opts.activeTimeoutMs / 1000))

    const workerId = await boss.work(
      queue,
      { batchSize: opts.concurrency },
      async (jobs: PgBossJob[]) => {
        for (const job of jobs) {
          // Whatever arrived is handed on unexamined. An adapter that inspects payloads
          // decides what counts as a real delivery, and this one used to skip anything
          // without a `jobId` — which silently swallowed every reconciler tick.
          const delivery = job.data

          const combined = new AbortController()
          const relay = () => combined.abort()
          job.signal?.addEventListener('abort', relay, { once: true })
          this.shutdown.signal.addEventListener('abort', relay, { once: true })

          try {
            await handler(delivery, {
              transportJobId: job.id,
              // pg-boss does not expose the attempt on the job, so the adapter reports the
              // first attempt and lets its own retry policy carry the rest. The consequence is
              // narrow: the delay written to `next_run_at` is the base rather than a backed-off
              // one, and pg-boss's own `retryBackoff` still spaces the real deliveries.
              attempt: 1,
              maxAttempts: 1,
              signal: combined.signal,
              handBack: async (next, handBackOpts) => {
                // No native hand-back: send the next delivery and let this one complete. The
                // row is already at `seq + 1`, so the new key cannot collide with this job.
                await this.enqueue(queue, next, {
                  delayMs: handBackOpts?.delayMs,
                  retry: { attempts: 1, backoff: { type: 'fixed', delayMs: 0, maxDelayMs: 0 } },
                })
              },
            })
          } catch (error) {
            if ((error as { name?: string })?.name === 'NoFurtherAttempts') continue // settled; no retry wanted
            throw error
          } finally {
            job.signal?.removeEventListener('abort', relay)
            this.shutdown.signal.removeEventListener('abort', relay)
          }
        }
      },
    )

    this.workerIds.push({ queue, id: workerId })
    return {
      queue,
      close: async () => {
        const instance = await this.ready()
        await instance.offWork(queue, { id: workerId }).catch(() => undefined)
      },
    }
  }

  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    this.shutdown.abort()
    for (const timer of this.ticks) clearInterval(timer)
    this.ticks.length = 0
    if (!this.boss) return
    if (!this.ownsInstance) return
    await this.boss.stop({ graceful: true, close: true, timeout: opts.timeoutMs ?? 30_000 }).catch(() => undefined)
    this.boss = null
    this.starting = null
  }
}
