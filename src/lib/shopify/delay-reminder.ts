// ============================================================
// Daily WhatsApp nudge for orders still unfulfilled after N days.
//
//   paid / advance-paid  → order_delay_paid    (reassurance)
//   unpaid COD           → order_delay_unpaid  (pay ₹100 / pay full /
//                                               cancel buttons)
//
// Each order is reminded once (metafield claim + WA-Delay-Sent tag).
// The customer is reached through the conversation id we stored when
// the confirmation went out, so no protected customer data is read.
//
// Env:
//   ORDER_DELAY_DAYS                   default 3
//   ORDER_DELAY_PAID_TEMPLATE_NAME     default order_delay_paid
//   ORDER_DELAY_UNPAID_TEMPLATE_NAME   default order_delay_unpaid
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import {
  claimOrderOnce,
  findDelayCandidates,
  updateOrderTags,
  type DelayCandidate,
} from './admin-api'
import {
  ADVANCE_TAG,
  FULL_PAID_TAG,
  advanceAmount,
  buildPayToken,
  isAdvanceEnabled,
} from './advance'
import { COD_TAGS, buildReplyPayload } from './cod-confirm'
import { codAccountId } from './cod-service'

export const DELAY_TAG = 'WA-Delay-Sent'

export function delayDays(): number {
  const n = Number(process.env.ORDER_DELAY_DAYS)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3
}

export type DelayKind = 'paid' | 'unpaid' | 'skip'

export function classifyDelay(o: Pick<DelayCandidate, 'tags' | 'outstanding'>): DelayKind {
  const tags = o.tags.map((t) => t.toLowerCase())
  const has = (t: string) => tags.includes(t.toLowerCase())
  if (has(COD_TAGS.cancelled) || has(COD_TAGS.cancelRequested) || has('no-whatsapp')) return 'skip'
  if (o.outstanding <= 0 || has(FULL_PAID_TAG) || has(ADVANCE_TAG)) return 'paid'
  return 'unpaid'
}

function rupees(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export async function runDelayReminders(): Promise<Record<string, number>> {
  const stats: Record<string, number> = { checked: 0, sent_paid: 0, sent_unpaid: 0, skipped: 0, failed: 0 }
  const accountId = await codAccountId()
  if (!accountId) return stats
  const db = supabaseAdmin()
  const orders = await findDelayCandidates(delayDays(), DELAY_TAG)

  for (const o of orders) {
    stats.checked++
    const kind = classifyDelay(o)
    if (kind === 'skip' || !o.conversationId) {
      stats.skipped++
      continue
    }
    if (kind === 'unpaid' && !isAdvanceEnabled()) {
      stats.skipped++
      continue
    }
    if ((await claimOrderOnce(o.id, 'delay_reminder')) === 'taken') {
      stats.skipped++
      continue
    }

    const { data: conv } = await db
      .from('conversations')
      .select('contacts(name)')
      .eq('id', o.conversationId)
      .maybeSingle()
    const rel = (conv as { contacts?: { name?: string | null } | { name?: string | null }[] } | null)?.contacts
    const name = (Array.isArray(rel) ? rel[0]?.name : rel?.name)?.trim().split(/\s+/)[0] || 'Customer'
    const orderNo = o.name.replace(/^#/, '')
    const product = o.productTitle.length > 60 ? `${o.productTitle.slice(0, 57)}...` : o.productTitle

    try {
      if (kind === 'paid') {
        await sendMessageToConversation(db, accountId, {
          conversationId: o.conversationId,
          messageType: 'template',
          contentText: null,
          mediaUrl: null,
          filename: null,
          templateName: process.env.ORDER_DELAY_PAID_TEMPLATE_NAME || 'order_delay_paid',
          templateLanguage: process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en',
          templateMessageParams: { body: [name, orderNo, product] },
          interactivePayload: null,
          replyToMessageId: null,
        })
        stats.sent_paid++
      } else {
        const token = buildPayToken(o.id, process.env.RAZORPAY_KEY_SECRET!)
        await sendMessageToConversation(db, accountId, {
          conversationId: o.conversationId,
          messageType: 'template',
          contentText: null,
          mediaUrl: null,
          filename: null,
          templateName: process.env.ORDER_DELAY_UNPAID_TEMPLATE_NAME || 'order_delay_unpaid',
          templateLanguage: process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en',
          templateMessageParams: {
            body: [name, orderNo, product, rupees(Math.max(0, o.outstanding - advanceAmount()))],
            buttonParams: { 0: token, 1: token, 2: buildReplyPayload('cancel', o.id) },
          },
          interactivePayload: null,
          replyToMessageId: null,
        })
        stats.sent_unpaid++
      }
      await updateOrderTags(o.id, [DELAY_TAG])
    } catch (err) {
      stats.failed++
      console.error(`[delay-reminder] ${o.name} failed:`, err)
    }
  }
  return stats
}
