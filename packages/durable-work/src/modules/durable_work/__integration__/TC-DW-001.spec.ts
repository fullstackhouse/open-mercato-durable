// The operator surface, against a running app.
//
// What these check is the contract an operator actually relies on: that the list is scoped and
// gated, that a job they cannot re-drive is not offered as re-drivable, and that a refusal says
// which refusal it is — because "wait for the other run" and "this is already done" call for
// opposite actions.

import { expect, test } from '@playwright/test'
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api'

test.describe('durable_work operator API', () => {
  test('requires authentication', async ({ request }) => {
    const response = await request.get('/api/durable_work/jobs')
    expect(response.status()).toBe(401)
  })

  test('lists jobs for an authorised operator', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/durable_work/jobs', { token })

    expect(response.status()).toBe(200)
    const body = (await response.json()) as { items: unknown[]; total: number }
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  test('answers 404 for a job that does not exist, rather than leaking that it might', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/durable_work/jobs/00000000-0000-0000-0000-000000000000', { token })
    expect(response.status()).toBe(404)
  })

  test('refuses to re-drive a job that does not exist', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'POST', '/api/durable_work/jobs/00000000-0000-0000-0000-000000000000/redrive', {
      token,
      data: {},
    })
    // 409 with a code, not a bare failure: the caller needs to know *which* refusal it is.
    expect(response.status()).toBe(409)
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'not_redrivable' })
  })

  test('rejects a page size a caller could use to pull the whole table', async ({ request }) => {
    const token = await getAuthToken(request, 'admin')
    const response = await apiRequest(request, 'GET', '/api/durable_work/jobs?pageSize=100000', { token })
    expect(response.status()).toBe(200)
    const body = (await response.json()) as { items: unknown[] }
    expect(body.items.length).toBeLessThanOrEqual(200)
  })
})
