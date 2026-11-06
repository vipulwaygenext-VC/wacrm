import { describe, expect, it } from 'vitest';
import {
  firstName,
  normalizeEmail,
  personalize,
  renderEmail,
  textToHtml,
  unsubscribeSignature,
  unsubscribeUrl,
  verifyUnsubscribe,
} from './render';

const ACC = '08fef154-696e-4dec-a3a9-5ceafca01e62';

describe('normalizeEmail', () => {
  it('lower-cases and trims valid addresses', () => {
    expect(normalizeEmail('  Ravi.K@Example.COM ')).toBe('ravi.k@example.com');
  });
  it('rejects junk', () => {
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });
});

describe('personalize', () => {
  it('uses the first name and drops titles', () => {
    expect(firstName('Mr. Abhinav Goyal')).toBe('Abhinav');
    expect(firstName(null)).toBe('there');
    expect(personalize('Hi {{name}}, hello {{ NAME }}', 'Sunita Rao')).toBe(
      'Hi Sunita, hello Sunita'
    );
  });
});

describe('textToHtml', () => {
  it('escapes HTML, keeps paragraphs and links', () => {
    const html = textToHtml(
      'Hi <b>there</b>\nline two\n\nSee https://hindrishi.com'
    );
    expect(html).toContain('&lt;b&gt;there&lt;/b&gt;<br>line two');
    expect(html).toContain(
      '<a href="https://hindrishi.com">https://hindrishi.com</a>'
    );
    expect(html.match(/<p /g)).toHaveLength(2);
  });
});

describe('renderEmail', () => {
  it('adds the footer and unsubscribe link to both parts', () => {
    const r = renderEmail({
      body: 'Hi {{name}},\n\nThanks!',
      contactName: 'Ravi',
      footerText: 'Boom India Real Estates, Gurugram',
      unsubscribeUrl: 'https://x.test/u',
    });
    expect(r.text).toContain('Hi Ravi,');
    expect(r.text).toContain('Unsubscribe: https://x.test/u');
    expect(r.html).toContain('Boom India Real Estates, Gurugram');
    expect(r.html).toContain('href="https://x.test/u"');
  });
});

describe('unsubscribe tokens', () => {
  const secret = 'test-secret';
  it('verifies its own signature, case-insensitively by email', () => {
    const sig = unsubscribeSignature(ACC, 'Ravi@Example.com', secret);
    expect(verifyUnsubscribe(ACC, 'ravi@example.com', sig, secret)).toBe(true);
  });
  it('rejects another address, account or a tampered signature', () => {
    const sig = unsubscribeSignature(ACC, 'ravi@example.com', secret);
    expect(verifyUnsubscribe(ACC, 'other@example.com', sig, secret)).toBe(
      false
    );
    expect(
      verifyUnsubscribe(
        'cb985c12-aaa4-4b7c-8878-3ed22efa09da',
        'ravi@example.com',
        sig,
        secret
      )
    ).toBe(false);
    expect(
      verifyUnsubscribe(ACC, 'ravi@example.com', sig.slice(0, -1) + 'x', secret)
    ).toBe(false);
    expect(verifyUnsubscribe(ACC, 'ravi@example.com', '', secret)).toBe(false);
  });
  it('builds a link carrying account, encoded email and signature', () => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = secret;
    const url = new URL(
      unsubscribeUrl(ACC, 'ravi@example.com', 'https://crm.test')
    );
    expect(url.pathname).toBe('/api/email/unsubscribe');
    expect(url.searchParams.get('a')).toBe(ACC);
    expect(
      Buffer.from(url.searchParams.get('e')!, 'base64url').toString()
    ).toBe('ravi@example.com');
    expect(
      verifyUnsubscribe(
        ACC,
        'ravi@example.com',
        url.searchParams.get('s')!,
        secret
      )
    ).toBe(true);
  });
});
