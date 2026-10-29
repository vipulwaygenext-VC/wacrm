// ============================================================
// Optional ₹100 advance on COD orders — pure helpers, no I/O.
//
// The COD confirmation template gets a third, URL button
// ("Pay ₹100 Advance") pointing at /pay/<token>. The token carries the
// Shopify order id plus a short HMAC so nobody can guess or tamper with
// another customer's link. /pay/<token> creates (or reuses) a Razorpay
// Payment Link for that order and redirects to Razorpay's hosted page.
//
// Env:
//   RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET   turn the feature on
//   RAZORPAY_WEBHOOK_SECRET                 verifies payment_link.paid
//   SHOPIFY_ADVANCE_AMOUNT                  rupees, default 100
//   SHOPIFY_COD_ADVANCE_TEMPLATE_NAME       default cod_order_advance
// ============================================================

import crypto from 'node:crypto'

export const ADVANCE_TAG = 'WA-Advance-Paid'
export const DEFAULT_ADVANCE_AMOUNT = 100

export function advanceAmount(): number {
  const n = Number(process.env.SHOPIFY_ADVANCE_AMOUNT)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_ADVANCE_AMOUNT
}

export function isAdvanceEnabled(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
}

export function advanceTemplateName(): string {
  return process.env.SHOPIFY_COD_ADVANCE_TEMPLATE_NAME || 'cod_order_advance'
}

/** Advance only makes sense when the order costs more than the advance. */
export function advanceApplies(orderTotal: number, amount = advanceAmount()): boolean {
  return Number.isFinite(orderTotal) && orderTotal > amount
}

/** Rupees left to collect on delivery, formatted like the order total. */
export function remainingAfterAdvance(orderTotal: number, amount = advanceAmount()): string {
  const rest = Math.max(0, orderTotal - amount)
  return Number.isInteger(rest) ? String(rest) : rest.toFixed(2)
}

function sign(orderId: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(`advance:${orderId}`).digest('hex').slice(0, 16)
}

/** `6123456789012-1a2b3c4d5e6f7a8b` */
export function buildPayToken(orderId: number | string, secret: string): string {
  const id = String(orderId)
  return `${id}-${sign(id, secret)}`
}

export function parsePayToken(token: string, secret: string): string | null {
  const match = /^(\d+)-([0-9a-f]{16})$/.exec(token)
  if (!match) return null
  const [, id, mac] = match
  const expected = Buffer.from(sign(id, secret))
  const received = Buffer.from(mac)
  return received.length === expected.length && crypto.timingSafeEqual(received, expected)
    ? id
    : null
}

/** Razorpay webhooks sign the raw body with HMAC-SHA256 (hex). */
export function verifyRazorpaySignature(
  rawBody: string,
  header: string | null,
  secret: string | undefined
): boolean {
  if (!secret || !header) return false
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  )
  const received = Buffer.from(header)
  return received.length === expected.length && crypto.timingSafeEqual(received, expected)
}

/** Razorpay's reference_id for an order's advance link (unique per order). */
export function advanceReferenceId(orderId: number | string): string {
  return `shopify_${orderId}`
}

export function orderIdFromReference(ref: string | null | undefined): string | null {
  const m = /^shopify_(\d+)(?:_\d+)?$/.exec(ref ?? '')
  return m ? m[1] : null
}
