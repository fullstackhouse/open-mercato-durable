// The error taxonomy. Anything a step throws that is not one of these is `transient`: an
// unrecognised failure is far more often a blip than a dead end, and the cost of guessing
// wrong is one retry rather than a multi-day run thrown away.

import type { ErrorClass } from './types'

/** Retry this delivery. The default class for anything unrecognised. */
export class TransientError extends Error {
  readonly durableErrorClass: ErrorClass = 'transient'
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'TransientError'
    this.code = options?.code
  }
  readonly code?: string
}

/** Fail the job now, without further transport attempts. Still re-drivable by an operator. */
export class TerminalError extends Error {
  readonly durableErrorClass: ErrorClass = 'terminal'
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'TerminalError'
    this.code = options?.code
  }
  readonly code?: string
}

/** Fail the job now and refuse a plain re-drive: an operator must pass `{ force: true }`.
 *  For failures where running the work again is known to be wrong, not merely useless. */
export class UnrecoverableError extends Error {
  readonly durableErrorClass: ErrorClass = 'unrecoverable'
  constructor(message: string, options?: { cause?: unknown; code?: string }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'UnrecoverableError'
    this.code = options?.code
  }
  readonly code?: string
}

/** Thrown by `fencedWrite` when the lease was lost or taken while the slice was running. The
 *  transaction it guards has already rolled back, so nothing the slice believed it wrote is
 *  in the database. Never retried inside the slice: the job now belongs to someone else. */
export class LeaseLostError extends Error {
  readonly durableErrorClass: ErrorClass = 'transient'
  constructor(readonly lease: { jobId: string; owner: string; epoch: number }) {
    super(`Lease lost for job ${lease.jobId} (owner ${lease.owner}, epoch ${lease.epoch})`)
    this.name = 'LeaseLostError'
  }
}

/** Another live job already holds this `lockKey` in this scope. The single-runner guarantee,
 *  surfaced as a 409 rather than a duplicate run. */
export class LockKeyHeldError extends Error {
  readonly durableErrorClass: ErrorClass = 'terminal'
  constructor(
    readonly lockKey: string,
    readonly heldBy?: string,
  ) {
    super(`Lock key ${JSON.stringify(lockKey)} is held by a live job${heldBy ? ` (${heldBy})` : ''}`)
    this.name = 'LockKeyHeldError'
  }
}

/** Signals the transport to end this delivery without scheduling another attempt. The job's
 *  own state already says what happened; a further attempt would claim a row that refuses it. */
export class NoFurtherAttempts extends Error {
  constructor(readonly reason: string) {
    super(`No further transport attempts: ${reason}`)
    this.name = 'NoFurtherAttempts'
  }
}

/** A registry lookup for a kind no process registered. */
export class UnknownKindError extends Error {
  constructor(readonly kind: string) {
    super(`No handler registered for durable job kind ${JSON.stringify(kind)}`)
    this.name = 'UnknownKindError'
  }
}

const CLASSES: ReadonlySet<string> = new Set<ErrorClass>(['transient', 'terminal', 'unrecoverable'])

/** Reads the class off an error, defaulting to `transient`.
 *
 *  Matches on a `durableErrorClass` property rather than `instanceof`, so an error that
 *  crossed a package boundary — two copies of this package in one install, a re-thrown cause,
 *  a structured-clone — is still classified correctly. Getting this wrong the other way would
 *  silently downgrade an `unrecoverable` to a retry loop. */
export function classifyError(error: unknown): ErrorClass {
  const candidate = (error as { durableErrorClass?: unknown } | null | undefined)?.durableErrorClass
  return typeof candidate === 'string' && CLASSES.has(candidate) ? (candidate as ErrorClass) : 'transient'
}

/** The `error_code` to persist, if the error carries one. */
export function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : null
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}
