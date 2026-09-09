// The seams this package depends on, asserted against the installed `@open-mercato/core`.
//
// The adopter does not fork core's engine; it decorates three methods and relies on one
// documented branch of `finalizeRun` (ADR 0004). That is a far smaller coupling than a fork —
// but only if it is *checked*, because every one of these could be changed upstream in a way
// that compiles fine and silently stops the durable behaviour:
//
//   - if `markStatus` stopped returning the row unchanged on a refused terminal transition,
//     core would write the terminal state itself and the durable one would arrive second
//   - if the batch loop stopped consulting `isCancellationRequested`, a slice would have no
//     hand-back point and could only be interrupted between whole runs
//   - if `commitBatchProgress` changed shape, cursor commits would stop being fenced
//
// These run in the `compat` CI lane against both the released and the development channel, so
// a core release that moves any of them fails here rather than in a host.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(path.join(__dirname, '..', '..', 'package.json'))

function coreRoot(): string {
  let dir = path.dirname(require.resolve('@open-mercato/core'))
  for (;;) {
    const manifest = path.join(dir, 'package.json')
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === '@open-mercato/core') return dir
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('could not locate @open-mercato/core')
    dir = parent
  }
}

const read = (relative: string): string => fs.readFileSync(path.join(coreRoot(), 'src', 'modules', 'data_sync', relative), 'utf8')

describe('the seams the durable adopter decorates', () => {
  const runService = read('lib/sync-run-service.ts')
  const engine = read('lib/sync-engine.ts')

  it('still exposes the three run-service methods the adopter wraps', () => {
    for (const method of ['getRun', 'markStatus', 'commitBatchProgress']) {
      expect({ method, present: new RegExp(`\\b${method}\\s*\\(`).test(runService) }).toEqual({ method, present: true })
    }
  })

  it('still returns the row unchanged when a terminal transition is refused', () => {
    // This is what lets the adopter record a terminal outcome instead of performing it. Without
    // it, core writes the run's terminal state itself and the durable transition arrives second
    // — two writers, and the domain row no longer moves with the job row.
    expect(runService).toMatch(/isTerminal\s*&&\s*row\.status\s*!==\s*status/)
    expect(runService).toMatch(/if \(isTerminal && row\.status !== status\) \{\s*\n\s*return row/)
  })

  it('still stays silent when the status it wrote is not the status it asked for', () => {
    // `finalizeRun`'s "another worker already finalized this" branch. It is what suppresses the
    // progress write, the operational log and the lifecycle event, so the durable terminal
    // transition can emit them exactly once instead.
    expect(engine).toMatch(/const run = await syncRunService\.markStatus\(runId, status, scope, error\)/)
    expect(engine).toMatch(/if \(run\.status !== status\) \{/)
  })

  it('still ends finalizeRun with exactly the three side effects the adopter replays', () => {
    // The skipped tail. Core stops at its "another worker already finalized this" branch on
    // every durable run, so everything after it is ours to replay — the progress job, the
    // operational writes and the lifecycle event (see `replayFinalize`).
    //
    // Asserted here because the failure mode is silent in both directions: a side effect
    // upstream *adds* to this tail would simply never happen on a durable run, and nothing in
    // a host would report it missing. That is precisely how the first three came to be dropped
    // for a whole release.
    const start = engine.indexOf('async function finalizeRun')
    // Bounded at the next declaration: unbounded, this runs to the end of the file and sweeps
    // up `runImport`/`runExport`, which make the same kinds of call for their own reasons.
    const next = engine.indexOf('\n  return {', start + 1)
    const tail = engine.slice(start, next === -1 ? undefined : next)

    for (const call of ['progressService.completeJob(', 'progressService.failJob(', 'progressService.markCancelled(']) {
      expect({ call, present: tail.includes(call) }).toEqual({ call, present: true })
    }
    expect(tail).toMatch(/emitDataSyncEvent\('data_sync\.run\.completed'/)
    expect(tail).toMatch(/emitDataSyncEvent\('data_sync\.run\.failed'/)
    expect(tail).toMatch(/emitDataSyncEvent\('data_sync\.run\.cancelled'/)

    // The gate on the two operational writes, and deliberately not on the event.
    expect(tail).toMatch(/enabled: operationalTelemetry/)

    // A fourth kind of side effect in the tail means `replayFinalize` is now incomplete. The
    // count is the tripwire: it is meant to be re-read, not bumped.
    const awaited = tail.match(/await (progressService|updateOperationalState|writeOperationalLog|emitDataSyncEvent)\b/g) ?? []
    expect(awaited.length).toBe(12)
  })

  it('still asks whether to cancel at every batch boundary', () => {
    // The hand-back point. Without it a slice has nowhere to stop, and the mechanism's
    // headline property — a deploy does not kill a multi-day run — is gone.
    //
    // Asserted as a property rather than a phrasing, because the phrasing has already moved:
    // `develop` puts a background poller in front of the check
    // (`cancellation.signal.aborted || (run.progressJobId && await isCancellationRequested(…))`).
    // The seam is unaffected — the question is still asked per batch and a true answer still
    // stops the stream — and a probe that failed on the wording would cry wolf on every
    // upstream refactor while missing the change that actually matters.
    const checks = engine.match(/progressService\.isCancellationRequested\(/g) ?? []
    expect(checks.length).toBeGreaterThanOrEqual(2) // import and export

    for (const branch of engine.split('isCancellationRequested(').slice(1)) {
      // Every use either leads to a stop, or feeds the poller that aborts to the same end.
      const leadsToStop = /return 'stop'/.test(branch.slice(0, 400))
      const feedsThePoller = /controller\.abort\(\)/.test(branch.slice(0, 400))
      expect(leadsToStop || feedsThePoller).toBe(true)
    }
  })

  it('still ends the stream cleanly when a batch says stop', () => {
    expect(engine).toMatch(/streamResult === 'stopped'/)
  })

  it('still commits the cursor through the run service, batch by batch', () => {
    expect(engine).toMatch(/syncRunService\.commitBatchProgress\(/)
  })

  it('still consults the cancellation check only for runs that have a progress job', () => {
    // Recorded because it is a real constraint on the adopter rather than an incidental
    // detail: a run created without a progress job has no batch boundary to stop at, so the
    // start path must always create one.
    expect(engine).toMatch(/run\.progressJobId && await progressService\.isCancellationRequested/)
  })
})
