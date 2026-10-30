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
//   PUBLIC_APP_URL                  base URL for pay links in chat replies
//                                   (default: Vercel production URL)
// ============================================================

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { claimOrderOnce, getOrderForAdvance, setOrderMetafield, updateOrderTags } from './admin-api'
import {
  advanceAmount,
  advanceApplies,
  advanceTemplateName,
  buildPayToken,
  isAdvanceEnabled,
  payLinks,
  prepayTemplateName,
  remainingAfterAdvance,
} from './advance'
import {
  COD_TAGS,
  DEFAULT_HELPLINE,
  alreadyHandled,
  buildAdvanceTemplateParams,
  buildPrepaidTemplateParams,
  buildPrepayTemplateParams,
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

interface TemplateChoice {
  templateName: string
  templateLanguage: string
  templateMessageParams: { body: string[]; buttonParams?: Record<number, string> }
}

/**
 * Templates to try, best first. A newer template that Meta hasn't
 * approved yet (or that was paused) fails the send, so the next one is
 * tried — rolling out a new template never stops confirmations.
 */
export function templateChoices(order: ShopifyOrderPayload, cod: boolean): TemplateChoice[] {
  const language = templateLanguage()
  if (!cod) {
    return [
      {
        templateName: prepaidTemplateName(),
        templateLanguage: language,
        templateMessageParams: buildPrepaidTemplateParams(order),
      },
    ]
  }
  const total = Number(order.total_price ?? 0)
  const choices: TemplateChoice[] = []
  if (isAdvanceEnabled() && advanceApplies(total)) {
    const token = buildPayToken(order.id, process.env.RAZORPAY_KEY_SECRET!)
    const remaining = remainingAfterAdvance(total)
    const prepay = prepayTemplateName()
    if (prepay) {
      choices.push({
        templateName: prepay,
        templateLanguage: language,
        templateMessageParams: buildPrepayTemplateParams(order, remaining, token),
      })
    }
    choices.push({
      templateName: advanceTemplateName(),
      templateLanguage: language,
      templateMessageParams: buildAdvanceTemplateParams(order, remaining, token),
    })
  }
  choices.push({
    templateName: templateName(),
    templateLanguage: language,
    templateMessageParams: buildTemplateParams(order),
  })
  return choices
}

export async function sendCodConfirmation(
  order: ShopifyOrderPayload
): Promise<SendOutcome> {
  const cod = isCodOrder(order)
  if (!cod && !isPrepaidOrder(order)) return 'skipped_not_cod'
  if (alreadyHandled(order)) return 'skipped_already_handled'
  // Shopify can deliver orders/create more than once; only the first
  // delivery per order sends a message.
  if ((await claimOrderOnce(order.id, 'confirmation_sent')) === 'taken') {
    return 'skipped_already_handled'
  }

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
  let conversationId: string
  try {
    const resolved = await resolveConversationByPhone(
      supabase,
      accountId,
      phone,
      customerFirstName(order)
    )
    conversationId = resolved.conversationId
    let lastErr: unknown = null
    let sent = false
    for (const choice of templateChoices(order, cod)) {
      try {
        await sendMessageToConversation(supabase, accountId, {
          conversationId,
          messageType: 'template',
          contentText: null,
          mediaUrl: null,
          filename: null,
          ...choice,
          interactivePayload: null,
          replyToMessageId: null,
        })
        sent = true
        break
      } catch (err) {
        lastErr = err
        console.warn(`[shopify-cod] template ${choice.templateName} failed, trying next:`, err)
      }
    }
    if (!sent) throw lastErr
  } catch (err) {
    console.error(`[shopify-cod] send failed for order ${order.name ?? order.id}:`, err)
    await updateOrderTags(order.id, [COD_TAGS.sendFailed]).catch(() => {})
    return 'send_failed'
  }

  // Prepaid orders need no reply, so they go straight to Confirmed.
  await updateOrderTags(order.id, [cod ? COD_TAGS.sent : COD_TAGS.confirmed])
  // Remember the chat for later reminders (no protected customer data).
  await setOrderMetafield(order.id, 'conversation_id', conversationId).catch((e) =>
    console.error('[shopify-cod] storing conversation id failed:', e)
  )
  return cod ? 'sent' : 'sent_prepaid'
}

export function appOrigin(): string {
  const explicit = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL
  if (explicit) return explicit.replace(/\/$/, '')
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  return vercel ? `https://${vercel}` : 'https://wacrm-zwrx-1.vercel.app'
}

/** Pay links for an order, or null when Razorpay isn't configured. */
function orderPayLinks(orderId: string) {
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!isAdvanceEnabled() || !secret) return null
  return payLinks(appOrigin(), buildPayToken(orderId, secret))
}

/**
 * The scripted first reply to a button tap. Includes the order's pay
 * links so the customer can act right away and so the AI agent (which
 * reads this text as context) can repeat them.
 */
export function replyText(
  action: 'confirm' | 'cancel' | 'help',
  orderName: string,
  links: { advance: string; full: string } | null
): string {
  const help = `Koi bhi sawaal ho toh humein ${helpline()} par call karein.`
  const pay = links
    ? `\n\n💳 ₹${advanceAmount()} advance (baaki delivery par): ${links.advance}` +
      `\n🚚 Poora payment + FREE shipping: ${links.full}` +
      `\n🔒 Payment Razorpay ke secure page par, Hindrishi ke naam se. Hum kabhi OTP/PIN nahi maangte.`
    : ''
  if (action === 'confirm') {
    return `Dhanyavaad! Aapka order ${orderName} confirm ho gaya hai. Hum ise jaldi dispatch karenge aur tracking link WhatsApp par bhejenge. ${help}`
  }
  if (action === 'help') {
    return (
      `Ji zaroor! Order ${orderName} ke baare mein aap kuch bhi pooch sakte hain — product, use karne ka tareeka, delivery ya payment. ` +
      `Hindi, English ya apni bhasha mein likhiye.${pay}\n\n${help}`
    )
  }
  return (
    `Arre ji, order ${orderName} abhi cancel mat kijiye 🙏 Kya koi pareshani hai — price, delivery time, ya product ko lekar koi doubt? ` +
    `Bataiye, hum abhi solve kar dete hain.\n\n` +
    `Aapke liye: poora payment online karein toh COD charge nahi lagega (FREE shipping) aur aapka order sabse pehle dispatch hoga. ` +
    `Ya sirf ₹${advanceAmount()} advance dekar order confirm kar lijiye.${pay}` +
    `\n\nCancel kyun karna chahte hain? Ek baar wajah bata dijiye.`
  )
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
    } else if (parsed.action === 'help') {
      await updateOrderTags(parsed.orderId, [COD_TAGS.help])
    } else {
      // A cancel tap opens a conversation (the AI agent tries once to save
      // the order); the order is cancelled only if they still insist.
      await updateOrderTags(parsed.orderId, [COD_TAGS.cancelRequested])
    }
  } catch (err) {
    console.error(`[shopify-cod] tagging order ${parsed.orderId} failed:`, err)
  }

  const orderName = await orderNameFor(parsed.orderId)
  // The customer just messaged us, so a free-form reply is inside the
  // 24-hour service window.
  try {
    await sendMessageToConversation(supabaseAdmin(), params.accountId, {
      conversationId: params.conversationId,
      messageType: 'text',
      contentText: replyText(parsed.action, orderName, parsed.action === 'confirm' ? null : orderPayLinks(parsed.orderId)),
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

async function orderNameFor(orderId: string): Promise<string> {
  try {
    const o = await getOrderForAdvance(orderId)
    if (o) return o.name
  } catch {
    // fall through
  }
  return `#${orderId}`
}
