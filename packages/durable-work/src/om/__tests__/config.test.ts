import { describe, expect, it } from 'vitest'

import { readConfig } from '../config'

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
