// ============================================================
// POST /api/integrations/shopify/orders — Shopify `orders/create` webhook.
//
// Sends the COD confirmation template to the customer on WhatsApp and
// tags the order `WA-Sent`. Authenticated by Shopify's HMAC signature
// (`SHOPIFY_WEBHOOK_SECRET`); fails closed when the secret is missing.
//
// Always answers 200 after a valid signature, even if the send failed
// (the order is tagged `WA-Send-Failed` instead) — a non-2xx would make
// Shopify retry and could message the customer twice.
// ============================================================

import { NextResponse } from 'next/server'
import { verifyShopifyHmac, type ShopifyOrderPayload } from '@/lib/shopify/cod-confirm'
import { sendCodConfirmation } from '@/lib/shopify/cod-service'

export async function POST(request: Request) {
  const rawBody = await request.text()
  const valid = verifyShopifyHmac(
    rawBody,
    request.headers.get('x-shopify-hmac-sha256'),
    process.env.SHOPIFY_WEBHOOK_SECRET
  )
  if (!valid) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let order: ShopifyOrderPayload
  try {
    order = JSON.parse(rawBody) as ShopifyOrderPayload
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  if (!order?.id) {
    return NextResponse.json({ error: 'missing_order_id' }, { status: 400 })
  }

  try {
    const outcome = await sendCodConfirmation(order)
    return NextResponse.json({ outcome })
  } catch (err) {
    console.error('[shopify-cod] webhook error:', err)
    return NextResponse.json({ outcome: 'error' })
  }
}
