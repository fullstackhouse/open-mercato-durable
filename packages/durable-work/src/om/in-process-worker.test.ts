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

  it('drains on SIGTERM instead of leaving the process, which the server owns', async () => {
    await run({ DURABLE_WORK_TRANSPORT: 'pgboss' })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    process.emit('SIGTERM')
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())

    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
