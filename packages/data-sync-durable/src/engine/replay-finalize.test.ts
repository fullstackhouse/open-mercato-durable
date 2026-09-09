// What core's `finalizeRun` does after the status write, and what we do instead.
//
// These exist because the gap they close was invisible for a whole release: core's engine skips
// its own tail on every durable run — deliberately, that is the seam this package rests on — and
// nothing noticed that the three side effects it skipped were never replayed. The e2e specs
// asserted that a run *becomes* a durable job; none drove one to terminal, so the progress job
// left dangling and the undelivered `data_sync.run.completed` webhook showed up nowhere.

import { describe, expect, it, vi } from 'vitest'

import { replayFinalize, type FinalizeDeps, type FinalizedRun } from './durable-run'

const run: FinalizedRun = {
  id: 'run-1',
  integrationId: 'example_sync',
  entityType: 'example.record',
  direction: 'import',
  progressJobId: 'pj-1',
  createdCount: 3,
  updatedCount: 2,
  skippedCount: 1,
  failedCount: 0,
  batchesCompleted: 4,
}

const scope = { tenantId: 't1', organizationId: 'o1' }

function deps(overrides: Partial<FinalizeDeps> = {}) {
  const progressService = {
    completeJob: vi.fn().mockResolvedValue(undefined),
    failJob: vi.fn().mockResolvedValue(undefined),
    markCancelled: vi.fn().mockResolvedValue(undefined),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
  }
  const integrationLogService = { write: vi.fn().mockResolvedValue(undefined) }
  const integrationStateService = { upsert: vi.fn().mockResolvedValue(undefined) }
  const emitEvent = vi.fn().mockResolvedValue(undefined)
  const value: FinalizeDeps = {
    progressService: progressService as never,
    integrationLogService,
    integrationStateService,
    operationalTelemetry: () => true,
    emitEvent,
    ...overrides,
  }
  return { deps: value, progressService, integrationLogService, integrationStateService, emitEvent }
}

describe('replayFinalize', () => {
  it('resolves the progress job, records health and emits the lifecycle event on completion', async () => {
    const d = deps()
    await replayFinalize(d.deps, run, 'completed', null, scope, 'user-1')

    // The progress job is what an operator watches in the top bar. Left pending, a finished
    // backfill reads as still running forever.
    expect(d.progressService.completeJob).toHaveBeenCalledWith(
      'pj-1',
      { resultSummary: { createdCount: 3, updatedCount: 2, skippedCount: 1, failedCount: 0, batchesCompleted: 4 } },
      { tenantId: 't1', organizationId: 'o1', userId: 'user-1' },
    )
    expect(d.integrationStateService.upsert).toHaveBeenCalledWith(
      'example_sync',
      expect.objectContaining({ lastHealthStatus: 'healthy' }),
      scope,
    )
    // Dispatched to tenant webhooks, so its absence is visible outside the app entirely.
    expect(d.emitEvent).toHaveBeenCalledWith('data_sync.run.completed', expect.objectContaining({ runId: 'run-1' }))
  })

  it('fails the progress job and reports the error on failure', async () => {
    const d = deps()
    await replayFinalize(d.deps, run, 'failed', 'batch 39: timeout', scope, null)

    expect(d.progressService.failJob).toHaveBeenCalledWith(
      'pj-1',
      { errorMessage: 'batch 39: timeout' },
      expect.objectContaining({ userId: undefined }),
    )
    expect(d.integrationStateService.upsert).toHaveBeenCalledWith(
      'example_sync',
      expect.objectContaining({ lastHealthStatus: 'unhealthy' }),
      scope,
    )
    expect(d.integrationLogService.write).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', message: 'batch 39: timeout', runId: 'run-1' }),
      scope,
    )
    // Only the failure event carries `error`; a subscriber switching on it would otherwise see
    // every durable failure as an unexplained one.
    expect(d.emitEvent).toHaveBeenCalledWith(
      'data_sync.run.failed',
      expect.objectContaining({ runId: 'run-1', error: 'batch 39: timeout' }),
    )
  })

  it('marks the progress job cancelled and degrades health on cancellation', async () => {
    const d = deps()
    await replayFinalize(d.deps, run, 'cancelled', null, scope, null)

    expect(d.progressService.markCancelled).toHaveBeenCalledWith('pj-1', expect.anything())
    expect(d.integrationStateService.upsert).toHaveBeenCalledWith(
      'example_sync',
      expect.objectContaining({ lastHealthStatus: 'degraded' }),
      scope,
    )
    expect(d.emitEvent).toHaveBeenCalledWith('data_sync.run.cancelled', expect.anything())
  })

  it('honours the adapter opt-out for the operational writes, but never for the event', async () => {
    // `operationalTelemetry` is an adapter's choice about how chatty its log is. It has never
    // been a choice about whether the run's completion is observable, and core gates only the
    // two operational writes on it — so the event must still go out.
    const d = deps({ operationalTelemetry: () => false })
    await replayFinalize(d.deps, run, 'completed', null, scope, null)

    expect(d.integrationLogService.write).not.toHaveBeenCalled()
    expect(d.integrationStateService.upsert).not.toHaveBeenCalled()
    expect(d.progressService.completeJob).toHaveBeenCalled()
    expect(d.emitEvent).toHaveBeenCalledWith('data_sync.run.completed', expect.anything())
  })

  it('does nothing with a progress job when the run never had one', async () => {
    // `createProgressJob: false` is a supported way to start a run, and core guards its whole
    // progress branch on `run.progressJobId`.
    const d = deps()
    await replayFinalize(d.deps, { ...run, progressJobId: null }, 'completed', null, scope, null)

    expect(d.progressService.completeJob).not.toHaveBeenCalled()
    expect(d.emitEvent).toHaveBeenCalled()
  })
})
