import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt } from '@/lib/whatsapp/encryption';
import { BrevoError, validateBrevoKey } from '@/lib/email/brevo';
import { normalizeEmail } from '@/lib/email/render';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * GET /api/email/config — the account's email sender settings. The
 * provider key is never returned, only `has_key`.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('email_configs')
      .select('provider, api_key, from_email, from_name, reply_to, footer_text')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[email/config GET]', error);
      return NextResponse.json(
        { error: 'Failed to load email settings' },
        { status: 500 }
      );
    }
    if (!data) return NextResponse.json({ configured: false });
    const { api_key, ...safe } = data;
    return NextResponse.json({ configured: true, has_key: !!api_key, ...safe });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/email/config (admin+) — save sender settings. The Brevo key
 * is checked with Brevo before it is stored (encrypted). Omit `api_key`
 * to keep the stored one.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `email-config:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) return bad('Invalid request body');

    const fromEmail = normalizeEmail(String(body.from_email ?? ''));
    const fromName = String(body.from_name ?? '').trim();
    const replyToRaw = String(body.reply_to ?? '').trim();
    const replyTo = replyToRaw ? normalizeEmail(replyToRaw) : null;
    const footerText =
      String(body.footer_text ?? '')
        .trim()
        .slice(0, 300) || null;
    const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';

    if (!fromEmail) return bad('Enter a valid sender email');
    if (!fromName) return bad('Enter a sender name');
    if (replyToRaw && !replyTo) return bad('Enter a valid reply-to email');

    const { data: existing } = await supabase
      .from('email_configs')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (!existing && !apiKey) return bad('Enter your Brevo API key');

    const row: Record<string, unknown> = {
      account_id: accountId,
      provider: 'brevo',
      from_email: fromEmail,
      from_name: fromName.slice(0, 100),
      reply_to: replyTo,
      footer_text: footerText,
    };
    if (apiKey) {
      try {
        await validateBrevoKey(apiKey);
      } catch (err) {
        const msg =
          err instanceof BrevoError ? err.message : 'Could not reach Brevo';
        return bad(`Brevo rejected this key: ${msg}`);
      }
      row.api_key = encrypt(apiKey);
    }

    const { error } = existing
      ? await supabase
          .from('email_configs')
          .update(row)
          .eq('account_id', accountId)
      : await supabase
          .from('email_configs')
          .insert({ ...row, created_by: userId });
    if (error) {
      console.error('[email/config POST]', error);
      return NextResponse.json(
        { error: 'Failed to save email settings' },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
