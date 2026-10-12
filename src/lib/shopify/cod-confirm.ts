// ============================================================
// Shopify COD confirmation — pure helpers, no I/O.
//
// Flow: Shopify `orders/create` webhook → we send a WhatsApp template
// with two QUICK_REPLY buttons (Confirm / Cancel) whose payloads carry
// the order id → the customer taps → Meta delivers the tap to our
// WhatsApp webhook with `button.payload` → we tag the Shopify order.
//
// Everything here is deterministic so it can be unit-tested without
// Shopify, Meta or Supabase.
// ============================================================

import crypto from 'node:crypto'

/** Prefix that marks a button payload as ours. */
export const COD_PAYLOAD_PREFIX = 'shopify_cod'

export type CodAction = 'confirm' | 'cancel'

/** Order tags written back to Shopify. */
export const COD_TAGS = {
  sent: 'WA-Sent',
  confirmed: 'WA-Confirmed',
  cancelled: 'WA-Cancelled',
  noPhone: 'WA-No-Phone',
  sendFailed: 'WA-Send-Failed',
} as const

/** Minimal slice of Shopify's order webhook payload that we read. */
export interface ShopifyOrderPayload {
  id: number | string
  name?: string
  total_price?: string
  currency?: string
  financial_status?: string | null
  payment_gateway_names?: string[]
  tags?: string
  phone?: string | null
  line_items?: { title?: string; quantity?: number }[]
  customer?: { first_name?: string | null; phone?: string | null } | null
  shipping_address?: { first_name?: string | null; phone?: string | null } | null
  billing_address?: { first_name?: string | null; phone?: string | null } | null
}

/** `shopify_cod:confirm:1234567890` */
export function buildReplyPayload(action: CodAction, orderId: number | string): string {
  return `${COD_PAYLOAD_PREFIX}:${action}:${orderId}`
}

export function isCodReplyPayload(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(`${COD_PAYLOAD_PREFIX}:`)
}

export function parseReplyPayload(
  value: string | null | undefined
): { action: CodAction; orderId: string } | null {
  if (!isCodReplyPayload(value)) return null
  const [, action, orderId] = value!.split(':')
  if ((action !== 'confirm' && action !== 'cancel') || !/^\d+$/.test(orderId ?? '')) {
    return null
  }
  return { action, orderId }
}

/** Cash-on-delivery orders are the ones worth confirming. */
export function isCodOrder(order: ShopifyOrderPayload): boolean {
  const gateways = order.payment_gateway_names ?? []
  if (gateways.some((g) => /cash on delivery|\bcod\b/i.test(g))) return true
  // Partially-paid / unpaid orders with no gateway are treated as COD too.
  return gateways.length === 0 && order.financial_status === 'pending'
}

export function orderTags(order: ShopifyOrderPayload): string[] {
  return (order.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** True when we already messaged (or resolved) this order — Shopify retries webhooks. */
export function alreadyHandled(order: ShopifyOrderPayload): boolean {
  const tags = orderTags(order).map((t) => t.toLowerCase())
  return [COD_TAGS.sent, COD_TAGS.confirmed, COD_TAGS.cancelled].some((t) =>
    tags.includes(t.toLowerCase())
  )
}

/**
 * Normalise an Indian phone number to E.164 (`+91XXXXXXXXXX`).
 * Accepts 10-digit mobiles, `0`-prefixed, `91`-prefixed and `+91`.
 * Non-Indian numbers that already carry a country code are kept as-is.
 */
export function normalizeIndianPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `+91${digits}`
  if (digits.length === 12 && digits.startsWith('91') && /^[6-9]/.test(digits[2])) {
    return `+${digits}`
  }
  if (digits.length >= 11 && digits.length <= 15 && raw.trim().startsWith('+')) {
    return `+${digits}`
  }
  return null
}

export function extractOrderPhone(order: ShopifyOrderPayload): string | null {
  const candidates = [
    order.shipping_address?.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.phone,
  ]
  for (const c of candidates) {
    const n = normalizeIndianPhone(c)
    if (n) return n
  }
  return null
}

export function customerFirstName(order: ShopifyOrderPayload): string {
  return (
    order.shipping_address?.first_name?.trim() ||
    order.customer?.first_name?.trim() ||
    order.billing_address?.first_name?.trim() ||
    'Customer'
  )
}

/** "Hindrishi Zero Wart (x2) +1 more" — capped so Meta's param limit is safe. */
export function productSummary(order: ShopifyOrderPayload): string {
  const items = (order.line_items ?? []).filter((i) => i.title)
  if (items.length === 0) return 'Your order'
  const first = items[0]
  let text = first.title!.trim()
  if ((first.quantity ?? 1) > 1) text += ` (x${first.quantity})`
  if (items.length > 1) text += ` +${items.length - 1} more`
  return text.length > 60 ? `${text.slice(0, 57)}...` : text
}

export function formatAmount(order: ShopifyOrderPayload): string {
  const n = Number(order.total_price ?? 0)
  if (!Number.isFinite(n)) return String(order.total_price ?? '')
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/**
 * Structured send-time params for the confirmation template:
 *   body {{1}} name · {{2}} order number · {{3}} product · {{4}} amount
 *   button 0 = Confirm, button 1 = Cancel (QUICK_REPLY payload overrides)
 */
export function buildTemplateParams(order: ShopifyOrderPayload) {
  return {
    body: [
      customerFirstName(order),
      (order.name ?? String(order.id)).replace(/^#/, ''),
      productSummary(order),
      formatAmount(order),
    ],
    buttonParams: {
      0: buildReplyPayload('confirm', order.id),
      1: buildReplyPayload('cancel', order.id),
    } as Record<number, string>,
  }
}

/** Verify Shopify's `X-Shopify-Hmac-Sha256` header (base64 HMAC of the raw body). */
export function verifyShopifyHmac(
  rawBody: string,
  header: string | null,
  secret: string | undefined
): boolean {
  if (!secret || !header) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest()
  let received: Buffer
  try {
    received = Buffer.from(header, 'base64')
  } catch {
    return false
  }
  return received.length === expected.length && crypto.timingSafeEqual(received, expected)
}
