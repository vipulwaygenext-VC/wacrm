import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { normalizeEmail } from '@/lib/email/render';
import {
  loadEmailConfig,
  MAX_RECIPIENTS_PER_SEND,
  sendEmails,
  type Recipient,
} from '@/lib/email/send';

export const maxDuration = 60;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

interface SendBody {
  /** 'contacts' = the listed contact ids, 'tag' = every contact with the tag, 'test' = one address. */
  mode?: 'contacts' | 'tag' | 'test';
  contact_ids?: string[];
  tag_id?: string;
  test_email?: string;
  subject?: string;
  body?: string;
  /** true = only count recipients, send nothing. */
  dry_run?: boolean;
}

/**
 * POST /api/email/send (agent+)
 *
 * Sends an email to contacts of the caller's account through the
 * account's Brevo settings. Unsubscribed and invalid addresses are
 * skipped; every recipient is logged in email_messages.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`email-send:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) return rateLimitResponse(limit);

    const input = (await request.json().catch(() => null)) as SendBody | null;
    if (!input) return bad('Invalid request body');
    const subject = (input.subject ?? '').trim();
    const body = (input.body ?? '').trim();
    if (!input.dry_run) {
      if (!subject) return bad('Add a subject');
      if (!body) return bad('Write the email');
    }

    // Resolve recipients with the caller's RLS-scoped client, so only
    // this account's contacts can ever be addressed.
    let recipients: Recipient[] = [];
    if (input.mode === 'test') {
      const email = normalizeEmail(input.test_email);
      if (!email) return bad('Enter a valid test email');
      recipients = [{ contactId: null, email, name: null }];
    } else if (input.mode === 'tag') {
      if (!input.tag_id) return bad('Pick a tag');
      const { data: tag } = await supabase
        .from('tags')
        .select('id')
        .eq('id', input.tag_id)
        .eq('account_id', accountId)
        .maybeSingle();
      if (!tag) return bad('Tag not found', 404);
      const { data, error } = await supabase
        .from('contact_tags')
        .select('contacts!inner(id, name, email, account_id)')
        .eq('tag_id', input.tag_id)
        .eq('contacts.account_id', accountId)
        .limit(5000);
      if (error) {
        console.error('[email/send] tag lookup', error);
        return bad('Could not load contacts for this tag', 500);
      }
      recipients = (data ?? []).map((row) => {
        const c = row.contacts as unknown as {
          id: string;
          name: string | null;
          email: string | null;
        };
        return { contactId: c.id, email: c.email, name: c.name };
      });
    } else if (input.mode === 'contacts') {
      const ids = (input.contact_ids ?? [])
        .filter((x) => typeof x === 'string')
        .slice(0, 5000);
      if (!ids.length) return bad('Pick at least one contact');
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, email')
        .eq('account_id', accountId)
        .in('id', ids);
      if (error) {
        console.error('[email/send] contact lookup', error);
        return bad('Could not load contacts', 500);
      }
      recipients = (data ?? []).map((c) => ({
        contactId: c.id,
        email: c.email,
        name: c.name,
      }));
    } else {
      return bad('Unknown mode');
    }

    const withEmail = recipients.filter((r) => normalizeEmail(r.email)).length;
    if (input.dry_run) {
      return NextResponse.json({
        total: recipients.length,
        with_email: withEmail,
        max: MAX_RECIPIENTS_PER_SEND,
      });
    }
    if (withEmail === 0)
      return bad('None of these contacts has an email address');
    if (withEmail > MAX_RECIPIENTS_PER_SEND) {
      return bad(
        `That's ${withEmail} emails — the limit is ${MAX_RECIPIENTS_PER_SEND} per send (Brevo's free daily allowance). Use a smaller tag.`
      );
    }

    const admin = supabaseAdmin();
    const config = await loadEmailConfig(admin, accountId);
    if (!config) return bad('Set up email first in Settings → Email');

    const summary = await sendEmails({
      db: admin,
      accountId,
      userId,
      config,
      recipients,
      subject,
      body,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return toErrorResponse(err);
  }
}
