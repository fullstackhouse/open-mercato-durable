// One suite, three adapters.
//
// Shipped from the package rather than written in the harness so that anyone adding a fourth
// adapter runs exactly the checks the existing three pass. A scenario that passes on one
// transport and not another is a bug, not a caveat — and the only way to keep that true is for
// there to be a single definition of what passing means.
//
// Framework-agnostic: the caller supplies `it` and `expect`, so the same suite runs under
// vitest here and under whatever a downstream host uses.

import type { Delivery, RetrySettings } from '../core/types'
import type { TransportAdapter } from './types'

export type ConformanceHooks = {
  it: (name: string, fn: () => Promise<void>, timeoutMs?: number) => void
  expect: (actual: unknown) => {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    toBeLessThan(expected: number): void
  }
  /** A fresh adapter and a queue name nothing else uses. */
  make: () => Promise<{ transport: TransportAdapter; queue: string; close: () => Promise<void> }>
}

const RETRY: RetrySettings = { attempts: 3, backoff: { type: 'fixed', delayMs: 200, maxDelayMs: 200 } }
const ONCE: RetrySettings = { attempts: 1, backoff: { type: 'fixed', delayMs: 0, maxDelayMs: 0 } }

const delivery = (jobId: string, seq = 0, redrives = 0): Delivery => ({ jobId, seq, redrives })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits for a condition rather than for a duration, so a slow CI runner makes the suite
 *  slower rather than flaky. */
async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(25)
  }
  throw new Error('condition was never met')
}

export function transportConformance(hooks: ConformanceHooks): void {
  const { it, expect, make } = hooks

  it('delivers an enqueued job to a bound handler', async () => {
    const { transport, queue, close } = await make()
    try {
      const seen: Delivery[] = []
      await transport.bind(queue, async (d) => void seen.push(d), { concurrency: 1, activeTimeoutMs: 30_000 })
      await transport.enqueue(queue, delivery('job-1'), { retry: ONCE })
      await until(() => seen.length === 1)
      expect(seen[0]).toEqual(delivery('job-1'))
    } finally {
      await close()
    }
  }, 60_000)

  it('honours a delay before making the delivery available', async () => {
    const { transport, queue, close } = await make()
    try {
      let firstSeenAt = 0
      const start = Date.now()
      await transport.bind(queue, async () => void (firstSeenAt = Date.now()), { concurrency: 1, activeTimeoutMs: 30_000 })
      await transport.enqueue(queue, delivery('job-delay'), { retry: ONCE, delayMs: 1_500 })
      await until(() => firstSeenAt > 0)
      expect(firstSeenAt - start).toBeGreaterThanOrEqual(1_000)
    } finally {
      await close()
    }
  }, 60_000)

  it('retries a handler that throws, up to the attempt limit', async () => {
    const { transport, queue, close } = await make()
    try {
      let attempts = 0
      await transport.bind(
        queue,
        async () => {
          attempts += 1
          throw new Error('nope')
        },
        { concurrency: 1, activeTimeoutMs: 30_000 },
      )
      await transport.enqueue(queue, delivery('job-retry'), { retry: RETRY })
      await until(() => attempts >= 2, 20_000)
      expect(attempts).toBeGreaterThanOrEqual(2)
    } finally {
      await close()
    }
  }, 60_000)

  it('stops retrying when the handler signals there is nothing left to attempt', async () => {
    const { transport, queue, close } = await make()
    try {
      let attempts = 0
      await transport.bind(
        queue,
        async () => {
          attempts += 1
          const error = new Error('settled')
          error.name = 'NoFurtherAttempts'
          throw error
        },
        { concurrency: 1, activeTimeoutMs: 30_000 },
      )
      await transport.enqueue(queue, delivery('job-final'), { retry: RETRY })
      await until(() => attempts >= 1)
      await sleep(1_500) // long enough for a retry to have landed if one were coming
      expect(attempts).toBe(1)
    } finally {
      await close()
    }
  }, 60_000)

  it('hands work back as a new delivery without spending an attempt', async () => {
    const { transport, queue, close } = await make()
    try {
      const seen: Delivery[] = []
      const attemptsSeen: number[] = []
      await transport.bind(
        queue,
        async (d, ctx) => {
          seen.push(d)
          attemptsSeen.push(ctx.attempt)
          if (d.seq < 2) await ctx.handBack({ ...d, seq: d.seq + 1 })
        },
        { concurrency: 1, activeTimeoutMs: 30_000 },
      )
      await transport.enqueue(queue, delivery('job-yield'), { retry: RETRY })

      await until(() => seen.length === 3, 20_000)
      expect(seen.map((d) => d.seq)).toEqual([0, 1, 2])
      // The point of a hand-back: three slices, none of them a retry.
      expect(Math.max(...attemptsSeen)).toBe(1)
    } finally {
      await close()
    }
  }, 60_000)

  it('collapses a re-enqueue of the same delivery instead of delivering it twice', async () => {
    const { transport, queue, close } = await make()
    try {
      const seen: Delivery[] = []
      await transport.bind(queue, async (d) => void seen.push(d), { concurrency: 1, activeTimeoutMs: 30_000 })
      const d = delivery('job-dedupe')
      // Enqueued before binding drains it, so both land while the job is still waiting.
      await Promise.all([
        transport.enqueue(queue, d, { retry: ONCE, delayMs: 800 }),
        transport.enqueue(queue, d, { retry: ONCE, delayMs: 800 }),
      ])
      await until(() => seen.length >= 1)
      await sleep(1_000)
      expect(seen.length).toBe(1)
    } finally {
      await close()
    }
  }, 60_000)

  it('reports a delivery it does not hold as unknown, and removes one it does', async () => {
    const { transport, queue, close } = await make()
    try {
      expect(await transport.getState(queue, 'nothing-here')).toBe('unknown')
      const { transportJobId } = await transport.enqueue(queue, delivery('job-remove'), { retry: ONCE, delayMs: 60_000 })
      await transport.remove(queue, transportJobId)
      expect(await transport.getState(queue, transportJobId)).toBe('unknown')
    } finally {
      await close()
    }
  }, 60_000)

  it('fires a tick repeatedly', async () => {
    const { transport, queue, close } = await make()
    try {
      let ticks = 0
      await transport.bind(queue, async () => void (ticks += 1), { concurrency: 1, activeTimeoutMs: 30_000 })
      await transport.upsertTick({ id: 'conformance-tick', queue, everyMs: 1_000 })
      await until(() => ticks >= 2, 20_000)
      expect(ticks).toBeGreaterThanOrEqual(2)
    } finally {
      await close()
    }
  }, 60_000)

  it('aborts in-flight work on close, and returns within its timeout', async () => {
    const { transport, queue, close } = await make()
    try {
      let aborted = false
      let started = false
      await transport.bind(
        queue,
        async (_d, ctx) => {
          started = true
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) return resolve()
            ctx.signal.addEventListener('abort', () => {
              aborted = true
              resolve()
            })
            // Long enough that only the abort can end it inside the close timeout.
            setTimeout(resolve, 60_000).unref?.()
          })
        },
        { concurrency: 1, activeTimeoutMs: 120_000 },
      )
      await transport.enqueue(queue, delivery('job-drain'), { retry: ONCE })
      await until(() => started)

      const startedAt = Date.now()
      await transport.close({ timeoutMs: 10_000 })
      expect(Date.now() - startedAt).toBeLessThan(15_000)
      expect(aborted).toBe(true)
    } finally {
      await close()
    }
  }, 90_000)
}
