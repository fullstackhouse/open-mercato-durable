// The `data_sync` drop-in, against a running app.
//
// The point of these is that nothing in them is durable-work specific: they exercise core's own
// `data_sync` API and assert core's own behaviour. If this package is doing its job, a host
// cannot tell the difference — except that a run now leaves a durable job behind it.

import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'

type Options = { items: Array<{ integrationId: string; canStartRun?: boolean; isEnabled?: boolean }> }
type StartedRun = { id: string; progressJobId: string }
type Job = {
  id: string
  kind: string
  status: string
  lockKey: string | null
  idempotencyKey: string | null
  subject: { type: string; id: string } | null
  redrivable: boolean
}

const startRun = async (request: Parameters<typeof apiRequest>[0], token: string, parameters: Record<string, unknown>) =>
  apiRequest(request, 'POST', '/api/data_sync/run', {
    token,
    data: { integrationId: 'example_sync', entityType: 'example.record', direction: 'import', parameters },
  })

// Serial: these share one lock key, so a run left live by one test is the reason the next
// would fail. Ordering them is honest — a parallel run of the same integration is exactly what
// the single-runner guarantee forbids.
test.describe.serial('data_sync served from the durable package', () => {
  test('keeps core\'s API surface: the runs list answers as it always did', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/data_sync/runs', { token })
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ items: expect.any(Array) })
  })

  test('keeps core\'s adapter registry: the scripted integration is startable', async ({ request }) => {
    // `example_sync` registers through core's own adapter registry from an `@app` module. That
    // it is visible here is the evidence that swapping the package did not break the registry
    // every other provider shares.
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/data_sync/options', { token })
    expect(response.status()).toBe(200)

    const body = (await response.json()) as Options
    const example = body.items.find((item) => item.integrationId === 'example_sync')
    expect(example, 'example_sync should be registered and enabled').toBeTruthy()
    expect(example?.canStartRun).toBe(true)
  })

  test('a started run becomes a durable job with its lock, idempotency key and subject', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const started = await startRun(request, token, { batches: 3, itemsPerBatch: 1 })
    expect(started.status()).toBe(201)
    // Reported by the route so a failure here says *why* rather than just "no job found".
    expect(started.headers()['x-durable-work'], started.headers()['x-durable-work-reason'] ?? 'no reason reported').toBe('created')
    const run = (await started.json()) as StartedRun
    expect(run.progressJobId, 'a progress job is required: core consults it for the per-batch stop').toBeTruthy()

    const jobs = await apiRequest(request, 'GET', `/api/durable_work/jobs?kind=data_sync.import&pageSize=50`, { token })
    const body = (await jobs.json()) as { items: Job[] }
    const job = body.items.find((item) => item.subject?.id === run.id)

    expect(job, 'the run should have produced a durable job').toBeTruthy()
    expect(job!.lockKey).toBe('data_sync:example_sync:example.record:import')
    expect(job!.idempotencyKey).toBe(`data_sync.run:${run.id}`)
    expect(job!.subject).toEqual({ type: 'data_sync.run', id: run.id })
  })

  test('refuses a second live run for the same integration, entity and direction', async ({ request }) => {
    // The single-runner guarantee. Two imports of one entity would interleave over a single
    // cursor, and the rows one of them skipped would never be noticed.
    const token = await getAuthToken(request, 'admin')
    await startRun(request, token, { batches: 3 })
    const second = await startRun(request, token, { batches: 3 })
    expect(second.status()).toBe(409)
  })
})
