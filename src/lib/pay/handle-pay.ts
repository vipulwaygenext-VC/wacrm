// ============================================================
// Shared handler for the WhatsApp pay buttons:
//   GET /pay/<token>     ₹100 advance, rest on delivery
//   GET /pay/f/<token>   full payment with free shipping (the order's
//                        shipping / COD charge is waived)
//   GET /pay/done        Razorpay's callback → thank-you page
//
// Verifies the signed token, looks the order up in Shopify, then
// creates (or reuses) a Razorpay Payment Link and redirects to
// Razorpay's hosted checkout.
// ============================================================

import { NextResponse } from 'next/server'
import {
  ADVANCE_TAG,
  FULL_PAID_TAG,
  type PayKind,
  advanceAmount,
  advanceApplies,
  advanceReferenceId,
  parsePayToken,
} from '@/lib/shopify/advance'
import { ShopifyApiError, getOrderForAdvance } from '@/lib/shopify/admin-api'
import { RazorpayError, getOrCreatePaymentLink } from '@/lib/razorpay/payment-links'

const HELPLINE = process.env.SHOPIFY_HELPLINE_NUMBER || '9278142142'

function page(title: string, message: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f7f5;color:#1f2a1f;margin:0;
display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:14px;padding:28px 24px;max-width:420px;text-align:center;
box-shadow:0 2px 12px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 10px}p{line-height:1.5;margin:0 0 8px}
a{color:#1f6f43}</style></head><body><div class="card"><h1>${title}</h1>${message}
<p>Koi sawaal? Call karein <a href="tel:+91${HELPLINE}">${HELPLINE}</a></p></div></body></html>`
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

export async function handlePay(request: Request, token: string, kind: PayKind) {
  if (token === 'done') {
    const url = new URL(request.url)
    const ok = url.searchParams.get('razorpay_payment_link_status') === 'paid'
    return ok
      ? page('Payment mil gaya ✅', '<p>Dhanyavaad! Aapka payment mil gaya hai aur order confirm ho gaya hai. Hum jaldi dispatch karenge.</p>')
      : page('Payment complete nahi hua', '<p>Agar paise kat gaye hain toh chinta na karein — woh apne aap wapas aa jayenge ya order mein jud jayenge.</p>')
  }

  const secret = process.env.RAZORPAY_KEY_SECRET
  const orderId = secret ? parsePayToken(token, secret) : null
  if (!orderId) return page('Link sahi nahi hai', '<p>Yeh payment link valid nahi hai.</p>', 404)

  try {
    const order = await getOrderForAdvance(orderId)
    if (!order) return page('Order nahi mila', '<p>Yeh order cancel ho chuka hai ya mil nahi raha.</p>', 404)
    if (order.tags.includes(FULL_PAID_TAG) || order.outstanding <= 0) {
      return page('Payment pehle hi mil chuka hai ✅', '<p>Is order ka payment already ho chuka hai.</p>')
    }
    let amount: number
    if (kind === 'full') {
      // Free shipping: everything still due except the shipping / COD charge.
      // Minus any ₹100 advance already paid that Shopify couldn't record.
      amount =
        Math.round((order.outstanding - order.shipping - order.advanceUnrecorded) * 100) / 100
      if (amount < 1) {
        return page('Payment pehle hi mil chuka hai ✅', '<p>Is order par kuch baaki nahi hai.</p>')
      }
    } else {
      if (order.tags.includes(ADVANCE_TAG)) {
        return page('Advance pehle hi mil chuka hai ✅', '<p>Is order ka advance already pay ho chuka hai.</p>')
      }
      amount = advanceAmount()
      if (!advanceApplies(order.outstanding, amount)) {
        return page('Advance ki zarurat nahi', '<p>Is order par advance lagu nahi hota.</p>')
      }
    }

    const link = await getOrCreatePaymentLink({
      referenceId: advanceReferenceId(orderId, kind),
      amountRupees: amount,
      description:
        kind === 'full'
          ? `Hindrishi order ${order.name} — full payment (free shipping)`
          : `Advance for Hindrishi order ${order.name} (rest on delivery)`,
      callbackUrl: `${new URL(request.url).origin}/pay/done`,
      notes: { shopify_order_id: orderId, shopify_order_name: order.name, kind },
    })
    if (link.status === 'paid') {
      return page('Payment pehle hi mil chuka hai ✅', '<p>Is order ka payment already ho chuka hai.</p>')
    }
    return NextResponse.redirect(link.short_url, 302)
  } catch (err) {
    console.error('[pay] advance link failed:', err)
    // A short, non-secret code so support can tell where it failed.
    // Razorpay's own description (never contains secrets) helps fix
    // account/config problems without digging through logs.
    const detail =
      err instanceof RazorpayError
        ? ` · ${err.message.replace(/^Razorpay \d+:\s*/, '').replace(/[<>&"]/g, '').slice(0, 140)}`
        : ''
    const code =
      (err instanceof RazorpayError ? `R${err.status ?? ''}` :
      err instanceof ShopifyApiError ? 'S' : 'X') + detail
    return page(
      'Thodi der baad try karein',
      `<p>Abhi payment page khul nahi raha.</p><p style="color:#8a8f8a;font-size:12px">Code: ${code}</p>`,
      502
    )
  }
}
