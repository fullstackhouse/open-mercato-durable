// Core's DI, plus the two job kinds a run becomes.
//
// Core's registrations are reused as they are — the engine, the run service, the mapping and
// schedule services are all core's, unchanged. The decoration that makes a run durable happens
// per slice, inside the kind, not here (see docs/adr/0004): a container-level decoration would
// apply to every caller of the engine, including ones not running under a lease.

import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { register as registerCore } from '@open-mercato/core/modules/data_sync/di'
import { createSyncEngine } from '@open-mercato/core/modules/data_sync/lib/sync-engine'
import { getDataSyncAdapter, resolveProviderKey } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'
import { emitDataSyncEvent } from '@open-mercato/core/modules/data_sync/events'
import { registry } from '@fullstackhouse/open-mercato-durable-work'

import { dataSyncKinds } from '../../kinds/data-sync-run'

/**
 * Built once, at module scope, not once per container.
 *
 * `register` runs on every container build — which in a web process means every request — and
 * the registry refuses two different handlers under one kind id, because silently accepting
 * the second would make "which code is running this job?" depend on request ordering. Kinds
 * created per call would be a different handler every time, so the second request would throw.
 *
 * Each slice resolves its own container instead, which it needs anyway: slices run in the
 * worker process, outside any request, and each needs its own EntityManager rather than one
 * captured from whichever request happened to build the registry first.
 */
const KINDS = dataSyncKinds({
  resolve: async () => {
    const { createRequestContainer } = await import('@open-mercato/shared/lib/di/container')
    const container = await createRequestContainer()
    const em = container.resolve<EntityManager>('em')
    const progressService = container.resolve('progressService')
    const integrationLogService = container.resolve('integrationLogService')
    const integrationStateService = container.resolve('integrationStateService')
    return {
      runService: container.resolve('dataSyncRunService'),
      progressService,
      // Resolved from core's own registry and core's own event bus, so the replayed tail is
      // core's behaviour rather than a second opinion about what it should have been.
      finalize: {
        progressService,
        integrationLogService,
        integrationStateService,
        operationalTelemetry: (integrationId: string) =>
          getDataSyncAdapter(resolveProviderKey(integrationId))?.operationalTelemetry === true,
        emitEvent: (name, payload) => emitDataSyncEvent(name as never, payload as never),
      },
      engine: ({ runService, progressService }) =>
        createSyncEngine({
          em,
          syncRunService: runService as never,
          integrationCredentialsService: container.resolve('integrationCredentialsService'),
          integrationLogService,
          integrationStateService,
          progressService: progressService as never,
        }),
    }
  },
})

export function register(container: AppContainer) {
  registerCore(container)
  // Idempotent: the same handler objects every time, so re-registering is a no-op. The web
  // process needs them to re-drive and cancel, the worker to run slices, and the reconciler to
  // know whether a job has a handler at all.
  for (const kind of KINDS) registry.register(kind)
}

export default register
