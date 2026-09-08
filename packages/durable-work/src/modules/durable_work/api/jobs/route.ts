import { NextResponse } from 'next/server'

import { routeContext, toDto } from '../../lib/route-helpers'
import type { DurableJobStatus } from '../../../../core/types'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['durable_work.view'] },
}

const STATUSES = new Set<DurableJobStatus>(['pending', 'running', 'completed', 'failed', 'cancelled'])

export async function GET(req: Request) {
  const ctx = await routeContext(req)
  if (ctx instanceof NextResponse) return ctx

  const url = new URL(req.url)
  const status = url.searchParams.get('status')
  const { items, total } = await ctx.service.list(ctx.scope, {
    kind: url.searchParams.get('kind') ?? undefined,
    status: status && STATUSES.has(status as DurableJobStatus) ? (status as DurableJobStatus) : undefined,
    page: Number(url.searchParams.get('page') ?? '1'),
    pageSize: Number(url.searchParams.get('pageSize') ?? '20'),
  })

  return NextResponse.json({ items: items.map(toDto), total })
}
