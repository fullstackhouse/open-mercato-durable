// How a host configures the mechanism: environment variables in, a transport out.

import { BullMQTransport } from '../transport/bullmq'
import { MemoryTransport } from '../transport/memory'
import { PgBossTransport } from '../transport/pgboss'
import type { TransportAdapter, TransportName } from '../transport/types'

export type DurableWorkConfig = {
  transport: TransportName
  redisUrl: string | null
  databaseUrl: string | null
  pgBossSchema: string
  tickMs: number
  drainTimeoutMs: number
  reconcilerGraceMs: number
  /** Hosts the worker inside the app process. Dev and ephemeral tests only. */
  inProcessWorker: boolean
}

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const bool = (value: string | undefined): boolean => value === '1' || value?.toLowerCase() === 'true'

export function readConfig(env: NodeJS.ProcessEnv = process.env): DurableWorkConfig {
  const raw = (env.DURABLE_WORK_TRANSPORT ?? 'pgboss').trim().toLowerCase()
  if (raw !== 'memory' && raw !== 'bullmq' && raw !== 'pgboss') {
    throw new Error(`DURABLE_WORK_TRANSPORT must be memory | bullmq | pgboss, got ${JSON.stringify(raw)}`)
  }
  return {
    transport: raw,
    // Falls back to the queue module's Redis, because an app that already runs one should not
    // have to configure a second.
    redisUrl: env.DURABLE_WORK_REDIS_URL ?? env.QUEUE_REDIS_URL ?? env.REDIS_URL ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    pgBossSchema: env.DURABLE_WORK_PGBOSS_SCHEMA ?? 'durable_work_boss',
    tickMs: num(env.DURABLE_WORK_TICK_MS, 15_000),
    drainTimeoutMs: num(env.DURABLE_WORK_DRAIN_TIMEOUT_MS, 30_000),
    reconcilerGraceMs: num(env.DURABLE_WORK_GRACE_MS, 20_000),
    inProcessWorker: bool(env.DURABLE_WORK_INPROCESS_WORKER),
  }
}

export function createTransport(config: DurableWorkConfig, deps: { redisConnection?: unknown } = {}): TransportAdapter {
  switch (config.transport) {
    case 'memory':
      // Nothing survives the process, so this is a development convenience and is refused in
      // production rather than quietly losing every job on the next deploy.
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DURABLE_WORK_TRANSPORT=memory keeps jobs in process memory and cannot be used in production.')
      }
      return new MemoryTransport()
    case 'bullmq': {
      const connection = deps.redisConnection ?? config.redisUrl
      if (!connection) throw new Error('DURABLE_WORK_TRANSPORT=bullmq requires DURABLE_WORK_REDIS_URL (or QUEUE_REDIS_URL).')
      return new BullMQTransport({ connection })
    }
    case 'pgboss': {
      if (!config.databaseUrl) throw new Error('DURABLE_WORK_TRANSPORT=pgboss requires DATABASE_URL.')
      return new PgBossTransport({ connectionString: config.databaseUrl, schema: config.pgBossSchema })
    }
  }
}
