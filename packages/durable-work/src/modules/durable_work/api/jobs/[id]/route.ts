import { NextResponse } from 'next/server'

import { routeContext, toDto } from '../../../lib/route-helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['durable_work.view'] },
  DELETE: { requireAuth: true, requireFeatures: ['durable_work.operate'] },
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const ctx = await routeContext(req)
  if (ctx instanceof NextResponse) return ctx
  const job = await ctx.service.get(params.id, ctx.scope)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(toDto(job))
}

/** Asks the job to stop. Answers with what actually happened — a running job is `cancelling`
 *  until its driver observes the request, and saying `cancelled` before that would be a lie
 *  an operator might act on. */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const ctx = await routeContext(req)
  if (ctx instanceof NextResponse) return ctx
  const job = await ctx.service.cancel(params.id, ctx.scope, ctx.userId)
  if (!job) return NextResponse.json({ error: 'Not found or already finished' }, { status: 404 })
  return NextResponse.json({ ...toDto(job), state: job.status === 'cancelled' ? 'cancelled' : 'cancelling' })
}
