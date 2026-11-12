import { describe, expect, it } from 'vitest';
import { wantsDispatch } from './dispatch';

describe('wantsDispatch', () => {
  it('only reacts to RTD orders not yet labelled, or SR-Rebook', () => {
    expect(wantsDispatch('WA-Confirmed, RTD')).toBe(true);
    expect(wantsDispatch('rtd')).toBe(true);
    expect(wantsDispatch('RTD, Label-Ready')).toBe(false);
    expect(wantsDispatch('RTD, SR-Error')).toBe(false);
    expect(wantsDispatch('WA-Confirmed')).toBe(false);
    expect(wantsDispatch('RTD, Label-Printed, SR-Rebook')).toBe(true);
    expect(wantsDispatch(null)).toBe(false);
  });
});

import { isOurShiprocketId, nextShiprocketId } from './dispatch';

describe('rebook ids', () => {
  const o = (channel_order_id: string, status = 'CANCELED') =>
    ({
      id: 1,
      channel_order_id,
      payment_method: 'cod',
      total: 0,
      status,
    }) as never;
  it('matches original and rebooked ids', () => {
    expect(isOurShiprocketId('63543', '63543', '99')).toBe(true);
    expect(isOurShiprocketId('#63543', '63543', '99')).toBe(true);
    expect(isOurShiprocketId('63543-R2', '63543', '99')).toBe(true);
    expect(isOurShiprocketId('635430', '63543', '99')).toBe(false);
  });
  it('picks the next free id', () => {
    expect(nextShiprocketId('63543', [], '99')).toBe('63543');
    expect(nextShiprocketId('63543', [o('63543')], '99')).toBe('63543-R1');
    expect(nextShiprocketId('63543', [o('63543'), o('63543-R1')], '99')).toBe(
      '63543-R2'
    );
  });
});
