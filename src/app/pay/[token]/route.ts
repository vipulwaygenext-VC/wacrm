// ============================================================
// GET /pay/<token> — the "Pay ₹100 Advance" WhatsApp button lands here.
//
// Verifies the signed token, looks the order up in Shopify, then
// creates (or reuses) a Razorpay Payment Link and redirects to
// Razorpay's hosted checkout. GET /pay/done is Razorpay's callback
// after payment and shows a short thank-you page.
// ============================================================

import { NextResponse } from 'next/server'
import {
  ADVANCE_TAG,
  advanceAmount,
  advanceApplies,
  advanceReferenceId,
  parsePayToken,
} from '@/lib/shopify/advance'
import { getOrderForAdvance } from '@/lib/shopify/admin-api'
import { normalizeIndianPhone } from '@/lib/shopify/cod-confirm'
import { getOrCreatePaymentLink } from '@/lib/razorpay/payment-links'

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (token === 'done') {
    const url = new URL(request.url)
    const ok = url.searchParams.get('razorpay_payment_link_status') === 'paid'
    return ok
      ? page('Payment mil gaya ✅', '<p>Dhanyavaad! Aapka advance mil gaya hai. Baaki amount delivery par dena hoga.</p>')
      : page('Payment complete nahi hua', '<p>Agar paise kat gaye hain toh chinta na karein — woh apne aap wapas aa jayenge ya order mein jud jayenge.</p>')
  }

  const secret = process.env.RAZORPAY_KEY_SECRET
  const orderId = secret ? parsePayToken(token, secret) : null
  if (!orderId) return page('Link sahi nahi hai', '<p>Yeh payment link valid nahi hai.</p>', 404)

  try {
    const order = await getOrderForAdvance(orderId)
    if (!order) return page('Order nahi mila', '<p>Yeh order cancel ho chuka hai ya mil nahi raha.</p>', 404)
    if (order.tags.includes(ADVANCE_TAG)) {
      return page('Advance pehle hi mil chuka hai ✅', '<p>Is order ka advance already pay ho chuka hai.</p>')
    }
    const amount = advanceAmount()
    if (!advanceApplies(order.outstanding, amount)) {
      return page('Advance ki zarurat nahi', '<p>Is order par advance lagu nahi hota.</p>')
    }

    const phone = normalizeIndianPhone(order.phone)
    const link = await getOrCreatePaymentLink({
      referenceId: advanceReferenceId(orderId),
      amountRupees: amount,
      description: `Advance for Hindrishi order ${order.name} (rest on delivery)`,
      customerName: order.firstName ?? undefined,
      customerPhone: phone ?? undefined,
      callbackUrl: `${new URL(request.url).origin}/pay/done`,
      notes: { shopify_order_id: orderId, shopify_order_name: order.name },
    })
    if (link.status === 'paid') {
      return page('Advance pehle hi mil chuka hai ✅', '<p>Is order ka advance already pay ho chuka hai.</p>')
    }
    return NextResponse.redirect(link.short_url, 302)
  } catch (err) {
    console.error('[pay] advance link failed:', err)
    return page('Thodi der baad try karein', '<p>Abhi payment page khul nahi raha.</p>', 502)
  }
}
