import type { AppContainer } from '@open-mercato/shared/lib/di/container'
import { registerDataSyncAdapter } from '@open-mercato/core/modules/data_sync/lib/adapter-registry'

import { exampleSyncAdapter } from './lib/adapter'

// Registered from DI, as `sync_excel` does: the registry is process-wide, and every process
// that builds a container — web, worker, CLI — needs the adapter. The web process answers
// `/api/data_sync/options` with it; the worker runs slices through it.
registerDataSyncAdapter(exampleSyncAdapter)

export function register(_container: AppContainer) {
  registerDataSyncAdapter(exampleSyncAdapter)
}

export default register
