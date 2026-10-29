// ============================================================
// Shopify COD confirmation — the I/O side.
//
//   sendCodConfirmation(order)      called by the Shopify webhook route
//   handleCodButtonReply(...)       called by the WhatsApp webhook when
//                                   a template quick-reply tap carries a
//                                   `shopify_cod:` payload
//
// Env:
//   SHOPIFY_WACRM_ACCOUNT_ID        optional: wacrm account that owns the
//                                   WhatsApp number used for confirmations
//                                   (defaults to the only connected account)
//   SHOPIFY_COD_TEMPLATE_NAME       default: cod_order_confirmation
//   SHOPIFY_COD_TEMPLATE_LANGUAGE   default: en (also used for prepaid)
//   SHOPIFY_PREPAID_TEMPLATE_NAME   default: prepaid_order_confirmation
//   SHOPIFY_HELPLINE_NUMBER         default: 9278142142
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { updateOrderTags } from './admin-api'
import {
  COD_TAGS,
  DEFAULT_HELPLINE,
  alreadyHandled,
  buildPrepaidTemplateParams,
  buildTemplateParams,
  customerFirstName,
  extractOrderPhone,
  isCodOrder,
  isPrepaidOrder,
  parseReplyPayload,
  type ShopifyOrderPayload,
} from './cod-confirm'

export type SendOutcome =
  | 'sent'
  | 'sent_prepaid'
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

function prepaidTemplateName(): string {
  return process.env.SHOPIFY_PREPAID_TEMPLATE_NAME || 'prepaid_order_confirmation'
}

function helpline(): string {
  return process.env.SHOPIFY_HELPLINE_NUMBER || DEFAULT_HELPLINE
}

let cachedAccountId: string | null = null

/**
 * The wacrm account whose WhatsApp number sends confirmations:
 * SHOPIFY_WACRM_ACCOUNT_ID when set, otherwise the only account with a
 * WhatsApp connection (single-tenant installs need no extra setting).
 */
export async function codAccountId(): Promise<string | null> {
  const fromEnv = process.env.SHOPIFY_WACRM_ACCOUNT_ID
  if (fromEnv) return fromEnv
  if (cachedAccountId) return cachedAccountId
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id')
    .limit(2)
  if (error || !data || data.length !== 1) return null
  cachedAccountId = data[0].account_id as string
  return cachedAccountId
}

export async function sendCodConfirmation(
  order: ShopifyOrderPayload
): Promise<SendOutcome> {
  const cod = isCodOrder(order)
  if (!cod && !isPrepaidOrder(order)) return 'skipped_not_cod'
  if (alreadyHandled(order)) return 'skipped_already_handled'

  const accountId = await codAccountId()
  if (!accountId) {
    throw new Error('Set SHOPIFY_WACRM_ACCOUNT_ID (no single WhatsApp account found)')
  }

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
      templateName: cod ? templateName() : prepaidTemplateName(),
      templateLanguage: templateLanguage(),
      templateMessageParams: cod ? buildTemplateParams(order) : buildPrepaidTemplateParams(order),
      interactivePayload: null,
      replyToMessageId: null,
    })
  } catch (err) {
    console.error(`[shopify-cod] send failed for order ${order.name ?? order.id}:`, err)
    await updateOrderTags(order.id, [COD_TAGS.sendFailed]).catch(() => {})
    return 'send_failed'
  }

  // Prepaid orders need no reply, so they go straight to Confirmed.
  await updateOrderTags(order.id, [cod ? COD_TAGS.sent : COD_TAGS.confirmed])
  return cod ? 'sent' : 'sent_prepaid'
}

function replyText(action: 'confirm' | 'cancel'): string {
  const help = `Koi bhi sawaal ho toh humein ${helpline()} par call karein.`
  return action === 'confirm'
    ? `Dhanyavaad! Aapka order confirm ho gaya hai. Hum ise jaldi dispatch karenge aur tracking link WhatsApp par bhejenge. ${help}`
    : `Aapka order cancel request mil gaya hai. Agar galti se cancel hua ho, toh yahin reply karke humein bata dijiye. ${help}`
}

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
  if ((await codAccountId()) !== params.accountId) return false

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
      contentText: replyText(parsed.action),
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
