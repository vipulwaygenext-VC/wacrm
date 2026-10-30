// ============================================================
// Minimal Razorpay Payment Links client (REST, Basic auth).
// Docs: https://razorpay.com/docs/api/payments/payment-links/
// ============================================================

const API = 'https://api.razorpay.com/v1'

export class RazorpayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

export interface PaymentLink {
  id: string
  short_url: string
  status: 'created' | 'partially_paid' | 'paid' | 'expired' | 'cancelled'
  reference_id?: string
}

function authHeader(): string {
  const id = process.env.RAZORPAY_KEY_ID
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!id || !secret) throw new RazorpayError('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured')
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const json = (await res.json().catch(() => null)) as T & { error?: { description?: string } }
  if (!res.ok) {
    throw new RazorpayError(
      `Razorpay ${res.status}: ${json?.error?.description ?? 'request failed'}`,
      res.status
    )
  }
  return json
}

export async function findPaymentLinkByReference(referenceId: string): Promise<PaymentLink | null> {
  const data = await call<{ payment_links?: PaymentLink[] }>(
    `/payment_links?reference_id=${encodeURIComponent(referenceId)}`
  )
  const links = data.payment_links ?? []
  return links.find((l) => l.status !== 'cancelled' && l.status !== 'expired') ?? links[0] ?? null
}

/**
 * Create the advance link for an order, or return the existing one —
 * reference_id is unique per link, so a second tap reuses the first link.
 */
export async function getOrCreatePaymentLink(params: {
  referenceId: string
  amountRupees: number
  description: string
  customerName?: string
  customerPhone?: string
  callbackUrl?: string
  notes?: Record<string, string>
}): Promise<PaymentLink> {
  const existing = await findPaymentLinkByReference(params.referenceId).catch(() => null)
  if (existing && existing.status !== 'cancelled' && existing.status !== 'expired') return existing

  return call<PaymentLink>('/payment_links', {
    method: 'POST',
    body: JSON.stringify({
      amount: Math.round(params.amountRupees * 100),
      currency: 'INR',
      accept_partial: false,
      reference_id: existing ? `${params.referenceId}_${Date.now()}` : params.referenceId,
      description: params.description.slice(0, 2048),
      // Razorpay rejects an empty customer object ("faulty key: customer"),
      // so only send it when there is something in it.
      ...(params.customerName || params.customerPhone
        ? {
            customer: {
              ...(params.customerName ? { name: params.customerName } : {}),
              ...(params.customerPhone ? { contact: params.customerPhone } : {}),
            },
          }
        : {}),
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: params.notes ?? {},
      ...(params.callbackUrl ? { callback_url: params.callbackUrl, callback_method: 'get' } : {}),
    }),
  })
}
