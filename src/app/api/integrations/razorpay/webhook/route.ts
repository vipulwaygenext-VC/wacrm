// ============================================================
// POST /api/integrations/razorpay/webhook — Razorpay `payment_link.paid`.
//
// Records the payment on the Shopify order, tags + notes it, and sends
// the customer a WhatsApp confirmation (see payment-received.ts).
// Authenticated by X-Razorpay-Signature (RAZORPAY_WEBHOOK_SECRET).
// Idempotent: a once-per-order claim makes retries no-ops.
// ============================================================

import { NextResponse } from 'next/server'
import { orderIdFromReference, verifyRazorpaySignature } from '@/lib/shopify/advance'
import { recordRazorpayPayment } from '@/lib/shopify/payment-received'

interface PaymentLinkPaidEvent {
  event: string
  payload?: {
    payment_link?: {
      entity?: {
        reference_id?: string
        amount_paid?: number
        notes?: Record<string, string>
      }
    }
    payment?: { entity?: { id?: string; amount?: number } }
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (
    !verifyRazorpaySignature(
      rawBody,
      request.headers.get('x-razorpay-signature'),
      process.env.RAZORPAY_WEBHOOK_SECRET
    )
  ) {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 401 })
  }

  let event: PaymentLinkPaidEvent
  try {
    event = JSON.parse(rawBody) as PaymentLinkPaidEvent
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }
  if (event.event !== 'payment_link.paid') return NextResponse.json({ outcome: 'ignored' })

  const link = event.payload?.payment_link?.entity
  const orderId = link?.notes?.shopify_order_id || orderIdFromReference(link?.reference_id)
  const full = link?.notes?.kind === 'full' || /_full(?:_\d+)?$/.test(link?.reference_id ?? '')
  const paise = event.payload?.payment?.entity?.amount ?? link?.amount_paid ?? 0
  const paymentId = event.payload?.payment?.entity?.id ?? 'razorpay'
  if (!orderId || !paise) return NextResponse.json({ outcome: 'not_ours' })

  try {
    const outcome = await recordRazorpayPayment({
      orderId,
      kind: full ? 'full' : 'advance',
      amount: paise / 100,
      paymentId,
    })
    return NextResponse.json({ outcome })
  } catch (err) {
    console.error(`[razorpay] recording payment for order ${orderId} failed:`, err)
    // 500 so Razorpay retries; the once-per-order claim keeps it safe.
    return NextResponse.json({ outcome: 'error' }, { status: 500 })
  }
}
