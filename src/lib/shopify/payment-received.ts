// ============================================================
// A Razorpay payment for a Shopify order arrived (webhook).
//
//   1. once per order + kind (metafield claim, so retries are safe)
//   2. record it in Shopify:
//        full    → orderMarkAsPaid (works on every plan)
//        advance → orderCreateManualPayment with the amount. That needs
//                  Shopify Plus; on other plans it fails, so we remember
//                  the advance in a metafield instead (the Pay Full link
//                  then subtracts it) and say so in the note.
//   3. clear tags + an order note anyone in the team can read
//   4. WhatsApp confirmation to the customer (text inside the 24h
//      window, else the `payment_received` template)
//
// Every step after the claim is best-effort: one failing step never
// blocks the others or makes Razorpay retry forever.
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  appendOrderNote,
  claimOrderOnce,
  getOrderForAdvance,
  getOrderNoteAndChat,
  markOrderPaid,
  recordManualPayment,
  setOrderMetafield,
  updateOrderTags,
} from './admin-api'
import { ADVANCE_TAG, FULL_PAID_TAG, type PayKind } from './advance'
import { COD_TAGS } from './cod-confirm'
import { codAccountId } from './cod-service'

const HELPLINE = () => process.env.SHOPIFY_HELPLINE_NUMBER || '9278142142'

function rupees(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** Tags a person can read at a glance in the Shopify order list. */
export function paymentTags(kind: PayKind, amount: number, balance: number): string[] {
  if (kind === 'full') return [FULL_PAID_TAG, 'Paid Online (Full)', COD_TAGS.confirmed]
  return [
    ADVANCE_TAG,
    `₹${rupees(amount)} Advance Paid`,
    `Collect ₹${rupees(balance)} on Delivery`,
    COD_TAGS.confirmed,
  ]
}

export function paymentNote(kind: PayKind, amount: number, balance: number, paymentId: string): string {
  const when = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  return kind === 'full'
    ? `[WhatsApp ${when}] ₹${rupees(amount)} paid in full online on Razorpay (${paymentId}). Nothing to collect on delivery — COD/shipping charge waived.`
    : `[WhatsApp ${when}] ₹${rupees(amount)} advance received on Razorpay (${paymentId}). COLLECT ₹${rupees(balance)} ON DELIVERY.`
}

export function paymentText(kind: PayKind, orderName: string, amount: number, balance: number): string {
  const rest =
    kind === 'full' || balance <= 0
      ? 'Ab delivery par kuch nahi dena hai.'
      : `Baaki ₹${rupees(balance)} delivery par dena hoga.`
  return (
    `Dhanyavaad! 🙏 Order ${orderName} ke liye aapka ₹${rupees(amount)} payment mil gaya hai ✅ ` +
    `Aapka order confirm ho gaya hai aur jaldi dispatch hoga. ${rest} ` +
    `Koi bhi sawaal ho toh ${HELPLINE()} par call karein.`
  )
}

export async function recordRazorpayPayment(args: {
  orderId: string
  kind: PayKind
  amount: number
  paymentId: string
}): Promise<'recorded' | 'already_recorded' | 'order_missing'> {
  const { orderId, kind, amount, paymentId } = args

  const claim = await claimOrderOnce(orderId, `paid_${kind}`)
  if (claim === 'taken') return 'already_recorded'

  const order = await getOrderForAdvance(orderId).catch(() => null)
  if (!order) return 'order_missing'
  const balance =
    kind === 'full' ? 0 : Math.max(0, Math.round((order.outstanding - amount) * 100) / 100)

  // 2. Record it in Shopify.
  let shopifyRecorded = false
  try {
    if (kind === 'full') await markOrderPaid(orderId)
    else await recordManualPayment(orderId, amount, `Razorpay advance (WhatsApp) ${paymentId}`)
    shopifyRecorded = true
  } catch (err) {
    console.warn(`[razorpay] Shopify couldn't record the ${kind} payment on ${orderId}:`, err)
  }
  if (kind === 'advance' && !shopifyRecorded) {
    await setOrderMetafield(orderId, 'advance_unrecorded', String(amount)).catch((e) =>
      console.error('[razorpay] storing unrecorded advance failed:', e)
    )
  }

  // 3. Tags + note.
  await updateOrderTags(orderId, paymentTags(kind, amount, balance), [
    COD_TAGS.sent,
    COD_TAGS.cancelRequested,
    COD_TAGS.cancelled,
  ]).catch((e) => console.error('[razorpay] tagging failed:', e))
  await appendOrderNote(orderId, paymentNote(kind, amount, balance, paymentId)).catch((e) =>
    console.error('[razorpay] order note failed:', e)
  )

  // 4. Tell the customer.
  await notifyCustomer(orderId, kind, order.name, amount, balance)
  return 'recorded'
}

async function notifyCustomer(
  orderId: string,
  kind: PayKind,
  orderName: string,
  amount: number,
  balance: number
): Promise<void> {
  try {
    const accountId = await codAccountId()
    const { conversationId } = await getOrderNoteAndChat(orderId)
    if (!accountId || !conversationId) return
    const db = supabaseAdmin()
    const base = {
      conversationId,
      mediaUrl: null,
      filename: null,
      interactivePayload: null,
      replyToMessageId: null,
    }
    try {
      await sendMessageToConversation(db, accountId, {
        ...base,
        messageType: 'text',
        contentText: paymentText(kind, orderName, amount, balance),
        templateName: null,
        templateLanguage: null,
      })
    } catch {
      // Outside the 24-hour window a free-form text is refused — use the
      // approved template instead.
      const rest =
        kind === 'full' || balance <= 0
          ? 'Ab delivery par kuch nahi dena hai.'
          : `Baaki ₹${rupees(balance)} delivery par dena hoga.`
      await sendMessageToConversation(db, accountId, {
        ...base,
        messageType: 'template',
        contentText: null,
        templateName: process.env.PAYMENT_RECEIVED_TEMPLATE_NAME || 'payment_received',
        templateLanguage: process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en',
        templateMessageParams: {
          body: [orderName.replace(/^#/, ''), rupees(amount), rest],
        },
      })
    }
  } catch (err) {
    console.error(`[razorpay] payment confirmation to customer failed for ${orderId}:`, err)
  }
}
