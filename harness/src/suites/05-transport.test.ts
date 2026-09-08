// The transport conformance suite, run against whichever adapter is under test.
//
// The suite itself is shipped from the package, not written here: a scenario that passes on
// one transport and not another is a bug, and the only way to keep that true is for there to
// be exactly one definition of what passing means.

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BullMQTransport,
  MemoryTransport,
  PORTABLE_QUEUE_NAME,
  PgBossTransport,
  queueNameFor,
  transportConformance,
  type TransportAdapter,
} from '@fullstackhouse/open-mercato-durable-work'

import { acquire, transportUnderTest, type HarnessEnv } from '../env'

const transport = transportUnderTest()
let env: HarnessEnv

beforeAll(async () => {
  env = await acquire()
}, 180_000)

afterAll(async () => {
  await env?.stop()
})

async function make(): Promise<{ transport: TransportAdapter; queue: string; close: () => Promise<void> }> {
  // A fresh queue name per test, so one scenario's leftovers can never be another's input.
  const queue = queueNameFor(`conformance-${randomUUID().slice(0, 8)}`)
  // pg-boss rejects a queue name outside this set outright, and BullMQ gives `:` special
  // meaning in its keys. Asserted here so a change to the naming convention fails on the
  // adapter that would reject it, rather than in whichever host deploys it first.
  expect(queue).toMatch(PORTABLE_QUEUE_NAME)

  if (transport === 'memory') {
    const adapter = new MemoryTransport()
    return { transport: adapter, queue, close: () => adapter.close({ timeoutMs: 1_000 }) }
  }

  if (transport === 'bullmq') {
    const { default: IORedis } = await import('ioredis')
    const connection = new IORedis(env.redisUrl!, { maxRetriesPerRequest: null })
    const adapter = new BullMQTransport({ connection, prefix: `{dw-test-${randomUUID().slice(0, 8)}}` })
    return {
      transport: adapter,
      queue,
      close: async () => {
        await adapter.close({ timeoutMs: 5_000 })
        connection.disconnect()
      },
    }
  }

  const adapter = new PgBossTransport({
    connectionString: env.postgresUrl!,
    // A schema per adapter instance keeps one scenario's pg-boss state out of another's.
    schema: `dwtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
  })
  return { transport: adapter, queue, close: () => adapter.close({ timeoutMs: 5_000 }) }
}

describe(`transport conformance [${transport}]`, () => {
  transportConformance({ it, expect: expect as never, make })
})

describe(`transactional enqueue [${transport}]`, () => {
  it('is honoured only by the adapter that can honour it', () => {
    // Not a capability check for its own sake: callers branch on this flag to decide whether a
    // job row and its delivery can commit together, or whether they must accept the gap the
    // reconciler exists to close.
    const expected = transport === 'pgboss'
    const adapter =
      transport === 'memory'
        ? new MemoryTransport()
        : transport === 'pgboss'
          ? new PgBossTransport({ connectionString: 'postgres://unused' })
          : new BullMQTransport({ connection: {} })
    expect(adapter.supportsTransactionalEnqueue).toBe(expected)
  })
})
