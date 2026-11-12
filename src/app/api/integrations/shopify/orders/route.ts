// ============================================================
// POST /api/integrations/shopify/orders — Shopify `orders/create` webhook.
//
// Sends the COD confirmation template to the customer on WhatsApp and
// tags the order `WA-Sent`. Authenticated by Shopify's HMAC signature
// (`SHOPIFY_WEBHOOK_SECRET`); fails closed when the secret is missing.
//
// Answers 200 immediately after a valid signature and sends in the
// background; each order is claimed once (metafield wacrm.confirmation_sent)
// so a redelivered webhook never messages the customer twice.
// ============================================================

import { NextResponse, after } from 'next/server'
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

  // Ack Shopify right away (it times out after ~5s and then redelivers,
  // which used to send the customer duplicate messages) and send the
  // WhatsApp message after the response. `after()` keeps the function
  // alive until the work finishes.
  after(async () => {
    try {
      const outcome = await sendCodConfirmation(order)
      console.log(`[shopify-cod] order ${order.name ?? order.id}: ${outcome}`)
    } catch (err) {
      console.error('[shopify-cod] webhook error:', err)
    }
  })
  return NextResponse.json({ status: 'received' })
}

export const maxDuration = 60
