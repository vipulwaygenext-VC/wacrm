// ============================================================
// POST /api/integrations/razorpay/webhook — Razorpay `payment_link.paid`.
//
// Records the advance on the Shopify order (manual payment, so the
// amount due on delivery drops) and tags it `WA-Advance-Paid`.
// Authenticated by X-Razorpay-Signature (RAZORPAY_WEBHOOK_SECRET).
// Idempotent: a retried event finds the tag and does nothing.
// ============================================================

import { NextResponse } from 'next/server'
import { ADVANCE_TAG, orderIdFromReference, verifyRazorpaySignature } from '@/lib/shopify/advance'
import { getOrderForAdvance, recordManualPayment, updateOrderTags } from '@/lib/shopify/admin-api'

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
  const paise = event.payload?.payment?.entity?.amount ?? link?.amount_paid ?? 0
  if (!orderId || !paise) return NextResponse.json({ outcome: 'not_ours' })

  try {
    const order = await getOrderForAdvance(orderId)
    if (!order) return NextResponse.json({ outcome: 'order_missing' })
    if (order.tags.includes(ADVANCE_TAG)) return NextResponse.json({ outcome: 'already_recorded' })

    // Tag first so a retry can never record the payment twice; undo the
    // tag if recording fails so the retry tries again.
    await updateOrderTags(orderId, [ADVANCE_TAG])
    try {
      await recordManualPayment(orderId, paise / 100, 'Razorpay advance (WhatsApp)')
    } catch (err) {
      await updateOrderTags(orderId, [], [ADVANCE_TAG]).catch(() => {})
      throw err
    }
    return NextResponse.json({ outcome: 'recorded' })
  } catch (err) {
    console.error(`[razorpay] recording advance for order ${orderId} failed:`, err)
    // 500 so Razorpay retries; the tag check keeps retries idempotent.
    return NextResponse.json({ outcome: 'error' }, { status: 500 })
  }
}
