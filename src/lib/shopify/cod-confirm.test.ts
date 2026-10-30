import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  alreadyHandled,
  buildReplyPayload,
  buildPrepaidTemplateParams,
  buildTemplateParams,
  extractOrderPhone,
  isCodOrder,
  isPrepaidOrder,
  normalizeIndianPhone,
  parseReplyPayload,
  productSummary,
  verifyShopifyHmac,
  type ShopifyOrderPayload,
} from './cod-confirm'

const order: ShopifyOrderPayload = {
  id: 6123456789012,
  name: '#63151',
  total_price: '648.00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  financial_status: 'pending',
  tags: '',
  line_items: [{ title: 'Hindrishi Zero Wart', quantity: 1 }],
  shipping_address: { first_name: 'Ravi', phone: '098765 43210' },
}

describe('reply payloads', () => {
  it('round-trips confirm and cancel', () => {
    expect(parseReplyPayload(buildReplyPayload('confirm', 42))).toEqual({
      action: 'confirm',
      orderId: '42',
    })
    expect(parseReplyPayload(buildReplyPayload('cancel', '7'))).toEqual({
      action: 'cancel',
      orderId: '7',
    })
  })
  it('rejects foreign or malformed payloads', () => {
    expect(parseReplyPayload('Confirm Order')).toBeNull()
    expect(parseReplyPayload('shopify_cod:ship:1')).toBeNull()
    expect(parseReplyPayload('shopify_cod:confirm:abc')).toBeNull()
    expect(parseReplyPayload(null)).toBeNull()
  })
})

describe('normalizeIndianPhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['098765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['919876543210', '+919876543210'],
  ])('%s → %s', (input, out) => {
    expect(normalizeIndianPhone(input)).toBe(out)
  })
  it('rejects junk', () => {
    expect(normalizeIndianPhone('12345')).toBeNull()
    expect(normalizeIndianPhone('')).toBeNull()
  })
  it('prefers the shipping phone', () => {
    expect(extractOrderPhone(order)).toBe('+919876543210')
  })
})

describe('order classification', () => {
  it('detects COD', () => {
    expect(isCodOrder(order)).toBe(true)
    expect(isCodOrder({ ...order, payment_gateway_names: ['Razorpay'], financial_status: 'paid' })).toBe(false)
  })
  it('skips orders already tagged', () => {
    expect(alreadyHandled(order)).toBe(false)
    expect(alreadyHandled({ ...order, tags: 'VIP, WA-Sent' })).toBe(true)
  })
})

describe('template params', () => {
  it('builds body and button payloads', () => {
    const p = buildTemplateParams(order)
    expect(p.body).toEqual(['Ravi', '63151', 'Hindrishi Zero Wart', '648'])
    expect(p.buttonParams[0]).toBe('shopify_cod:confirm:6123456789012')
    expect(p.buttonParams[1]).toBe('shopify_cod:cancel:6123456789012')
  })
  it('summarises multiple items', () => {
    expect(
      productSummary({ ...order, line_items: [{ title: 'A', quantity: 2 }, { title: 'B' }] })
    ).toBe('A (x2) +1 more')
  })
  it('skips COD / handling fee lines', () => {
    expect(
      productSummary({
        ...order,
        line_items: [{ title: 'COD Handling Charge' }, { title: 'Hindrishi Zero Tar Syrup' }],
      })
    ).toBe('Hindrishi Zero Tar Syrup')
    expect(productSummary({ ...order, line_items: [{ title: 'COD Handling Charge' }] })).toBe(
      'COD Handling Charge'
    )
  })
})

describe('verifyShopifyHmac', () => {
  const body = JSON.stringify(order)
  const sig = crypto.createHmac('sha256', 's3cret').update(body).digest('base64')
  it('accepts a valid signature', () => {
    expect(verifyShopifyHmac(body, sig, 's3cret')).toBe(true)
  })
  it('rejects a bad signature or missing secret', () => {
    expect(verifyShopifyHmac(body, sig, 'other')).toBe(false)
    expect(verifyShopifyHmac(body, sig, undefined)).toBe(false)
    expect(verifyShopifyHmac(body, null, 's3cret')).toBe(false)
  })
})

describe('prepaid orders', () => {
  const prepaid: ShopifyOrderPayload = {
    ...order,
    payment_gateway_names: ['Razorpay'],
    financial_status: 'paid',
  }
  it('detects prepaid vs COD', () => {
    expect(isPrepaidOrder(prepaid)).toBe(true)
    expect(isCodOrder(prepaid)).toBe(false)
    expect(isPrepaidOrder(order)).toBe(false)
  })
  it('skips unpaid online orders', () => {
    expect(isPrepaidOrder({ ...prepaid, financial_status: 'pending' })).toBe(false)
  })
  it('builds body-only params', () => {
    expect(buildPrepaidTemplateParams(prepaid)).toEqual({
      body: ['Ravi', '63151', 'Hindrishi Zero Wart', '648'],
    })
  })
})
