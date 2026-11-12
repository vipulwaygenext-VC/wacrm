// GET /api/cron/shiprocket — book Shiprocket labels for orders tagged
// RTD (or waiting in SR-Pending). Called every 10 min by
// .github/workflows/cart-reminder.yml.

import { NextResponse } from 'next/server';
import { cronAuthError } from '@/lib/auth/cron-secret';
import { dispatchOrder, findOrdersToDispatch } from '@/lib/shiprocket/dispatch';
import { shiprocketConfigured } from '@/lib/shiprocket/client';

export const maxDuration = 60;
const MAX_PER_RUN = 12;

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError) {
    return NextResponse.json(
      { error: authError === 503 ? 'cron not configured' : 'Unauthorized' },
      { status: authError }
    );
  }
  if (!shiprocketConfigured()) {
    return NextResponse.json({
      skipped: 'SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD not set',
    });
  }
  try {
    const ids = await findOrdersToDispatch();
    const results: Record<string, number> = {};
    for (const id of ids.slice(0, MAX_PER_RUN)) {
      const outcome = await dispatchOrder(id, 'RTD / retry');
      results[outcome] = (results[outcome] ?? 0) + 1;
    }
    return NextResponse.json({ found: ids.length, ...results });
  } catch (err) {
    console.error('[shiprocket] sweep failed:', err);
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message.slice(0, 300) : 'sweep failed',
      },
      { status: 500 }
    );
  }
}
