import { createModuleEvents } from '@open-mercato/shared/modules/events'

// The lifecycle a host can subscribe to.
//
// Every one is emitted after its transaction commits, and never inside it: a subscriber that
// throws must not be able to roll back the fact the event describes, and a slow subscriber
// must not hold a row lock for the length of its work.
export const events = [
  { id: 'durable_work.job.created', label: 'Job created', entity: 'job', category: 'crud', clientBroadcast: true },
  { id: 'durable_work.job.started', label: 'Job started', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.yielded', label: 'Slice handed back', entity: 'job', category: 'lifecycle', clientBroadcast: false },
  { id: 'durable_work.job.completed', label: 'Job completed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.failed', label: 'Job failed', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.parked', label: 'Job parked for an operator', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.cancelled', label: 'Job cancelled', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.redriven', label: 'Job re-driven', entity: 'job', category: 'lifecycle', clientBroadcast: true },
  { id: 'durable_work.job.lease_lost', label: 'Lease lost', entity: 'job', category: 'lifecycle', clientBroadcast: false },
  { id: 'durable_work.job.mirror_stuck', label: 'Domain mirror stuck', entity: 'job', category: 'lifecycle', clientBroadcast: true },
] as const

export const eventsConfig = createModuleEvents({
  moduleId: 'durable_work',
  events,
})

export const emitDurableWorkEvent = eventsConfig.emit

export type DurableWorkEventId = (typeof events)[number]['id']

export default eventsConfig
