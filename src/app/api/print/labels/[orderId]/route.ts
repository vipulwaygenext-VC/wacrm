// POST /api/print/labels/<orderId> — the print agent marks a label
// printed (adds the Label-Printed tag on the Shopify order).

import { NextResponse } from 'next/server';
import { cronAuthError } from '@/lib/auth/cron-secret';
import { markPrinted } from '@/lib/shiprocket/dispatch';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ orderId: string }> }
) {
  const authError = cronAuthError(request);
  if (authError)
    return NextResponse.json({ error: 'Unauthorized' }, { status: authError });
  const { orderId } = await ctx.params;
  if (!/^\d+$/.test(orderId)) {
    return NextResponse.json({ error: 'bad order id' }, { status: 400 });
  }
  try {
    await markPrinted(orderId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[print] marking printed failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
