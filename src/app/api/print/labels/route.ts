// GET /api/print/labels — Shiprocket labels ready but not printed yet.
// Polled by the label print agent on the office laptop
// (scripts/print-agent/hindrishi-print-agent.ps1), which sends
// `x-cron-secret: <AUTOMATION_CRON_SECRET>`.

import { NextResponse } from 'next/server';
import { cronAuthError } from '@/lib/auth/cron-secret';
import { labelsToPrint } from '@/lib/shiprocket/dispatch';

export async function GET(request: Request) {
  const authError = cronAuthError(request);
  if (authError)
    return NextResponse.json({ error: 'Unauthorized' }, { status: authError });
  try {
    return NextResponse.json({ labels: await labelsToPrint() });
  } catch (err) {
    console.error('[print] listing labels failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
