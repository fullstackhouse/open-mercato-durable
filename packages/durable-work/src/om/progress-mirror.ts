// One-way mirror onto core's `progress_jobs`, so the existing progress UI keeps working.
//
// The direction matters and is the whole design (ADR 0002): the durable job row is the
// authority for liveness, and `progress_jobs` is presentation. Nothing here is ever read back
// to make a decision. A progress row can lag, or be briefly wrong, without any consequence
// beyond what a user sees for a moment.

import type { DurableJob, Scope } from '../core/types'

/** The subset of core's ProgressService this bridge uses. Structural rather than imported so
 *  the package does not take a hard dependency on a service it only writes to. */
export type ProgressServiceLike = {
  startJob?(id: string, ctx: unknown): Promise<unknown>
  updateProgress?(id: string, patch: Record<string, unknown>, ctx: unknown): Promise<unknown>
  touchJobHeartbeat?(id: string, ctx: unknown): Promise<unknown>
  completeJob?(id: string, input: Record<string, unknown>, ctx: unknown): Promise<unknown>
  failJob?(id: string, input: Record<string, unknown>, ctx: unknown): Promise<unknown>
  markCancelled?(id: string, ctx: unknown): Promise<unknown>
}

export type ProgressMirror = {
  onStarted(job: DurableJob, scope: Scope): Promise<void>
  onProgress(job: DurableJob, scope: Scope): Promise<void>
  onTerminal(job: DurableJob, scope: Scope): Promise<void>
}

/**
 * Every call is best-effort.
 *
 * A mirror that could fail a job would make the presentation layer able to stop the work,
 * which is exactly backwards. The cost of swallowing is a stale progress card; the cost of
 * not swallowing is a sync run failed by a UI table.
 */
export function createProgressMirror(progress: ProgressServiceLike): ProgressMirror {
  const quietly = async (fn: () => Promise<unknown> | undefined) => {
    try {
      await fn()
    } catch {
      /* presentation only — never allowed to affect the job */
    }
  }

  return {
    async onStarted(job, scope) {
      if (!job.progressJobId) return
      await quietly(() => progress.startJob?.(job.progressJobId!, scope))
    },
    async onProgress(job, scope) {
      if (!job.progressJobId) return
      await quietly(() =>
        progress.updateProgress?.(
          job.progressJobId!,
          {
            processedCount: job.processedCount,
            totalCount: job.totalCount ?? undefined,
            // Says why a healthy job looks idle. Core's read path fails a progress row whose
            // heartbeat is older than a minute, and a durable job waiting out a retry backoff
            // legitimately trips that; without this the UI's only story is "it broke".
            message: job.nextRunAt && job.nextRunAt.getTime() > Date.now() ? 'waiting for redelivery' : undefined,
          },
          scope,
        ),
      )
    },
    async onTerminal(job, scope) {
      if (!job.progressJobId) return
      if (job.status === 'completed') {
        await quietly(() => progress.completeJob?.(job.progressJobId!, { processedCount: job.processedCount }, scope))
        return
      }
      if (job.status === 'cancelled') {
        await quietly(() => progress.markCancelled?.(job.progressJobId!, scope))
        return
      }
      await quietly(() =>
        progress.failJob?.(job.progressJobId!, { errorMessage: job.errorMessage ?? job.errorCode ?? 'failed' }, scope),
      )
    },
  }
}
