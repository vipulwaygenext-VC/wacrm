import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  advanceApplies,
  buildPayToken,
  orderIdFromReference,
  parsePayToken,
  remainingAfterAdvance,
  verifyRazorpaySignature,
} from './advance'
import { buildAdvanceTemplateParams, type ShopifyOrderPayload } from './cod-confirm'

const SECRET = 'test_secret'

describe('pay tokens', () => {
  it('round-trips an order id', () => {
    const token = buildPayToken(6123456789012, SECRET)
    expect(parsePayToken(token, SECRET)).toBe('6123456789012')
  })
  it('rejects tampered or foreign tokens', () => {
    const token = buildPayToken(6123456789012, SECRET)
    expect(parsePayToken(token.replace('6123', '6124'), SECRET)).toBeNull()
    expect(parsePayToken(token, 'other_secret')).toBeNull()
    expect(parsePayToken('done', SECRET)).toBeNull()
    expect(parsePayToken('123-zz', SECRET)).toBeNull()
  })
})

describe('advance amounts', () => {
  it('applies only above the advance', () => {
    expect(advanceApplies(648, 100)).toBe(true)
    expect(advanceApplies(100, 100)).toBe(false)
  })
  it('computes the amount due on delivery', () => {
    expect(remainingAfterAdvance(648, 100)).toBe('548')
    expect(remainingAfterAdvance(648.5, 100)).toBe('548.50')
  })
})

describe('razorpay webhook signature', () => {
  it('accepts a valid signature and rejects others', () => {
    const body = '{"event":"payment_link.paid"}'
    const sig = crypto.createHmac('sha256', 'whsec').update(body).digest('hex')
    expect(verifyRazorpaySignature(body, sig, 'whsec')).toBe(true)
    expect(verifyRazorpaySignature(body, sig, 'other')).toBe(false)
    expect(verifyRazorpaySignature(body, null, 'whsec')).toBe(false)
  })
})

describe('reference ids', () => {
  it('extracts the order id, including retried links', () => {
    expect(orderIdFromReference('shopify_42')).toBe('42')
    expect(orderIdFromReference('shopify_42_1730000000000')).toBe('42')
    expect(orderIdFromReference('something_else')).toBeNull()
  })
})

describe('advance template params', () => {
  const order: ShopifyOrderPayload = {
    id: 42,
    name: '#63151',
    total_price: '648.00',
    line_items: [{ title: 'Hindrishi Zero Wart', quantity: 1 }],
    shipping_address: { first_name: 'Ravi', phone: '9876543210' },
  }
  it('adds the remaining amount and the URL button suffix', () => {
    const p = buildAdvanceTemplateParams(order, '548', 'tok')
    expect(p.body).toEqual(['Ravi', '63151', 'Hindrishi Zero Wart', '648', '548'])
    expect(p.buttonParams[0]).toBe('shopify_cod:confirm:42')
    expect(p.buttonParams[1]).toBe('shopify_cod:cancel:42')
    expect(p.buttonParams[2]).toBe('tok')
  })
})
