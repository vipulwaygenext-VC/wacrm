import crypto from 'node:crypto';

/**
 * Email body rendering + unsubscribe links.
 *
 * Bodies are written as plain text in the CRM (one paragraph per blank
 * line). `{{name}}` is replaced with the contact's first name, or
 * "there" when unknown. Every email gets a footer with the sender's
 * business line and a one-click unsubscribe link.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

export function firstName(name: string | null | undefined): string {
  const first = (name ?? '')
    .replace(/^(mr|mrs|ms|miss|dr|m\/s)\.?\s+/i, '')
    .trim()
    .split(/\s+/)[0];
  return first || 'there';
}

export function personalize(
  template: string,
  contactName: string | null | undefined
): string {
  return template.replace(/\{\{\s*name\s*\}\}/gi, firstName(contactName));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text → simple, client-safe HTML (paragraphs + line breaks + links). */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const html = escapeHtml(para)
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 16px 0">${html}</p>`;
    })
    .join('');
}

export interface RenderedEmail {
  html: string;
  text: string;
}

export function renderEmail(opts: {
  body: string;
  contactName: string | null | undefined;
  footerText?: string | null;
  unsubscribeUrl: string;
}): RenderedEmail {
  const body = personalize(opts.body, opts.contactName);
  const footer = opts.footerText?.trim();
  const text = [
    body.trim(),
    '',
    '—',
    ...(footer ? [footer] : []),
    `Unsubscribe: ${opts.unsubscribeUrl}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#ffffff;color:#1f2933;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55"><div style="max-width:600px;margin:0 auto">${textToHtml(body)}<hr style="border:none;border-top:1px solid #e4e7eb;margin:24px 0 12px 0"><p style="margin:0;font-size:12px;color:#52606d">${footer ? `${escapeHtml(footer)}<br>` : ''}Don't want these emails? <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#52606d">Unsubscribe</a>.</p></div></body></html>`;
  return { html, text };
}

// ------------------------------------------------------------------
// Unsubscribe tokens: HMAC(accountId:email), so links can't be forged
// to unsubscribe someone else, and nothing needs storing per send.
// ------------------------------------------------------------------

function unsubscribeSecret(): string {
  const s = process.env.EMAIL_UNSUBSCRIBE_SECRET || process.env.ENCRYPTION_KEY;
  if (!s)
    throw new Error('EMAIL_UNSUBSCRIBE_SECRET or ENCRYPTION_KEY must be set');
  return s;
}

export function unsubscribeSignature(
  accountId: string,
  email: string,
  secret = unsubscribeSecret()
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${accountId}:${email.toLowerCase()}`)
    .digest('base64url')
    .slice(0, 32);
}

export function verifyUnsubscribe(
  accountId: string,
  email: string,
  sig: string,
  secret = unsubscribeSecret()
): boolean {
  const expected = Buffer.from(unsubscribeSignature(accountId, email, secret));
  const given = Buffer.from(sig || '');
  return (
    expected.length === given.length && crypto.timingSafeEqual(expected, given)
  );
}

export function appOrigin(): string {
  const explicit =
    process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : 'http://localhost:3000';
}

export function unsubscribeUrl(
  accountId: string,
  email: string,
  origin = appOrigin()
): string {
  const e = Buffer.from(email.toLowerCase()).toString('base64url');
  const s = unsubscribeSignature(accountId, email);
  return `${origin}/api/email/unsubscribe?a=${accountId}&e=${e}&s=${s}`;
}
