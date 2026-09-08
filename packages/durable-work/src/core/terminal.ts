// The one code path by which a job reaches `completed`, `failed` or `cancelled`.
//
// Everything terminal goes through here so there is a single place where "the job row and the
// domain row move together, or neither moves" is true. The job row is what every surface reads
// — the UI, the cancel route, the reconciler — so a domain row that went terminal while the
// job row still said `running` would be repaired by the reconciler as an orphan and re-driven,
// which is worse than the inconsistency it came from.

import { bumpMirrorAttempts, cancelCas, completeCas, failTerminalCas, markMirrored } from './store'
import type { ResolvedKind } from './registry'
import type { DurableJob, ErrorClass, Lease, Scope, SqlExecutor, SqlTransactor } from './types'

/** The domain mirror ran but matched no row: the domain record is gone, or another path
 *  already moved it. Treated exactly like a throw — "mirrored" means the domain row agrees,
 *  not that the callback was called. */
export class DomainMirrorMismatchError extends Error {
  constructor(readonly jobId: string) {
    super(`Domain mirror matched no rows for job ${jobId}`)
    this.name = 'DomainMirrorMismatchError'
  }
}

export type Transition =
  | { type: 'complete'; patch?: { processedCount?: number; totalCount?: number | null } }
  | { type: 'fail'; code: string; class: ErrorClass; message: string | null }
  | { type: 'cancel' }

export type TerminalResult = { job: DurableJob; mirrored: boolean }

/**
 * Runs the terminal CAS and the kind's domain mirror in one transaction.
 *
 * Three distinguishable outcomes, and keeping them distinguishable is the point:
 *   - `null`      the CAS matched no rows. The lease was lost or taken; this delivery has no
 *                 say any more and should end quietly.
 *   - a result    committed.
 *   - a throw     the CAS matched but the mirror failed, so everything rolled back. The caller
 *                 decides whether that costs a retry (it does on the ordinary completion path,
 *                 and deliberately does not on the cancellation path).
 *
 * An earlier draft returned `null` for both the refused fence and the rolled-back mirror. The
 * caller then could not tell "someone else owns this" from "try again", which are opposite
 * instructions.
 */
export async function runTerminalTransition(
  sql: SqlTransactor,
  kind: ResolvedKind,
  lease: Lease,
  scope: Scope,
  transition: Transition,
): Promise<TerminalResult | null> {
  let casMatched = false
  try {
    const result = await sql.transaction(async (tx) => {
      const job = await applyCas(tx, lease, transition)
      if (!job) return null
      casMatched = true

      if (transition.type === 'cancel' && kind.onCancel) await kind.onCancel(job, scope, tx)

      if (kind.onTransition) {
        const { matched } = await kind.onTransition(job, scope, tx)
        if (matched < 1) throw new DomainMirrorMismatchError(job.id)
      }

      // Recorded inside the same transaction as the mirror it describes: a job that says its
      // domain row agrees, when the write that made it agree rolled back, is the exact lie
      // this protocol exists to prevent.
      await markMirrored(tx, job.id)
      return { job, mirrored: true }
    })
    return result
  } catch (error) {
    // Outside the rolled-back transaction on purpose — a counter written inside it would roll
    // back with it, and the job would retry its mirror forever with nothing to show for it.
    if (casMatched) await bumpMirrorAttempts(sql, lease.jobId).catch(() => undefined)
    throw error
  }
}

async function applyCas(tx: SqlExecutor, lease: Lease, transition: Transition): Promise<DurableJob | null> {
  switch (transition.type) {
    case 'complete':
      return completeCas(tx, lease, transition.patch)
    case 'fail':
      return failTerminalCas(tx, lease, { code: transition.code, class: transition.class, message: transition.message })
    case 'cancel':
      return cancelCas(tx, lease)
  }
}

/** Runs the kind's after-commit hook. Best-effort and at-most-once by design: it has already
 *  been decided that the job is terminal, and a hook that throws must not undo that or be
 *  retried into a duplicate side effect. */
export async function runAfterTransition(
  kind: ResolvedKind,
  job: DurableJob,
  scope: Scope,
  onError?: (error: unknown) => void,
): Promise<void> {
  if (!kind.onAfterTransition) return
  try {
    await kind.onAfterTransition(job, scope)
  } catch (error) {
    onError?.(error)
  }
}
