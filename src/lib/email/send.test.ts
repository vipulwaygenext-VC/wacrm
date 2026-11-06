import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmails } from './send';

process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret';

function fakeDb(unsubscribed: string[]) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      if (table === 'email_unsubscribes') {
        const q = {
          select: () => q,
          eq: () => q,
          in: async () => ({
            data: unsubscribed.map((email) => ({ email })),
            error: null,
          }),
        };
        return q;
      }
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          inserted.push(...rows);
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, inserted };
}

afterEach(() => vi.unstubAllGlobals());

describe('sendEmails', () => {
  it('sends once per address, skips unsubscribed / invalid, logs every row', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: '<m@brevo>' }), {
          status: 201,
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { db, inserted } = fakeDb(['gone@example.com']);

    const summary = await sendEmails({
      db,
      accountId: '08fef154-696e-4dec-a3a9-5ceafca01e62',
      userId: 'u1',
      config: {
        apiKey: 'k',
        fromEmail: 'hi@biz.test',
        fromName: 'Biz',
        replyTo: null,
        footerText: null,
      },
      recipients: [
        { contactId: 'c1', email: 'Ravi@Example.com', name: 'Ravi' },
        { contactId: 'c2', email: 'ravi@example.com', name: 'Ravi again' },
        { contactId: 'c3', email: 'gone@example.com', name: 'Gone' },
        { contactId: 'c4', email: null, name: 'No email' },
        { contactId: 'c5', email: 'bad-address', name: 'Bad' },
      ],
      subject: 'Hello',
      body: 'Hi {{name}}',
    });

    expect(summary).toMatchObject({ sent: 1, failed: 0, skipped: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string
    );
    expect(sent.to[0].email).toBe('ravi@example.com');
    expect(sent.textContent).toContain('Hi Ravi');
    expect(sent.headers['List-Unsubscribe']).toContain(
      '/api/email/unsubscribe?'
    );
    expect(inserted.map((r) => r.status).sort()).toEqual([
      'sent',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(inserted.find((r) => r.contact_id === 'c3')?.skip_reason).toBe(
      'unsubscribed'
    );
  });

  it('records provider errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'Sender not verified' }), {
            status: 400,
          })
      )
    );
    const { db, inserted } = fakeDb([]);
    const summary = await sendEmails({
      db,
      accountId: '08fef154-696e-4dec-a3a9-5ceafca01e62',
      userId: 'u1',
      config: {
        apiKey: 'k',
        fromEmail: 'hi@biz.test',
        fromName: 'Biz',
        replyTo: null,
        footerText: null,
      },
      recipients: [{ contactId: 'c1', email: 'a@example.com', name: null }],
      subject: 'Hello',
      body: 'Hi',
    });
    expect(summary).toMatchObject({
      sent: 0,
      failed: 1,
      firstError: 'Sender not verified',
    });
    expect(inserted[0]).toMatchObject({
      status: 'failed',
      error: 'Sender not verified',
    });
  });
});
