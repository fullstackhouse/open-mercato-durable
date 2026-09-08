// Constants both sides of the soak need.
//
// Their own module because `worker-replica.ts` is a script: importing it to read a constant
// would start a worker in the orchestrator's own process, which is exactly the sort of thing
// a soak is supposed to be free of.

export const SOAK_KIND = 'soak.scripted'
export const SOAK_QUEUE = 'durable-work.soak'

/** Batches per job. Long enough to span slices and to be interrupted mid-flight. */
export const SOAK_BATCHES = 40
