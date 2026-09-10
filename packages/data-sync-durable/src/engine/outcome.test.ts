// What a finished slice reports back to the mechanism.
//
// The interesting cases are the ones where the slice recorded nothing. That happens when the
// run was already over before the slice began — and "already over" is not one situation. A run
// somebody cancelled is a different fact from a run core finalized behind the adopter's back,
// and reporting either as `drained` would leave a job claiming `completed` beside a run that
// says otherwise.

import { describe, expect, it } from 'vitest'

import { SeamBrokenError } from '../modules/data_sync/lib/version-guard'
import { outcomeOf, type SliceRecorder } from './durable-run'

const recorder = (over: Partial<SliceRecorder> = {}): SliceRecorder =>
  ({
    captured: () => null,
    stopReason: () => null,
    committedBatches: () => 0,
    runService: {} as never,
    progressService: {} as never,
    ...over,
  }) as SliceRecorder

describe('outcomeOf, when the slice recorded no terminal transition', () => {
  it('reports a run that somebody cancelled as cancelled, not drained', () => {
    // An operator cancels through core's route, which writes `cancelled` onto the run. If the
    // job was between slices at that moment, the next delivery starts a slice, core's engine
    // returns early because the run is over, and nothing is captured. Calling that `drained`
    // completes the job — leaving a job that says `completed` next to a run that says
    // `cancelled`, which is exactly the disagreement the mirror exists to prevent.
    expect(outcomeOf(recorder(), 'run-1', 'cancelled')).toBe('cancelled')
  })

  it('reports a cancelled run as cancelled even after committing batches', () => {
    // Committed work does not make it a broken seam: the run's status says plainly who ended it.
    expect(outcomeOf(recorder({ committedBatches: () => 12 }), 'run-1', 'cancelled')).toBe('cancelled')
  })

  it('still drains when the run is simply gone', () => {
    expect(outcomeOf(recorder(), 'run-1', undefined)).toBe('drained')
  })

  it('still drains when it arrived late to a run that was already terminal', () => {
    expect(outcomeOf(recorder(), 'run-1', 'completed')).toBe('drained')
  })

  it('still refuses to guess when core finalized a run this slice was working on', () => {
    // The seam this package rests on has moved: real work was committed and the run reached a
    // terminal state without the decorated `markStatus` seeing it.
    expect(() => outcomeOf(recorder({ committedBatches: () => 3 }), 'run-1', 'failed')).toThrow(SeamBrokenError)
  })

  it('reports the reason the slice stopped, when it stopped deliberately', () => {
    expect(outcomeOf(recorder({ stopReason: () => 'budget' }), 'run-1', 'running')).toBe('budget')
    expect(outcomeOf(recorder({ stopReason: () => 'cancelled' }), 'run-1', 'running')).toBe('cancelled')
  })
})
