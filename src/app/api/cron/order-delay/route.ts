// GET /api/cron/order-delay — daily reminder for unfulfilled orders.
//
// Scheduled by vercel.json. Vercel sends `Authorization: Bearer
// <CRON_SECRET>`; a manual run can send `x-cron-secret:
// <AUTOMATION_CRON_SECRET>` instead. Refuses to run with neither set.

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runDelayReminders } from '@/lib/shopify/delay-reminder'

export const maxDuration = 300

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET
  const manualSecret = process.env.AUTOMATION_CRON_SECRET
  if (!cronSecret && !manualSecret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const manual = request.headers.get('x-cron-secret') ?? ''
  const ok = (cronSecret && same(bearer, cronSecret)) || (manualSecret && same(manual, manualSecret))
  if (!ok) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const stats = await runDelayReminders()
  return NextResponse.json(stats)
}
