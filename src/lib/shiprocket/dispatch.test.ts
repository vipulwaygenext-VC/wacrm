import { describe, expect, it } from 'vitest';
import { amountDue, buildShiprocketPayload, orderRef } from './dispatch';
import { chooseCourier } from './client';

const order = {
  id: '6123',
  name: '#63403',
  createdAt: '2026-11-12T06:30:00Z',
  cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: [],
  email: null,
  total: 647,
  outstanding: 647,
  shipping: 49,
  discount: 0,
  advanceUnrecorded: 0,
  address: {
    firstName: 'Ravi',
    lastName: 'Kumar',
    address1: '12 MG Road',
    address2: null,
    city: 'Jaipur',
    province: 'Rajasthan',
    zip: '302001',
    country: 'India',
    phone: '+91 98765 43210',
  },
  items: [{ name: 'Hindrishi Zero Wart', sku: 'ZW5', quantity: 1, price: 598 }],
  awb: null,
};

describe('amountDue', () => {
  it('subtracts an advance Shopify could not record', () => {
    expect(amountDue({ outstanding: 647, advanceUnrecorded: 100 })).toBe(547);
    expect(amountDue({ outstanding: 0, advanceUnrecorded: 0 })).toBe(0);
    expect(amountDue({ outstanding: 50, advanceUnrecorded: 100 })).toBe(0);
  });
});

describe('buildShiprocketPayload', () => {
  it('COD collects only the balance', () => {
    const p = buildShiprocketPayload(order, 'Primary', 547);
    expect(p).toMatchObject({
      order_id: '63403',
      order_date: '2026-11-12 12:00',
      payment_method: 'COD',
      sub_total: 547,
      total_discount: 100,
      billing_phone: '9876543210',
      billing_pincode: '302001',
      pickup_location: 'Primary',
    });
  });
  it('fully paid orders ship prepaid', () => {
    const p = buildShiprocketPayload(
      { ...order, outstanding: 0 },
      'Primary',
      0
    );
    expect(p).toMatchObject({ payment_method: 'Prepaid', sub_total: 647 });
  });
  it('keeps the channel order id when updating a synced order', () => {
    expect(buildShiprocketPayload(order, 'Primary', 0, '#63403').order_id).toBe(
      '#63403'
    );
    expect(orderRef('#63403')).toBe('63403');
  });
});

describe('chooseCourier', () => {
  const couriers = [
    { courier_company_id: 1, courier_name: 'A', rate: 80, etd_hours: 72 },
    { courier_company_id: 2, courier_name: 'B', rate: 60, etd_hours: 96 },
    { courier_company_id: 3, courier_name: 'C', rate: 95, etd_hours: 48 },
  ];
  it('follows the rule', () => {
    expect(chooseCourier(couriers, 1, 'recommended')?.courier_name).toBe('A');
    expect(chooseCourier(couriers, 1, 'cheapest')?.courier_name).toBe('B');
    expect(chooseCourier(couriers, 1, 'fastest')?.courier_name).toBe('C');
    expect(chooseCourier(couriers, 99, 'recommended')?.courier_name).toBe('A');
    expect(chooseCourier([], 1)).toBeNull();
  });
});
