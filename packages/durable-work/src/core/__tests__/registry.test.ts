import { KindRegistry } from '../registry'

import type { SliceOutcome } from '../types'

const kind = (id: string, step: () => Promise<SliceOutcome> = async () => 'drained') => ({ kind: id, queue: 'durable-work.test', step })

describe('KindRegistry', () => {
  it('accepts the same handler registered twice', () => {
    // `register` runs on every container build, which in a web process is every request. A
    // registry that treated re-registration as a conflict would crash the second request.
    const registry = new KindRegistry()
    const definition = kind('test.a')
    registry.register(definition)
    expect(() => registry.register(definition)).not.toThrow()
    expect(registry.list()).toHaveLength(1)
  })

  it('refuses two different handlers under one id', () => {
    // Accepting the second silently would make "which code runs this job?" depend on the order
    // containers happened to be built in.
    const registry = new KindRegistry()
    registry.register(kind('test.b'))
    expect(() => registry.register(kind('test.b', async () => 'budget'))).toThrow(/Duplicate durable job kind/)
  })

  it('refuses a domain mirror with no way back', () => {
    // An operator could otherwise re-drive the job while the domain row stayed terminal.
    const registry = new KindRegistry()
    expect(() => registry.register({ ...kind('test.c'), onTransition: async () => ({ matched: 1 }) })).toThrow(
      /onTransition without onRedrive/,
    )
  })

  it('applies defaults, including parking rather than re-driving an orphan', () => {
    const registry = new KindRegistry()
    registry.register(kind('test.d'))
    const resolved = registry.require('test.d')
    // A job nobody declared idempotent is not re-run automatically just because its worker died.
    expect(resolved.orphanPolicy).toBe('park')
    expect(resolved.lease.ttlMs).toBeGreaterThan(0)
    expect(resolved.budget.maxConsecutiveFailures).toBeGreaterThan(0)
  })
})
