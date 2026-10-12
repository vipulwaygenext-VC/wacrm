// ============================================================
// Shopify COD confirmation — the I/O side.
//
//   sendCodConfirmation(order)      called by the Shopify webhook route
//   handleCodButtonReply(...)       called by the WhatsApp webhook when
//                                   a template quick-reply tap carries a
//                                   `shopify_cod:` payload
//
// Env:
//   SHOPIFY_WACRM_ACCOUNT_ID        wacrm account that owns the WhatsApp
//                                   number used for confirmations
//   SHOPIFY_COD_TEMPLATE_NAME       default: cod_order_confirmation
//   SHOPIFY_COD_TEMPLATE_LANGUAGE   default: en
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { updateOrderTags } from './admin-api'
import {
  COD_TAGS,
  alreadyHandled,
  buildTemplateParams,
  customerFirstName,
  extractOrderPhone,
  isCodOrder,
  parseReplyPayload,
  type ShopifyOrderPayload,
} from './cod-confirm'

export type SendOutcome =
  | 'sent'
  | 'skipped_not_cod'
  | 'skipped_already_handled'
  | 'no_phone'
  | 'send_failed'

function templateName(): string {
  return process.env.SHOPIFY_COD_TEMPLATE_NAME || 'cod_order_confirmation'
}

function templateLanguage(): string {
  return process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en'
}

export function codAccountId(): string | null {
  return process.env.SHOPIFY_WACRM_ACCOUNT_ID || null
}

export async function sendCodConfirmation(
  order: ShopifyOrderPayload
): Promise<SendOutcome> {
  if (!isCodOrder(order)) return 'skipped_not_cod'
  if (alreadyHandled(order)) return 'skipped_already_handled'

  const accountId = codAccountId()
  if (!accountId) throw new Error('SHOPIFY_WACRM_ACCOUNT_ID not configured')

  const phone = extractOrderPhone(order)
  if (!phone) {
    await updateOrderTags(order.id, [COD_TAGS.noPhone]).catch((e) =>
      console.error('[shopify-cod] tag no-phone failed:', e)
    )
    return 'no_phone'
  }

  const supabase = supabaseAdmin()
  try {
    const resolved = await resolveConversationByPhone(
      supabase,
      accountId,
      phone,
      customerFirstName(order)
    )
    await sendMessageToConversation(supabase, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      contentText: null,
      mediaUrl: null,
      filename: null,
      templateName: templateName(),
      templateLanguage: templateLanguage(),
      templateMessageParams: buildTemplateParams(order),
      interactivePayload: null,
      replyToMessageId: null,
    })
  } catch (err) {
    console.error(`[shopify-cod] send failed for order ${order.name ?? order.id}:`, err)
    await updateOrderTags(order.id, [COD_TAGS.sendFailed]).catch(() => {})
    return 'send_failed'
  }

  await updateOrderTags(order.id, [COD_TAGS.sent])
  return 'sent'
}

const REPLY_TEXT = {
  confirm:
    'Dhanyavaad! Aapka order confirm ho gaya hai. Hum ise jaldi dispatch karenge aur tracking link WhatsApp par bhejenge.',
  cancel:
    'Aapka order cancel request mil gaya hai. Agar galti se cancel hua ho, toh yahin reply karke humein bata dijiye.',
} as const

/**
 * Handle a Confirm/Cancel tap. Returns true when the payload was ours
 * (so callers can log it), false otherwise. Never throws.
 */
export async function handleCodButtonReply(params: {
  accountId: string
  conversationId: string
  replyId: string | null | undefined
}): Promise<boolean> {
  const parsed = parseReplyPayload(params.replyId)
  if (!parsed) return false
  // Only the account wired to Shopify may touch Shopify orders.
  if (codAccountId() !== params.accountId) return false

  try {
    if (parsed.action === 'confirm') {
      await updateOrderTags(parsed.orderId, [COD_TAGS.confirmed], [COD_TAGS.sent, COD_TAGS.cancelled])
    } else {
      await updateOrderTags(parsed.orderId, [COD_TAGS.cancelled], [COD_TAGS.sent, COD_TAGS.confirmed])
    }
  } catch (err) {
    console.error(`[shopify-cod] tagging order ${parsed.orderId} failed:`, err)
  }

  // The customer just messaged us, so a free-form reply is inside the
  // 24-hour service window.
  try {
    await sendMessageToConversation(supabaseAdmin(), params.accountId, {
      conversationId: params.conversationId,
      messageType: 'text',
      contentText: REPLY_TEXT[parsed.action],
      mediaUrl: null,
      filename: null,
      templateName: null,
      templateLanguage: null,
      interactivePayload: null,
      replyToMessageId: null,
    })
  } catch (err) {
    console.error('[shopify-cod] acknowledgement send failed:', err)
  }
  return true
}
