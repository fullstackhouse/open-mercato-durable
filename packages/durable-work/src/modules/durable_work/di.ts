import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'

import { DurableWorkService } from '../../core/service'
import { registry } from '../../core/registry'
import { createTransport, readConfig } from '../../om/config'
import { mikroExecutor } from '../../om/sql-executor-mikro'
import type { TransportAdapter } from '../../transport/types'

// One transport per process, not per request.
//
// A container is built per request, and a transport owns broker connections and bound workers.
// Building one per request would open a Redis connection per HTTP call — the kind of leak that
// looks like a memory problem for a week before anyone finds it.
let transport: TransportAdapter | null = null
function sharedTransport(): TransportAdapter {
  if (!transport) transport = createTransport(readConfig())
  return transport
}

export function register(container: AppContainer) {
  container.register({
    durableWorkService: {
      resolve: (c) => {
        const em = c.resolve<EntityManager>('em')
        const config = readConfig()
        return new DurableWorkService({
          sql: mikroExecutor(em),
          transport: sharedTransport(),
          registry,
          graceMs: config.reconcilerGraceMs,
        })
      },
    },
    // The raw executor, for the worker command: it drives the mechanism directly rather than
    // through the service, and needs to open its own transactions.
    durableWorkSql: { resolve: (c) => mikroExecutor(c.resolve<EntityManager>('em')) },
    durableWorkRegistry: { resolve: () => registry },
    durableWorkTransport: { resolve: () => sharedTransport() },
  })
}
