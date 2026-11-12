// ============================================================
// POST /api/integrations/shopify/orders-updated — Shopify `orders/updated`
// webhook. When staff add the RTD (or SR-Rebook) tag, book Shiprocket
// and make the label right away instead of waiting for the 10-minute
// sweep. Same HMAC secret as the orders/create webhook.
// ============================================================

import { NextResponse, after } from 'next/server';
import { verifyShopifyHmac } from '@/lib/shopify/cod-confirm';
import { dispatchOrder, wantsDispatch } from '@/lib/shiprocket/dispatch';
import { shiprocketConfigured } from '@/lib/shiprocket/client';

export const maxDuration = 60;

export async function POST(request: Request) {
  const rawBody = await request.text();
  const valid = verifyShopifyHmac(
    rawBody,
    request.headers.get('x-shopify-hmac-sha256'),
    process.env.SHOPIFY_WEBHOOK_SECRET
  );
  if (!valid) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
  }
  let order: {
    id?: number;
    name?: string;
    tags?: string;
    cancelled_at?: string | null;
  };
  try {
    order = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (
    !order?.id ||
    order.cancelled_at ||
    !wantsDispatch(order.tags) ||
    !shiprocketConfigured()
  ) {
    return NextResponse.json({ status: 'ignored' });
  }
  const id = order.id;
  after(async () => {
    try {
      const r = await dispatchOrder(id, 'RTD tag');
      console.log(`[shiprocket] ${order.name ?? id} on tag: ${r}`);
    } catch (err) {
      console.error('[shiprocket] dispatch on tag failed:', err);
    }
  });
  return NextResponse.json({ status: 'received' });
}
