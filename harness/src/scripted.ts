// A job kind whose behaviour a test writes out, and a stand-in for a transport delivery.
//
// The point is to make failures *reachable*. A real adapter fails at times nobody can arrange;
// a scripted kind fails on the batch a test names, so a scenario reads as the sequence of
// events it is actually about rather than as a setup ritual.

import { randomUUID } from 'node:crypto'

import {
  resolveKind,
  type KindDefinition,
  type ResolvedKind,
  type SliceContext,
  type SliceOutcome,
} from '@fullstackhouse/open-mercato-durable-work'
import type { HandlerContext } from '@fullstackhouse/open-mercato-durable-work'

export type ScriptedCheckpoint = { done: number }

export type Script = {
  /** How many batches of work there are in total, across every slice. */
  batches: number
  /** Commit a checkpoint after each batch. Off for kinds that keep no cursor. */
  commit?: boolean
  /** Throw on this batch index (0-based, counted across the whole job). */
  throwAt?: number
  /** What to throw. Defaults to a plain Error, i.e. `transient`. */
  throwWith?: () => unknown
  /** Return `budget` after this many batches in one slice, as if the clock ran out. */
  yieldAfter?: number
  /** Called for every batch, so a test can kill a process at an exact point. */
  onBatch?: (index: number, ctx: SliceContext<unknown, ScriptedCheckpoint>) => Promise<void> | void
  /** Milliseconds to spend per batch. */
  batchMs?: number
}

export type ScriptedKindOptions = Partial<Omit<KindDefinition, 'kind' | 'queue' | 'step'>> & {
  kind?: string
  queue?: string
  script: Script
  /** Records every domain mirror call, and lets a test make one fail. */
  mirror?: {
    onTransition?: (calls: number) => { matched: number } | Promise<{ matched: number }>
    onRedrive?: (calls: number) => { matched: number } | Promise<{ matched: number }>
  }
}

export type ScriptedKind = ResolvedKind<unknown, ScriptedCheckpoint> & {
  /** Batches executed across every slice and every delivery — the number a test asserts on to
   *  prove no batch ran twice. */
  executed: number[]
  transitionCalls: number
  afterTransitionCalls: number
}

export function scriptedKind(options: ScriptedKindOptions): ScriptedKind {
  const script = options.script
  const executed: number[] = []
  const state = { transitionCalls: 0, afterTransitionCalls: 0 }

  const definition: KindDefinition<unknown, ScriptedCheckpoint> = {
    kind: options.kind ?? 'test.scripted',
    queue: options.queue ?? 'durable-work.test',
    lease: options.lease,
    budget: options.budget,
    retry: options.retry,
    orphanPolicy: options.orphanPolicy,
    concurrency: options.concurrency,
    classify: options.classify,

    async step(ctx): Promise<SliceOutcome> {
      let done = ctx.checkpoint?.done ?? 0
      let inThisSlice = 0
      while (done < script.batches) {
        if (ctx.signal.aborted) return 'budget'
        if (script.yieldAfter != null && inThisSlice >= script.yieldAfter) return 'budget'
        if (ctx.shouldYield()) return 'budget'

        await script.onBatch?.(done, ctx)
        if (script.batchMs) await new Promise((r) => setTimeout(r, script.batchMs))
        if (script.throwAt === done) throw (script.throwWith ?? (() => new Error(`scripted failure at batch ${done}`)))()

        executed.push(done)
        done += 1
        inThisSlice += 1

        if (script.commit) await ctx.checkpoint_({ done }, { processedCount: done, totalCount: script.batches })
        else await ctx.heartbeat({ processedCount: done, totalCount: script.batches })
      }
      return 'drained'
    },

    ...(options.mirror
      ? {
          async onTransition() {
            state.transitionCalls += 1
            return (await options.mirror!.onTransition?.(state.transitionCalls)) ?? { matched: 1 }
          },
          async onRedrive() {
            return (await options.mirror!.onRedrive?.(0)) ?? { matched: 1 }
          },
          async onAfterTransition() {
            state.afterTransitionCalls += 1
          },
        }
      : {}),
  }

  const resolved = resolveKind(definition) as ScriptedKind
  Object.defineProperties(resolved, {
    executed: { get: () => executed },
    transitionCalls: { get: () => state.transitionCalls },
    afterTransitionCalls: { get: () => state.afterTransitionCalls },
  })
  return resolved
}

export type FakeDelivery = {
  ctx: HandlerContext
  handBacks: Array<{ jobId: string; seq: number; redrives: number }>
  abort(): void
}

/** A transport delivery a test drives by hand, so `runSlice` can be exercised without a broker
 *  in the way. The adapters are tested separately, against the same scenarios. */
export function fakeDelivery(opts: { attempt?: number; maxAttempts?: number } = {}): FakeDelivery {
  const controller = new AbortController()
  const handBacks: FakeDelivery['handBacks'] = []
  return {
    handBacks,
    abort: () => controller.abort(),
    ctx: {
      transportJobId: `fake-${randomUUID()}`,
      attempt: opts.attempt ?? 1,
      maxAttempts: opts.maxAttempts ?? 5,
      signal: controller.signal,
      handBack: async (next) => {
        handBacks.push(next)
      },
    },
  }
}
