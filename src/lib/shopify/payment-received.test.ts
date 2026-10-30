import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/whatsapp/send-message', () => ({ sendMessageToConversation: vi.fn() }))

import { paymentNote, paymentTags, paymentText } from './payment-received'

describe('payment received wording', () => {
  it('advance: clear tags with what to collect', () => {
    expect(paymentTags('advance', 100, 447)).toEqual([
      'WA-Advance-Paid',
      '₹100 Advance Paid',
      'Collect ₹447 on Delivery',
      'WA-Confirmed',
    ])
  })
  it('full: paid online tag', () => {
    expect(paymentTags('full', 498, 0)).toContain('Paid Online (Full)')
  })
  it('note says what to collect', () => {
    expect(paymentNote('advance', 100, 447, 'pay_X')).toMatch(/COLLECT ₹447 ON DELIVERY/)
    expect(paymentNote('full', 498, 0, 'pay_Y')).toMatch(/Nothing to collect/)
  })
  it('customer text', () => {
    const t = paymentText('advance', '#63403', 100, 699)
    expect(t).toContain('₹100 payment mil gaya')
    expect(t).toContain('Baaki ₹699 delivery par')
    expect(paymentText('full', '#1', 498, 0)).toContain('kuch nahi dena')
  })
})
