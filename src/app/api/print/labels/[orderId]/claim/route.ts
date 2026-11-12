// POST   /api/print/labels/<orderId>/claim — a print agent asks to print
//        this label; 200 = go ahead, 409 = another device has it.
// DELETE /api/print/labels/<orderId>/claim — printing failed, let another
//        device (or the next poll) retry.

import { NextResponse } from 'next/server';
import { cronAuthError } from '@/lib/auth/cron-secret';
import { claimLabel, releaseLabel } from '@/lib/shiprocket/dispatch';

type Ctx = { params: Promise<{ orderId: string }> };

async function orderIdOrError(request: Request, ctx: Ctx) {
  const authError = cronAuthError(request);
  if (authError) {
    return {
      error: NextResponse.json(
        { error: 'Unauthorized' },
        { status: authError }
      ),
    };
  }
  const { orderId } = await ctx.params;
  if (!/^\d+$/.test(orderId)) {
    return {
      error: NextResponse.json({ error: 'bad order id' }, { status: 400 }),
    };
  }
  return { orderId };
}

export async function POST(request: Request, ctx: Ctx) {
  const r = await orderIdOrError(request, ctx);
  if (r.error) return r.error;
  try {
    const ok = await claimLabel(r.orderId!);
    return NextResponse.json({ claimed: ok }, { status: ok ? 200 : 409 });
  } catch (err) {
    console.error('[print] claim failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const r = await orderIdOrError(request, ctx);
  if (r.error) return r.error;
  try {
    await releaseLabel(r.orderId!);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[print] release failed:', err);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
