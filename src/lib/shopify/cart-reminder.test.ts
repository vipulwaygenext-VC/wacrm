import { describe, expect, it } from 'vitest';
import {
  cartFirstName,
  cartImageUrl,
  cartProduct,
  isQuietHour,
  istHour,
  recoverySuffix,
} from './cart-reminder';

describe('cart reminder helpers', () => {
  it('uses the first word of the name, capitalised', () => {
    expect(cartFirstName('durgesh patel')).toBe('Durgesh');
    expect(cartFirstName(null)).toBe('Customer');
    expect(cartFirstName('  ')).toBe('Customer');
  });

  it('shortens product titles and counts extra items', () => {
    expect(
      cartProduct([
        'Hindrishi Zero Tar Syrup – Ayurvedic Lungs Detox for Smokers & Pollution (150 ml)',
      ])
    ).toBe('Hindrishi Zero Tar Syrup');
    expect(
      cartProduct([
        'Hindrishi Zero Wart – Herbal Wart Remover Solution (5 ml)',
        'Liv Revive',
      ])
    ).toBe('Hindrishi Zero Wart +1 more');
    expect(cartProduct([])).toBe('aapka product');
  });

  it('turns the recovery link into the URL-button suffix', () => {
    const url =
      'https://www.hindrishi.com/29141499956/checkouts/ac/hWNJ0zdYm4SJ/recover?key=3b5e&locale=en-IN';
    expect(recoverySuffix(url, 'www.hindrishi.com')).toBe(
      '29141499956/checkouts/ac/hWNJ0zdYm4SJ/recover?key=3b5e&locale=en-IN'
    );
    expect(
      recoverySuffix('https://hindrishi.myshopify.com/x', 'www.hindrishi.com')
    ).toBeNull();
    expect(recoverySuffix('not a url', 'www.hindrishi.com')).toBeNull();
  });

  it('keeps quiet between 22:00 and 08:00 IST', () => {
    expect(istHour(new Date('2026-11-11T07:00:00Z'))).toBe(12);
    expect(isQuietHour(new Date('2026-11-11T07:00:00Z'))).toBe(false); // 12:30 IST
    expect(isQuietHour(new Date('2026-11-11T17:00:00Z'))).toBe(true); // 22:30 IST
    expect(isQuietHour(new Date('2026-11-11T02:00:00Z'))).toBe(true); // 07:30 IST
    expect(isQuietHour(new Date('2026-11-11T01:00:00Z'))).toBe(true); // 06:30 IST
    expect(isQuietHour(new Date('2026-11-11T02:45:00Z'))).toBe(false); // 08:15 IST
  });
});

describe('cartImageUrl', () => {
  it('points at the logo image generator', () => {
    const img = 'https://cdn.shopify.com/s/files/1/x.jpg?v=1';
    expect(cartImageUrl(img, 'https://crm.test')).toBe(
      'https://crm.test/api/og/cart-image?src=' + encodeURIComponent(img)
    );
  });
});
