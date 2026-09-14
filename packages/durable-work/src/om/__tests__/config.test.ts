import { describe, expect, it } from 'vitest'

import { createTransport, readConfig } from '../config'

describe('the pg-boss connection cap', () => {
  it('defaults well below pg-boss own default, because this pool is per process', () => {
    // The mechanism's SQL rides the host's EntityManager; pg-boss does not, so it opens a pool
    // besides the app's — in the web process too, once the worker runs in-process. Multiplied by
    // replicas during a rolling deploy, the library default is enough to eat a `max_connections`
    // budget that was sized without it.
    expect(readConfig({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv).pgBossMaxConnections).toBe(4)
  })

  it('is tunable for a host that has the headroom', () => {
    const config = readConfig({ DATABASE_URL: 'postgres://x/y', DURABLE_WORK_PGBOSS_MAX: '12' } as NodeJS.ProcessEnv)
    expect(config.pgBossMaxConnections).toBe(12)
  })
})

describe('createTransport — the connection BullMQ actually receives', () => {
  // This is the path every host takes: `di.ts` calls `createTransport(readConfig())` with no
  // deps, so `redisConnection` is undefined and the URL is all there is. The harness has always
  // constructed BullMQTransport itself, with an `ioredis` instance — so the shape produced here
  // was never exercised by a test, and it does not work.
  //
  // What it cost: on a real deployment `upsertTick` never returned. Not an error — it hung. The
  // worker therefore never started, sync runs sat `pending` with no lease, and the pod reported
  // healthy throughout. Measured in that environment, same Redis and same BullMQ version:
  // an ioredis instance completes the call, a bare URL string does not.
  it('hands BullMQ a connection object, never a bare URL string', async () => {
    const transport = createTransport(
      readConfig({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://user:pass@example.invalid:6379' } as NodeJS.ProcessEnv),
    )

    // Reaching into the adapter on purpose. The alternative is asserting against a live broker,
    // and the whole failure is that a wrong shape looks fine until it is talking to one.
    const connection = (transport as unknown as { options: { connection: unknown } }).options.connection
    expect(typeof connection).not.toBe('string')
    expect(connection).toBeTruthy()
  })

  it('still prefers a connection the host supplies', async () => {
    const supplied = { marker: 'host-connection' }
    const transport = createTransport(
      readConfig({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://example.invalid:6379' } as NodeJS.ProcessEnv),
      { redisConnection: supplied },
    )

    const connection = (transport as unknown as { options: { connection: unknown } }).options.connection
    expect(connection).toBe(supplied)
  })

  it('still refuses bullmq with no Redis at all', () => {
    expect(() => createTransport(readConfig({ DURABLE_WORK_TRANSPORT: 'bullmq' } as NodeJS.ProcessEnv))).toThrow(/requires DURABLE_WORK_REDIS_URL/)
  })
})

describe('redisOptionsFromUrl, through createTransport', () => {
  const connectionOf = (env: Record<string, string>) =>
    (createTransport(readConfig(env as NodeJS.ProcessEnv)) as unknown as { options: { connection: Record<string, unknown> } })
      .options.connection

  it('carries host, port, credentials and database across', () => {
    expect(connectionOf({
      DURABLE_WORK_TRANSPORT: 'bullmq',
      QUEUE_REDIS_URL: 'redis://someone:s3cr3t@redis.internal:6380/3',
    })).toMatchObject({ host: 'redis.internal', port: 6380, username: 'someone', password: 's3cr3t', db: 3 })
  })

  it('url-decodes a password, because one with a @ or / in it is otherwise silently wrong', () => {
    expect(connectionOf({
      DURABLE_WORK_TRANSPORT: 'bullmq',
      QUEUE_REDIS_URL: 'redis://:p%40ss%2Fword@redis.internal:6379',
    })).toMatchObject({ password: 'p@ss/word' })
  })

  it('defaults the port and leaves the database unset when the url omits them', () => {
    expect(connectionOf({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://redis.internal' }))
      .toMatchObject({ port: 6379, db: undefined })
  })

  it('turns tls on for rediss:// and leaves it off otherwise', () => {
    expect(connectionOf({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'rediss://redis.internal:6379' }).tls).toEqual({})
    expect(connectionOf({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://redis.internal:6379' }).tls).toBeUndefined()
  })

  it('sets maxRetriesPerRequest to null, which BullMQ requires of a worker connection', () => {
    expect(connectionOf({ DURABLE_WORK_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://redis.internal:6379' }))
      .toMatchObject({ maxRetriesPerRequest: null })
  })
})
