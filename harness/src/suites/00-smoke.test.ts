import { acquire, transportUnderTest } from '../env'
import { metadata } from '@fullstackhouse/open-mercato-durable-work'

// Phase 0: proves the harness can start the infrastructure the selected transport
// needs and can import the package under test. Real scenarios land in phase 1+.
describe(`harness smoke [${transportUnderTest()}]`, () => {
  it('imports the package under test', () => {
    expect(metadata.name).toBe('durable_work')
  })

  it('acquires the infrastructure the transport needs', async () => {
    const env = await acquire()
    try {
      if (env.transport !== 'memory') expect(env.postgresUrl).toMatch(/^postgres(ql)?:\/\//)
      if (env.transport === 'bullmq') expect(env.redisUrl).toMatch(/^redis:\/\//)
    } finally {
      await env.stop()
    }
  })
})
