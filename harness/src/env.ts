// Harness environment: which transport is under test and where Postgres/Redis live.
//
// DURABLE_TRANSPORT   memory | bullmq | pgboss   (default memory)
// HARNESS_PG_URL      use an existing Postgres instead of a testcontainer
// HARNESS_REDIS_URL   use an existing Redis instead of a testcontainer (bullmq only)
//
// Container lifecycle is owned by the suite's beforeAll/afterAll via `acquire()` so a
// suite that never needs Redis never starts it.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

export type TransportName = 'memory' | 'bullmq' | 'pgboss'

export function transportUnderTest(): TransportName {
  const raw = (process.env.DURABLE_TRANSPORT ?? 'memory').trim().toLowerCase()
  if (raw === 'memory' || raw === 'bullmq' || raw === 'pgboss') return raw
  throw new Error(`DURABLE_TRANSPORT must be memory | bullmq | pgboss, got "${raw}"`)
}

export type HarnessEnv = {
  transport: TransportName
  postgresUrl: string | null
  redisUrl: string | null
  stop(): Promise<void>
}

export async function acquire(opts: { postgres?: boolean; redis?: boolean } = {}): Promise<HarnessEnv> {
  const transport = transportUnderTest()
  const needPg = opts.postgres ?? transport !== 'memory'
  const needRedis = opts.redis ?? transport === 'bullmq'
  const started: Array<StartedPostgreSqlContainer | StartedRedisContainer> = []

  let postgresUrl = process.env.HARNESS_PG_URL?.trim() || null
  if (needPg && !postgresUrl) {
    const pg = await new PostgreSqlContainer('postgres:17-alpine').start()
    started.push(pg)
    postgresUrl = pg.getConnectionUri()
  }

  let redisUrl = process.env.HARNESS_REDIS_URL?.trim() || null
  if (needRedis && !redisUrl) {
    const redis = await new RedisContainer('redis:7-alpine').start()
    started.push(redis)
    redisUrl = redis.getConnectionUrl()
  }

  return {
    transport,
    postgresUrl: needPg ? postgresUrl : null,
    redisUrl: needRedis ? redisUrl : null,
    async stop() {
      await Promise.all(started.map((c) => c.stop()))
    },
  }
}
