// Delivery identity and queue naming.

import type { Delivery } from './types'

/** The id a transport carries for one delivery of one job.
 *
 *  Colon-free on purpose: BullMQ 6 rejects `:` in a job id (it is the separator in its own
 *  Redis keys), and the id has to be usable unchanged as a pg-boss `singletonKey` too.
 *
 *  It encodes `(jobId, seq, redrives)` because that triple IS the fence: a delivery whose seq
 *  or redrives no longer match the row is a straggler from a previous slice or re-drive, and
 *  `claim` refuses it. Making the id carry the triple means a duplicate delivery is refused by
 *  the database rather than deduplicated by the broker, which is the only version of that
 *  guarantee that survives a broker restart. */
export function deliveryId(delivery: Delivery): string {
  return `dw-${delivery.jobId}-${delivery.seq}-${delivery.redrives}`
}

const DELIVERY_ID = /^dw-(.+)-(\d+)-(\d+)$/

export function parseDeliveryId(id: string): Delivery | null {
  const match = DELIVERY_ID.exec(id)
  if (!match) return null
  return { jobId: match[1]!, seq: Number(match[2]), redrives: Number(match[3]) }
}

/** Queues are named per kind group so one worker process can bind a subset of kinds. */
export function queueNameFor(group: string): string {
  return `durable-work:${group}`
}

/** The idempotency key handed to a slice, and the one it should forward to any external
 *  side effect. Stable across retries of the same slice, different for the next slice. */
export function sliceIdempotencyKey(jobId: string, seq: number): string {
  return `${jobId}:${seq}`
}

/** Identifies one worker process for the lifetime of that process.
 *
 *  The random suffix is what makes "is this lease mine?" answerable after a crash: a restarted
 *  process on the same host must not match the lease its predecessor held, or a stalled
 *  redelivery to the new process would be accepted while the old row still looks alive. */
export function makeOwnerId(prefix = 'dw'): string {
  const random = Math.random().toString(36).slice(2, 10)
  const pid = typeof process !== 'undefined' && process.pid ? process.pid : 0
  return `${prefix}-${pid}-${Date.now().toString(36)}-${random}`
}
