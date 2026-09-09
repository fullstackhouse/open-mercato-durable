// The transports describe bullmq and pg-boss structurally instead of importing their types,
// because both are *optional* peers and this package's `exports` map resolves `types` to these
// sources — so a host typechecks a transport it never installed. A real adopter hit exactly
// that: `Cannot find module 'pg-boss'` in an app that runs BullMQ.
//
// The cost is that nothing then checks those hand-written types against the real libraries, and
// they can drift silently. This file is that check, and it lives in a test because tests are
// unreachable from a host's program — nothing imports them, so a host never typechecks this
// file and never needs either library installed.
//
// It asserts the calls the adapters make, not whole-type assignability. Assignability fails on
// overloads and on option types being narrower than ours, neither of which says anything about
// whether the adapter works; a call that stops compiling always does.
//
// There is nothing to run. If this file compiles, the dependencies still support the adapters.

import { describe, expect, it } from 'vitest'

type RealPgBoss = InstanceType<typeof import('pg-boss').PgBoss>
type RealQueue = InstanceType<typeof import('bullmq').Queue>
type RealWorkerCtor = typeof import('bullmq').Worker

/** Every pg-boss call `PgBossTransport` makes. */
async function _pgbossCalls(boss: RealPgBoss, tx: never) {
  await boss.start()
  await boss.createQueue('q', { expireInSeconds: 60 })
  const sent: string | null = await boss.send('q', {} as object, {
    singletonKey: 'k',
    singletonSeconds: 5,
    startAfter: 1,
    retryLimit: 3,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 300,
    db: tx,
  })
  await boss.deleteJob('q', sent ?? 'id')
  const job = await boss.getJobById('q', 'id')
  void (job?.state satisfies string | undefined)
  const workerId = await boss.work('q', { batchSize: 2 }, async (jobs) => {
    const first = jobs[0]
    void (first.id satisfies string)
    void first.data
  })
  await boss.offWork('q', { id: workerId })
  await boss.stop({ graceful: true, close: true, timeout: 30_000 })
}

/** Every bullmq call `BullMQTransport` makes. */
async function _bullmqCalls(queue: RealQueue, Worker: RealWorkerCtor) {
  await queue.add('delivery', {}, {
    jobId: 'id',
    delay: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    removeOnFail: { age: 86_400 },
  })
  await queue.remove('id')
  const job = await queue.getJob('id')
  if (job) {
    void (job.attemptsMade satisfies number)
    void (job.opts.attempts satisfies number | undefined)
    void (job.id satisfies string | undefined)
    await job.updateData({} as never)
    await job.moveToDelayed(Date.now(), 'token')
    void ((await job.getState()) satisfies string)
  }
  await queue.upsertJobScheduler('tick', { every: 1_000 }, { name: 'tick', data: {} })
  await queue.close()
  const worker = new Worker('q', async () => undefined, {
    connection: {} as never,
    prefix: 'p',
    concurrency: 1,
    lockDuration: 60_000,
  })
  worker.on('error', () => undefined)
  await worker.close(true)
}

describe('the optional peers still support the calls the transports make', () => {
  it('compiles, which is the whole assertion', () => {
    expect([_pgbossCalls, _bullmqCalls].every((fn) => typeof fn === 'function')).toBe(true)
  })
})
