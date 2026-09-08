import { NextResponse } from 'next/server'

import { routeContext, toDto } from '../../../lib/route-helpers'

export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['durable_work.operate'] },
}

/**
 * Runs a stopped job again.
 *
 * Each refusal is a 409 with a code rather than a generic failure, because the three have
 * different answers: wait for or cancel the job holding the lock key; nothing to re-drive;
 * or say explicitly that re-running an unrecoverable failure is right.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await routeContext(req)
  if (ctx instanceof NextResponse) return ctx

  const body = (await req.json().catch(() => ({}))) as { force?: boolean }
  const result = await ctx.service.redrive(params.id, ctx.scope, { force: body.force === true })

  if ('refused' in result) {
    return NextResponse.json({ error: result.refused, heldBy: result.heldBy }, { status: 409 })
  }
  return NextResponse.json(toDto(result))
}
