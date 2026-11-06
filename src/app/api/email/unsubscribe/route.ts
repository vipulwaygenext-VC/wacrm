import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { normalizeEmail, verifyUnsubscribe } from '@/lib/email/render';

/**
 * Public unsubscribe endpoint for links in CRM emails.
 *
 * GET  shows a confirm page (link scanners in mail servers follow GET
 *      links, so GET alone never unsubscribes anyone).
 * POST unsubscribes — from the confirm button, or from the mail app's
 *      one-click unsubscribe (RFC 8058 List-Unsubscribe-Post).
 */

function parse(url: URL) {
  const accountId = url.searchParams.get('a') ?? '';
  const sig = url.searchParams.get('s') ?? '';
  let email: string | null = null;
  try {
    email = normalizeEmail(
      Buffer.from(url.searchParams.get('e') ?? '', 'base64url').toString('utf8')
    );
  } catch {
    email = null;
  }
  const valid =
    /^[0-9a-f-]{36}$/i.test(accountId) &&
    !!email &&
    verifyUnsubscribe(accountId, email, sig);
  return { accountId, email, valid };
}

function page(title: string, message: string, form?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><meta name="robots" content="noindex"></head><body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f5f7fa;color:#1f2933"><main style="max-width:440px;margin:15vh auto;padding:32px 24px;background:#fff;border-radius:12px;text-align:center"><h1 style="font-size:22px;margin:0 0 12px">${title}</h1><p style="margin:0 0 20px;line-height:1.5">${message}</p>${form ?? ''}</main></body></html>`;
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function mask(email: string): string {
  const [user, domain] = email.split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { email, valid } = parse(url);
  if (!valid || !email) {
    return page(
      'Link not valid',
      'This unsubscribe link is incomplete or has expired.'
    );
  }
  const form = `<form method="post" action="${url.pathname}${url.search}"><button type="submit" style="font-size:16px;padding:12px 24px;border:0;border-radius:8px;background:#1f2933;color:#fff;cursor:pointer">Unsubscribe</button></form>`;
  return page(
    'Unsubscribe?',
    `Stop emails to <strong>${mask(email)}</strong>?`,
    form
  );
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const { accountId, email, valid } = parse(url);
  if (!valid || !email) {
    return page(
      'Link not valid',
      'This unsubscribe link is incomplete or has expired.'
    );
  }
  const { error } = await supabaseAdmin()
    .from('email_unsubscribes')
    .upsert(
      { account_id: accountId, email },
      { onConflict: 'account_id,email', ignoreDuplicates: true }
    );
  if (error) {
    console.error('[email/unsubscribe]', error);
    return NextResponse.json(
      { error: 'Could not unsubscribe, please try again.' },
      { status: 500 }
    );
  }
  return page(
    'You are unsubscribed',
    `We won't email <strong>${mask(email)}</strong> again.`
  );
}
