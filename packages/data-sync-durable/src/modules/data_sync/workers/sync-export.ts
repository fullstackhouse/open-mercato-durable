import type { WorkerMeta } from '@open-mercato/queue'
import {
  DATA_SYNC_EXPORT_QUEUE,
  DATA_SYNC_LOCK_DURATION_MS,
  DATA_SYNC_MAX_STALLED_COUNT,
} from '@open-mercato/core/modules/data_sync/lib/queue-policy'

import { adoptOnDelivery } from '../lib/adopt-on-delivery'

// Registered under core's worker id, on core's queue, so a message enqueued by anything still
// using core's start path arrives here instead of at core's worker.
export const metadata: WorkerMeta = {
  queue: DATA_SYNC_EXPORT_QUEUE,
  id: 'data-sync:export',
  concurrency: 5,
  lockDuration: DATA_SYNC_LOCK_DURATION_MS,
  maxStalledCount: DATA_SYNC_MAX_STALLED_COUNT,
}

export default adoptOnDelivery('export')
