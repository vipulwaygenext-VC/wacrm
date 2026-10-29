// ============================================================
// POST /api/integrations/razorpay/webhook — Razorpay `payment_link.paid`.
//
// Records the advance on the Shopify order (manual payment, so the
// amount due on delivery drops) and tags it `WA-Advance-Paid`.
// Authenticated by X-Razorpay-Signature (RAZORPAY_WEBHOOK_SECRET).
// Idempotent: a retried event finds the tag and does nothing.
// ============================================================

import { NextResponse } from 'next/server'
import {
  ADVANCE_TAG,
  FULL_PAID_TAG,
  orderIdFromReference,
  verifyRazorpaySignature,
} from '@/lib/shopify/advance'
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
  const full = link?.notes?.kind === 'full' || /_full(?:_\d+)?$/.test(link?.reference_id ?? '')
  const tag = full ? FULL_PAID_TAG : ADVANCE_TAG
  const paise = event.payload?.payment?.entity?.amount ?? link?.amount_paid ?? 0
  if (!orderId || !paise) return NextResponse.json({ outcome: 'not_ours' })

  try {
    const order = await getOrderForAdvance(orderId)
    if (!order) return NextResponse.json({ outcome: 'order_missing' })
    if (order.tags.includes(tag)) return NextResponse.json({ outcome: 'already_recorded' })

    // Tag first so a retry can never record the payment twice; undo the
    // tag if recording fails so the retry tries again.
    await updateOrderTags(orderId, [tag])
    try {
      await recordManualPayment(
        orderId,
        paise / 100,
        full ? 'Razorpay full payment (WhatsApp)' : 'Razorpay advance (WhatsApp)'
      )
    } catch (err) {
      await updateOrderTags(orderId, [], [tag]).catch(() => {})
      throw err
    }
    if (full) {
      // Free shipping: the paid amount excluded the shipping / COD charge,
      // so settle what's left (at most that charge) as waived. This makes
      // the order fully paid, so it ships as prepaid.
      const after = await getOrderForAdvance(orderId).catch(() => null)
      if (after && after.outstanding > 0 && after.outstanding <= after.shipping + 0.01) {
        await recordManualPayment(orderId, after.outstanding, 'COD/shipping charge waived (prepaid)').catch(
          (err) => console.error(`[razorpay] waiving shipping on ${orderId} failed:`, err)
        )
      }
    }
    return NextResponse.json({ outcome: 'recorded' })
  } catch (err) {
    console.error(`[razorpay] recording advance for order ${orderId} failed:`, err)
    // 500 so Razorpay retries; the tag check keeps retries idempotent.
    return NextResponse.json({ outcome: 'error' }, { status: 500 })
  }
}
