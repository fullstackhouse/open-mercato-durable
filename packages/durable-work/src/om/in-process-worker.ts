// Running the worker inside the app's server process, rather than beside it.
//
// The worker has to be *a* process; it does not have to be its own. `mercato server start`
// already brings up the queue workers an app declares, and an operator reasonably expects
// durable work to arrive the same way — install the package, register the module, done. A
// deployment that also requires a second container or Deployment is a step every host must get
// right, and one that is silently fatal when missed: runs are created, adopted, leased by
// nobody, and parked by the reconciler much later.
//
// Coupling the worker to the web process costs less here than it would elsewhere, because the
// mechanism is built for exactly the failure that coupling introduces. A deploy stops the web
// process mid-slice; the lease expires, the reconciler takes the job, and another replica
// resumes from the committed cursor. That is the same path a killed worker takes, and it is
// tested. Scaling is a benefit rather than a hazard: N web replicas mean N workers, and the
// lock key still allows only one live run per subject.
//
// What it does cost, stated plainly so a host can weigh it:
//
//   - the worker shares the pod's memory and database pool with request handling, so a host
//     that sizes pods tightly must account for a third consumer
//   - slice work is I/O-bound (SQL, HTTP, a source database), so it interleaves with requests
//     rather than blocking them — but a CPU-heavy kind would not, and belongs in its own process
//   - autoscaling on CPU sees worker load as web load
//
// A host that would rather keep them apart sets nothing and runs `mercato durable_work worker`
// as its own process; that path is unchanged and remains the right one for heavy kinds.

import { registry } from '../core/registry'
import { startWorker } from '../core/worker'
import type { SqlTransactor } from '../core/types'
import type { TransportAdapter } from '../transport/types'
import { readConfig } from './config'

export type InProcessWorkerOptions = {
  /** Resolves the app's container. Defaults to Open Mercato's request container. */
  resolveContainer?: () => Promise<{ resolve(name: string): unknown }>
  /** Restrict to a subset of registered kinds. */
  kinds?: string[]
  concurrency?: number
  log?: (event: string, fields: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
}

/** Started once per process, however many times a host's bootstrap runs. Next calls
 *  `register()` per runtime, and a container may be built per request. */
let started: Promise<{ owner: string } | null> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let shuttingDown = false
let signalsBound = false

/**
 * How long to wait before trying again after a failed start, doubling to a cap.
 *
 * Deliberately not configurable. The host calls `startInProcessWorker` exactly once, at boot, so
 * there is nobody to retry on its behalf — which made a failed start permanent for the life of
 * the pod. A blip in the broker during a rollout could therefore leave every replica serving
 * traffic with no worker and no reconciler, indefinitely, because readiness probes cannot see
 * this and nothing restarts the pod. Recovering from that is not a policy a host should have to
 * opt into.
 */
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000

/**
 * Starts the durable worker in this process.
 *
 * Calling this IS the opt-in — there is no environment variable to also set. A host that would
 * rather run the worker apart simply does not call it, and runs `mercato durable_work worker`
 * instead. A second switch in front of an explicitly wired call only creates a way for the two
 * to disagree, which is exactly how a host ends up with runs that nothing leases.
 *
 * The one thing that is still refused is a Next production build. `instrumentation.ts` is
 * evaluated there too, and a build has no business binding a broker or holding a lease — it
 * would reach for Redis or Postgres from CI and, worse, briefly own jobs it cannot finish.
 *
 * Returns the worker's owner id, or null when it did not start.
 */
export async function startInProcessWorker(options: InProcessWorkerOptions = {}): Promise<{ owner: string } | null> {
  const env = options.env ?? process.env
  if (env.NEXT_PHASE === 'phase-production-build') return null
  if (started) return started
  bindShutdownSignals(options)
  started = attemptStart(options, 1)
  return started
}

/**
 * One attempt, with the next one scheduled if it fails.
 *
 * The memo is cleared before the retry is queued, so a rejected start is never handed to a later
 * caller — a cached rejection is how "we tried once and it broke" becomes "this process will
 * never have a worker".
 */
async function attemptStart(options: InProcessWorkerOptions, attempt: number): Promise<{ owner: string } | null> {
  const log = options.log ?? (() => undefined)
  try {
    return await doStart(options)
  } catch (error) {
    started = null
    scheduleRetry(options, attempt, log)
    throw error
  }
}

function scheduleRetry(options: InProcessWorkerOptions, attempt: number, log: NonNullable<InProcessWorkerOptions['log']>): void {
  if (shuttingDown || retryTimer) return
  const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS)
  log('durable_work.worker_start_retry_scheduled', { attempt, delayMs })
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (shuttingDown) return
    // The rejection is already reported by the attempt itself and handled by the retry it
    // schedules; swallowing it here only stops an unhandled rejection from taking the process
    // down for a failure that is being dealt with.
    started = attemptStart(options, attempt + 1)
    void started.catch(() => undefined)
  }, delayMs)
  // Never hold the process open for a retry. The web server decides when to exit.
  retryTimer.unref?.()
}

function bindShutdownSignals(options: InProcessWorkerOptions): void {
  if (signalsBound) return
  signalsBound = true
  const stopRetrying = () => {
    shuttingDown = true
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
  process.once('SIGTERM', stopRetrying)
  process.once('SIGINT', stopRetrying)
}

async function doStart(options: InProcessWorkerOptions): Promise<{ owner: string } | null> {
  const config = readConfig(options.env ?? process.env)
  {
    const log = options.log ?? (() => undefined)
    const resolveContainer =
      options.resolveContainer ??
      (async () => {
        const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
        return createRequestContainer()
      })

    const container = await resolveContainer()
    const sql = container.resolve('durableWorkSql') as SqlTransactor
    const transport = container.resolve('durableWorkTransport') as TransportAdapter

    const worker = await startWorker({
      sql,
      transport,
      registry,
      kinds: options.kinds,
      concurrency: options.concurrency,
      tickMs: config.tickMs,
      reconcilerGraceMs: config.reconcilerGraceMs,
      drainTimeoutMs: config.drainTimeoutMs,
      log,
    })

    log('durable_work.worker_started', {
      owner: worker.owner,
      transport: transport.name,
      inProcess: true,
      kinds: registry.list().map((kind) => kind.kind),
    })

    // SIGTERM is what a deploy sends. Draining rather than exiting is the difference between a
    // slice handing its remaining work back and a slice being cut off between two writes.
    //
    // The listeners do not call `process.exit`: this process is the web server, and it owns
    // when to leave. Draining the worker first is all that is wanted here.
    let stopping = false
    const stop = async (signal: string) => {
      if (stopping) return
      stopping = true
      log('durable_work.worker_draining', { signal, timeoutMs: config.drainTimeoutMs })
      await worker.stop().catch(() => undefined)
      log('durable_work.worker_stopped', {})
    }
    process.once('SIGTERM', () => void stop('SIGTERM'))
    process.once('SIGINT', () => void stop('SIGINT'))

    return { owner: worker.owner }
  }
}

/** Test seam: forget that a worker was started in this process. */
export function resetInProcessWorker(): void {
  started = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  shuttingDown = false
  signalsBound = false
}
