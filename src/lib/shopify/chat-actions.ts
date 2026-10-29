// ============================================================
// Order actions driven by the WhatsApp chat:
//
//   - the AI agent cancels an order by ending its reply with
//     [[CANCEL_ORDER]] (only after one save attempt, per its prompt)
//   - a customer sends a photo / document (e.g. a medical report):
//     we acknowledge, pause the bot, and alert the office number
//   - the AI hands a chat to a human: alert the office number
//
// The order is never taken from the model's text. It is read from the
// signed pay link we sent in this conversation, so the model can only
// ever act on the customer's own order.
//
// Env:
//   STAFF_ALERT_NUMBER           office WhatsApp number for alerts
//                                (unset → no alerts)
//   STAFF_ALERT_TEMPLATE_NAME    default: staff_alert
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { getOrderForAdvance, updateOrderTags } from './admin-api'
import { parsePayToken } from './advance'
import { COD_TAGS, normalizeIndianPhone } from './cod-confirm'

export const CANCEL_SENTINEL = '[[CANCEL_ORDER]]'

export const REPORT_ACK =
  'Dhanyavaad! 🙏 Aapki report / photo humein mil gayi hai. Hamare doctor ise dekh kar jaldi aapse contact karenge.'

const PAY_TOKEN_IN_TEXT = /\/pay\/(?:f\/)?(\d+-[0-9a-f]{16})/g

/** The order id from the newest signed pay link in these texts, or null. */
export function orderIdFromTexts(texts: string[], secret: string): string | null {
  for (const text of texts) {
    const matches = [...text.matchAll(PAY_TOKEN_IN_TEXT)]
    for (const m of matches.reverse()) {
      const id = parsePayToken(m[1], secret)
      if (id) return id
    }
  }
  return null
}

/** Strip the cancel sentinel; report whether it was present. */
export function extractCancel(raw: string): { text: string; cancel: boolean } {
  const cancel = raw.includes(CANCEL_SENTINEL)
  return { text: raw.split(CANCEL_SENTINEL).join('').trim(), cancel }
}

/** Newest-first business-sent texts in a conversation. */
async function recentBusinessTexts(db: SupabaseClient, conversationId: string): Promise<string[]> {
  const { data } = await db
    .from('messages')
    .select('content_text')
    .eq('conversation_id', conversationId)
    .neq('sender_type', 'customer')
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(30)
  return ((data ?? []) as { content_text: string | null }[])
    .map((r) => r.content_text ?? '')
    .filter(Boolean)
}

/** Cancel the order this conversation is about. Never throws. */
export async function cancelOrderFromChat(
  db: SupabaseClient,
  conversationId: string
): Promise<string | null> {
  try {
    const secret = process.env.RAZORPAY_KEY_SECRET
    if (!secret) return null
    const orderId = orderIdFromTexts(await recentBusinessTexts(db, conversationId), secret)
    if (!orderId) return null
    await updateOrderTags(
      orderId,
      [COD_TAGS.cancelled],
      [COD_TAGS.sent, COD_TAGS.confirmed, COD_TAGS.cancelRequested]
    )
    const order = await getOrderForAdvance(orderId).catch(() => null)
    return order?.name ?? orderId
  } catch (err) {
    console.error('[chat-actions] cancel from chat failed:', err)
    return null
  }
}

/**
 * Send the office a WhatsApp alert (approved Utility template).
 * Body: {{1}} customer name · {{2}} customer phone · {{3}} what happened.
 * Never throws; no-op when STAFF_ALERT_NUMBER is unset.
 */
export async function alertStaff(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  what: string
): Promise<void> {
  const office = normalizeIndianPhone(process.env.STAFF_ALERT_NUMBER)
  if (!office) return
  try {
    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const officeChat = await resolveConversationByPhone(db, accountId, office, 'Hindrishi Office')
    await sendMessageToConversation(db, accountId, {
      conversationId: officeChat.conversationId,
      messageType: 'template',
      contentText: null,
      mediaUrl: null,
      filename: null,
      templateName: process.env.STAFF_ALERT_TEMPLATE_NAME || 'staff_alert',
      templateLanguage: process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en',
      templateMessageParams: {
        body: [
          (contact?.name as string | null)?.trim() || 'Customer',
          (contact?.phone as string | null) || '-',
          what.slice(0, 120),
        ],
      },
      interactivePayload: null,
      replyToMessageId: null,
    })
  } catch (err) {
    console.error('[chat-actions] staff alert failed:', err)
  }
}

/**
 * A customer sent a photo or document. Acknowledge once (per 3 hours),
 * pause the bot so a person handles it, and alert the office.
 * Never throws.
 */
export async function handleInboundReport(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string; kind: string }
): Promise<void> {
  try {
    const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const { data: recentAck } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', args.conversationId)
      .eq('content_text', REPORT_ACK)
      .gte('created_at', since)
      .limit(1)
    if (recentAck && recentAck.length > 0) return

    await sendMessageToConversation(db, args.accountId, {
      conversationId: args.conversationId,
      messageType: 'text',
      contentText: REPORT_ACK,
      mediaUrl: null,
      filename: null,
      templateName: null,
      templateLanguage: null,
      interactivePayload: null,
      replyToMessageId: null,
    })
    await db
      .from('conversations')
      .update({
        ai_autoreply_disabled: true,
        ai_handoff_summary: `📄 Customer shared a ${args.kind} (report?). A doctor / team member should reply.`,
      })
      .eq('id', args.conversationId)
    await alertStaff(db, args.accountId, args.contactId, `${args.kind} / report bheja hai`)
  } catch (err) {
    console.error('[chat-actions] inbound report handling failed:', err)
  }
}
