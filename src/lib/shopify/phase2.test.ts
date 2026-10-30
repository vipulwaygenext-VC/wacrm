import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { buildPayToken, orderIdFromReference, advanceReferenceId } from './advance'
import {
  buildPrepayTemplateParams,
  parseReplyPayload,
  shippingTotal,
  type ShopifyOrderPayload,
} from './cod-confirm'
import { CANCEL_SENTINEL, extractCancel, orderIdFromTexts } from './chat-actions'
import { classifyDelay } from './delay-reminder'
import { replyText, templateChoices } from './cod-service'
import { isGeminiTarget } from '../ai/providers/openai'

const SECRET = 'test_secret'

const order: ShopifyOrderPayload = {
  id: 42,
  name: '#63151',
  total_price: '697.00',
  line_items: [{ title: 'Hindrishi Zero Wart', quantity: 1 }],
  shipping_lines: [{ title: 'Cash on Delivery Charge', price: '49.00' }],
  shipping_address: { first_name: 'Ravi', phone: '9876543210' },
}

describe('prepay template params', () => {
  it('fills six body params and four buttons in order', () => {
    const p = buildPrepayTemplateParams(order, '597', 'tok')
    expect(p.body).toEqual(['Ravi', '63151', 'Hindrishi Zero Wart', '697', '597', '648'])
    expect(p.buttonParams).toEqual({
      0: 'tok',
      1: 'tok',
      2: 'shopify_cod:help:42',
      3: 'shopify_cod:cancel:42',
    })
  })
  it('sums shipping lines', () => {
    expect(shippingTotal(order)).toBe(49)
    expect(shippingTotal({ id: 1 })).toBe(0)
  })
  it('parses the help payload', () => {
    expect(parseReplyPayload('shopify_cod:help:42')).toEqual({ action: 'help', orderId: '42' })
  })
})

describe('full-payment references', () => {
  it('round-trips the order id', () => {
    expect(advanceReferenceId(42, 'full')).toBe('shopify_42_full')
    expect(orderIdFromReference('shopify_42_full')).toBe('42')
    expect(orderIdFromReference('shopify_42_full_1730000000000')).toBe('42')
  })
})

describe('chat actions', () => {
  it('reads the order from the newest signed pay link only', () => {
    const good = buildPayToken(42, SECRET)
    const texts = [
      `Pay here https://x.app/pay/f/${good}`,
      'older text https://x.app/pay/99-0000000000000000',
    ]
    expect(orderIdFromTexts(texts, SECRET)).toBe('42')
    expect(orderIdFromTexts(['https://x.app/pay/99-0000000000000000'], SECRET)).toBeNull()
    expect(orderIdFromTexts(['no links here'], SECRET)).toBeNull()
  })
  it('strips the cancel sentinel', () => {
    expect(extractCancel(`Theek hai. ${CANCEL_SENTINEL}`)).toEqual({ text: 'Theek hai.', cancel: true })
    expect(extractCancel('Hello')).toEqual({ text: 'Hello', cancel: false })
  })
})

describe('delay reminder classification', () => {
  it('splits paid, unpaid and cancelled orders', () => {
    expect(classifyDelay({ tags: ['WA-Sent'], outstanding: 697 })).toBe('unpaid')
    expect(classifyDelay({ tags: ['WA-Advance-Paid'], outstanding: 597 })).toBe('paid')
    expect(classifyDelay({ tags: [], outstanding: 0 })).toBe('paid')
    expect(classifyDelay({ tags: ['WA-Cancel-Requested'], outstanding: 697 })).toBe('skip')
  })
})

describe('button replies', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test'
    process.env.RAZORPAY_KEY_SECRET = SECRET
  })
  afterEach(() => {
    process.env = { ...env }
  })
  it('tries the prepay template first, then older ones', () => {
    const names = templateChoices(order, true).map((c) => c.templateName)
    expect(names).toEqual(['cod_order_prepay', 'cod_order_advance', 'cod_order_confirmation'])
    expect(templateChoices(order, false).map((c) => c.templateName)).toEqual(['prepaid_order_confirmation'])
  })
  it('cancel reply asks why and offers both payments', () => {
    const t = replyText('cancel', '#63151', { advance: 'https://a/pay/x', full: 'https://a/pay/f/x' })
    expect(t).toContain('#63151')
    expect(t).toContain('https://a/pay/x')
    expect(t).toContain('https://a/pay/f/x')
    expect(t).toContain("kyun")
    expect(t).not.toContain("\"cancel\" likh")
  })
})

describe('gemini routing', () => {
  it('detects gemini models or keys', () => {
    expect(isGeminiTarget('gemini-flash-latest', 'sk-x')).toBe(true)
    expect(isGeminiTarget('gpt-5.4-mini', 'AIzaXYZ')).toBe(true)
    expect(isGeminiTarget('gpt-5.4-mini', 'sk-x')).toBe(false)
  })
})
