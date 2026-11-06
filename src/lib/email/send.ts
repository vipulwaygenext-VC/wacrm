import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import { BrevoError, sendBrevoEmail } from './brevo';
import { normalizeEmail, renderEmail, unsubscribeUrl } from './render';

/** Brevo's free plan allows 300 emails a day; one send never exceeds it. */
export const MAX_RECIPIENTS_PER_SEND = 300;
const CONCURRENCY = 5;

export interface EmailConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  replyTo: string | null;
  footerText: string | null;
}

export async function loadEmailConfig(
  db: SupabaseClient,
  accountId: string
): Promise<EmailConfig | null> {
  const { data } = await db
    .from('email_configs')
    .select('api_key, from_email, from_name, reply_to, footer_text')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!data) return null;
  return {
    apiKey: decrypt(data.api_key),
    fromEmail: data.from_email,
    fromName: data.from_name,
    replyTo: data.reply_to,
    footerText: data.footer_text,
  };
}

export interface Recipient {
  contactId: string | null;
  email: string | null;
  name: string | null;
}

export interface SendSummary {
  batchId: string;
  sent: number;
  failed: number;
  skipped: number;
  /** First provider error, so the UI can say why sends failed. */
  firstError?: string;
}

/**
 * Send one email per recipient, skipping invalid / missing addresses
 * and anyone on the account's unsubscribe list, and log every row to
 * `email_messages`. `db` must be the service-role client.
 */
export async function sendEmails(opts: {
  db: SupabaseClient;
  accountId: string;
  userId: string;
  config: EmailConfig;
  recipients: Recipient[];
  subject: string;
  body: string;
}): Promise<SendSummary> {
  const { db, accountId, userId, config, subject, body } = opts;
  const batchId = crypto.randomUUID();
  const summary: SendSummary = { batchId, sent: 0, failed: 0, skipped: 0 };

  // De-duplicate by address; keep the first contact seen.
  const seen = new Set<string>();
  const queue: Array<Recipient & { normalized: string | null }> = [];
  for (const r of opts.recipients) {
    const normalized = normalizeEmail(r.email);
    if (normalized && seen.has(normalized)) continue;
    if (normalized) seen.add(normalized);
    queue.push({ ...r, normalized });
  }

  const { data: unsubRows } = await db
    .from('email_unsubscribes')
    .select('email')
    .eq('account_id', accountId)
    .in('email', [...seen].length ? [...seen] : ['__none__']);
  const unsubscribed = new Set(
    (unsubRows ?? []).map((r: { email: string }) => r.email)
  );

  const rows: Record<string, unknown>[] = [];
  const base = {
    account_id: accountId,
    batch_id: batchId,
    subject,
    sent_by: userId,
  };

  const work = queue.map((r) => async () => {
    if (!r.normalized) {
      summary.skipped++;
      rows.push({
        ...base,
        contact_id: r.contactId,
        to_email: r.email?.trim() || '(none)',
        status: 'skipped',
        skip_reason: r.email ? 'invalid_email' : 'no_email',
      });
      return;
    }
    if (unsubscribed.has(r.normalized)) {
      summary.skipped++;
      rows.push({
        ...base,
        contact_id: r.contactId,
        to_email: r.normalized,
        status: 'skipped',
        skip_reason: 'unsubscribed',
      });
      return;
    }
    const unsub = unsubscribeUrl(accountId, r.normalized);
    const rendered = renderEmail({
      body,
      contactName: r.name,
      footerText: config.footerText,
      unsubscribeUrl: unsub,
    });
    try {
      const messageId = await sendBrevoEmail({
        apiKey: config.apiKey,
        from: { email: config.fromEmail, name: config.fromName },
        to: { email: r.normalized, name: r.name ?? undefined },
        subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: config.replyTo,
        headers: {
          'List-Unsubscribe': `<${unsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      });
      summary.sent++;
      rows.push({
        ...base,
        contact_id: r.contactId,
        to_email: r.normalized,
        status: 'sent',
        provider_message_id: messageId,
      });
    } catch (err) {
      const message =
        err instanceof BrevoError || err instanceof Error
          ? err.message
          : String(err);
      summary.failed++;
      summary.firstError ??= message;
      rows.push({
        ...base,
        contact_id: r.contactId,
        to_email: r.normalized,
        status: 'failed',
        error: message.slice(0, 500),
      });
    }
  });

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    await Promise.all(work.slice(i, i + CONCURRENCY).map((fn) => fn()));
  }

  if (rows.length) {
    const { error } = await db.from('email_messages').insert(rows);
    if (error) console.error('[email] logging sends failed:', error);
  }
  return summary;
}
