// Public API of @fullstackhouse/open-mercato-durable-work.
//
// The OM module itself lives at ./modules/durable_work and is loaded by the host through
// `{ id: 'durable_work', from: '@fullstackhouse/open-mercato-durable-work' }`. Everything
// exported here is usable without Open Mercato: `core/` speaks to Postgres through
// `SqlExecutor` and to a broker through `TransportAdapter`, which is what lets the failure
// harness run the real mechanism with no app around it.

export { metadata } from './modules/durable_work/index'
export { features } from './modules/durable_work/acl'

export type {
  Delivery,
  DurableJob,
  DurableJobStatus,
  ErrorClass,
  Lease,
  LeaseSettings,
  BudgetSettings,
  RetrySettings,
  OrphanPolicy,
  ParkReason,
  Scope,
  SliceOutcome,
  SliceVerdict,
  SqlExecutor,
  SqlTransactor,
  StartJobInput,
} from './core/types'

export {
  TransientError,
  TerminalError,
  UnrecoverableError,
  LeaseLostError,
  LockKeyHeldError,
  NoFurtherAttempts,
  UnknownKindError,
  classifyError,
} from './core/errors'

export {
  DEFAULT_BUDGET,
  DEFAULT_LEASE,
  DEFAULT_RETRY,
  KindRegistry,
  nextAttemptDelayMs,
  registry,
  resolveKind,
} from './core/registry'
export type { KindDefinition, ResolvedKind, SliceContext } from './core/registry'

export {
  CREATE_INDEXES,
  CREATE_TABLE,
  DROP_INDEXES,
  DROP_TABLE,
  NO_ORG,
  SCHEMA_STATEMENTS,
  TABLE,
} from './core/schema'

export * as store from './core/store'
export { runSlice } from './core/run-slice'
export type { RunSliceDeps, RunSliceResult } from './core/run-slice'
export { DomainMirrorMismatchError, runAfterTransition, runTerminalTransition } from './core/terminal'
export type { TerminalResult, Transition } from './core/terminal'
export { reconcileOnce } from './core/reconciler'
export type { ReconcileReport, ReconcilerDeps } from './core/reconciler'
export { RECONCILE_QUEUE, RECONCILE_TICK_ID, enqueueJob, startWorker } from './core/worker'
export type { DurableWorker, WorkerOptions } from './core/worker'
export { deliveryId, makeOwnerId, parseDeliveryId, queueNameFor, sliceIdempotencyKey } from './core/ids'

export type {
  BindOptions,
  BoundWorker,
  DeliveryHandler,
  DeliveryState,
  EnqueueOptions,
  HandlerContext,
  TransportAdapter,
  TransportName,
} from './transport/types'
export { MemoryTransport } from './transport/memory'
export type { MemoryFaults } from './transport/memory'
