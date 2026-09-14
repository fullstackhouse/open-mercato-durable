// What a core-path delivery says it did.
//
// The durable run route adopts a run itself and core's queue delivery adopts it again, so the
// second adoption finding the job already there is the normal case, not an error. The log must
// say which of the two happened: "Adopted" on a delivery that created nothing sends whoever is
// reading it looking for a second job that does not exist.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('@open-mercato/shared/lib/logger', () => ({
  createLogger: () => ({ child: () => logger }),
}))

import { adoptOnDelivery } from './adopt-on-delivery'

const scope = { tenantId: 't1', organizationId: 'o1', userId: 'u1' }
const run = { id: 'run-1', integrationId: 'example_sync', entityType: 'example.record', direction: 'import', status: 'pending' }

function deliver(created: boolean) {
  const startAndEnqueue = vi.fn().mockResolvedValue({ job: { id: 'job-1' }, created, enqueue: async () => undefined })
  const services: Record<string, unknown> = {
    durableWorkService: { startAndEnqueue },
    dataSyncRunService: { getRun: vi.fn().mockResolvedValue(run) },
  }
  const ctx = { resolve: (name: string) => services[name] }
  const job = { payload: { runId: run.id, batchSize: 100, scope } }
  return { startAndEnqueue, done: adoptOnDelivery('import')(job as never, ctx as never) }
}

describe('adopt on delivery', () => {
  beforeEach(() => {
    logger.info.mockReset()
    logger.warn.mockReset()
  })

  it('says it adopted the run when it created the durable job', async () => {
    const { done } = deliver(true)
    await done
    expect(logger.info).toHaveBeenCalledWith('Adopted a core-path sync run as durable work', { runId: 'run-1', direction: 'import' })
  })

  it('says the run was already adopted, and succeeds, when the job existed', async () => {
    const { done, startAndEnqueue } = deliver(false)
    await expect(done).resolves.toBeUndefined()
    expect(startAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'data_sync.run:run-1', lockKey: 'data_sync:example_sync:example.record:import' }),
      { tenantId: 't1', organizationId: 'o1' },
    )
    expect(logger.info).toHaveBeenCalledWith('Sync run already adopted as durable work', { runId: 'run-1', direction: 'import' })
    expect(logger.info).not.toHaveBeenCalledWith('Adopted a core-path sync run as durable work', expect.anything())
  })
})
