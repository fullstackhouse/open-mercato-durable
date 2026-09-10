// The worker running inside the host's server process.
//
// The behaviour that matters here is not "does it start" but "does it start exactly once, and
// stay out of the way when it was not asked for". A host's bootstrap runs in places that are
// not a server — a migration, a CLI command, a build — and Next calls `register()` once per
// runtime, so a helper that started a worker per call would put several on one process.

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
  it('does nothing unless the host asked for it', async () => {
    // Safe to call from a bootstrap shared with migrations and CLI commands.
    await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss' })).resolves.toBeNull()
    expect(startWorker).not.toHaveBeenCalled()
  })

  it('starts a worker when the flag is set, and reports its owner', async () => {
    await expect(run({ DURABLE_WORK_TRANSPORT: 'pgboss', DURABLE_WORK_INPROCESS_WORKER: 'true' })).resolves.toEqual({
      owner: 'dw-test-owner',
    })
    expect(startWorker).toHaveBeenCalledTimes(1)
  })

  it('starts once per process however many times a bootstrap runs', async () => {
    const env = { DURABLE_WORK_TRANSPORT: 'pgboss', DURABLE_WORK_INPROCESS_WORKER: '1' }
    const [first, second, third] = await Promise.all([run(env), run(env), run(env)])

    expect(startWorker).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(second).toEqual(third)
  })

  it("passes the host's timing configuration through rather than re-deriving it", async () => {
    await run({
      DURABLE_WORK_TRANSPORT: 'pgboss',
      DURABLE_WORK_INPROCESS_WORKER: 'true',
      DURABLE_WORK_TICK_MS: '5000',
      DURABLE_WORK_GRACE_MS: '7000',
      DURABLE_WORK_DRAIN_TIMEOUT_MS: '9000',
    })

    expect(startWorker).toHaveBeenCalledWith(
      expect.objectContaining({ tickMs: 5000, reconcilerGraceMs: 7000, drainTimeoutMs: 9000 }),
    )
  })

  it('drains on SIGTERM instead of leaving the process, which the server owns', async () => {
    await run({ DURABLE_WORK_TRANSPORT: 'pgboss', DURABLE_WORK_INPROCESS_WORKER: 'true' })
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    process.emit('SIGTERM')
    await vi.waitFor(() => expect(stop).toHaveBeenCalled())

    expect(exit).not.toHaveBeenCalled()
    exit.mockRestore()
  })
})
