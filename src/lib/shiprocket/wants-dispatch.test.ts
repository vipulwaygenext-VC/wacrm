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
