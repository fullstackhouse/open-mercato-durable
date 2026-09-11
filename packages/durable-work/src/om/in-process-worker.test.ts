// The worker running inside the host's server process.
//
// The behaviour that matters here is not "does it start" but "does it start exactly once, and
// refuse the one context where starting is wrong". Calling this is the opt-in, so the question
// of "was it asked for" is settled by the call itself; what remains is a Next production build,
// which evaluates `instrumentation.ts` and must not bind a broker. Next also calls `register()`
// once per runtime, so a helper that started a worker per call would put several on one process.

import { afterEach, describe, expect, it, vi } from 'vitest'

const stop = vi.fn().mockResolvedValue(undefined)
const startWorker = vi.fn().mockResolvedValue({ owner: 'dw-test-owner', stop })

vi.mock('../core/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/worker')>()),
  startWorker: (...args: unknown[]) => startWorker(...args),
}))

const { resetInProcessWorker, startInProcessWorker } = await import('./in-process-worker')

const container = { resolve: (name: string) => ({ name }) }
const run = (env: Record<string, string | undefined>) =>
  startInProcessWorker({ resolveContainer: async () => container, env: env as NodeJS.ProcessEnv })

afterEach(() => {
  resetInProcessWorker()
  startWorker.mockClear()
})

describe('startInProcessWorker', () => {
  it('starts because it was called, with no second switch to also set', async () => {
    // The regression this guards: re-introducing an enable flag would make an explicitly wired
    // call silently do nothing, which reads exactly like a broker that never delivered.
    await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).resolves.toEqual({ owner: 'dw-test-owner' })
    expect(startWorker).toHaveBeenCalledTimes(1)
  })

  it('refuses to start during a Next production build', async () => {
    // `instrumentation.ts` is evaluated at build time too. A build has no business binding a
    // broker from CI, and briefly owning jobs it cannot finish is worse than not starting.
    await expect(
      run({ DURABLE_WORK_TRANSPORT: 'pgboss', NEXT_PHASE: 'phase-production-build' }),
    ).resolves.toBeNull()
    expect(startWorker).not.toHaveBeenCalled()
  })

  it('starts once per process however many times a bootstrap runs', async () => {
    const env = { DURABLE_WORK_TRANSPORT: 'pgboss' }
    const [first, second, third] = await Promise.all([run(env), run(env), run(env)])

    expect(startWorker).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(second).toEqual(third)
  })

  it("passes the host's timing configuration through rather than re-deriving it", async () => {
    await run({
      DURABLE_WORK_TRANSPORT: 'pgboss',
      DURABLE_WORK_TICK_MS: '5000',
      DURABLE_WORK_GRACE_MS: '7000',
      DURABLE_WORK_DRAIN_TIMEOUT_MS: '9000',
    })

    expect(startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ tickMs: 5000, reconcilerGraceMs: 7000, drainTimeoutMs: 9000 }),
    )
  })

  it('retries a failed start instead of leaving the process without a worker', async () => {
    // The failure this guards: the host calls this once, at boot. Nothing calls it again, so a
    // start that failed used to stay failed for the life of the pod — and TCP-only readiness
    // probes cannot see it, so every replica would serve traffic with no worker and no
    // reconciler until someone noticed the runs piling up.
    vi.useFakeTimers()
    try {
      startWorker.mockRejectedValueOnce(new Error('redis is not up yet'))
      await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).rejects.toThrow('redis is not up yet')

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(startWorker).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  it('never hands a later caller the rejection from an earlier attempt', async () => {
    vi.useFakeTimers()
    try {
      startWorker.mockRejectedValueOnce(new Error('transient'))
      await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).rejects.toThrow('transient')

      // A cached rejected promise is what turns one bad moment into a permanent condition.
      await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).resolves.toEqual({ owner: 'dw-test-owner' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off between attempts rather than hammering a broker that is down', async () => {
    // Asserting the scheduled delay rather than driving the clock: `vi.waitFor` advances fake
    // timers, so a test written around timer mechanics ends up firing the retry it is trying to
    // measure — which is how this test first "proved" a 5s backoff that was really 10s.
    const events: Array<{ attempt: unknown; delayMs: unknown }> = []
    const log = (event: string, fields: Record<string, unknown>) => {
      if (event === 'durable_work.worker_start_retry_scheduled') {
        events.push({ attempt: fields.attempt, delayMs: fields.delayMs })
      }
    }
    vi.useFakeTimers()
    try {
      startWorker.mockRejectedValue(new Error('still down'))
      const attempt = () =>
        startInProcessWorker({
          resolveContainer: async () => container,
          env: { DURABLE_WORK_TRANSPORT: 'pgboss' } as NodeJS.ProcessEnv,
          log,
        })

      await expect(attempt()).rejects.toThrow('still down')
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.advanceTimersByTimeAsync(20_000)

      expect(events.map((e) => e.delayMs)).toEqual([5_000, 10_000, 20_000, 40_000])
    } finally {
      startWorker.mockReset()
      startWorker.mockResolvedValue({ owner: 'dw-test-owner', stop })
      vi.useRealTimers()
    }
  })

  it('stops retrying once the process is shutting down', async () => {
    vi.useFakeTimers()
    try {
      startWorker.mockRejectedValue(new Error('down'))
      await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).rejects.toThrow('down')

      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(60_000)

      // A retry firing after SIGTERM would bind a broker the process is in the middle of leaving.
      expect(startWorker).toHaveBeenCalledTimes(1)
    } finally {
      startWorker.mockReset()
      startWorker.mockResolvedValue({ owner: 'dw-test-owner', stop })
      vi.useRealTimers()
    }
  })

  it('drains on SIGTERM instead of leaving the process, which the server owns', async () => {
    await run({ DURABLE_WORK_TRANSPORT: 'pgboss' })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    process.emit('SIGTERM')
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())

    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
