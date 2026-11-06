'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Loader2, Mail, Send } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Tag {
  id: string;
  name: string;
}

interface LogRow {
  batch_id: string;
  subject: string;
  status: 'sent' | 'failed' | 'skipped';
  created_at: string;
}

interface Batch {
  batchId: string;
  subject: string;
  createdAt: string;
  sent: number;
  failed: number;
  skipped: number;
}

function groupBatches(rows: LogRow[]): Batch[] {
  const map = new Map<string, Batch>();
  for (const r of rows) {
    const b = map.get(r.batch_id) ?? {
      batchId: r.batch_id,
      subject: r.subject,
      createdAt: r.created_at,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    b[r.status]++;
    map.set(r.batch_id, b);
  }
  return [...map.values()].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

/**
 * Email compose page: send an email to every contact with a tag, or to
 * one contact (`/email?contact=<id>`, linked from a contact). Sending
 * goes through /api/email/send, which skips unsubscribed / missing
 * addresses and logs each recipient.
 */
export default function EmailPage() {
  // useSearchParams needs a Suspense boundary for the production build.
  return (
    <Suspense fallback={null}>
      <EmailCompose />
    </Suspense>
  );
}

function EmailCompose() {
  const supabase = useMemo(() => createClient(), []);
  const { accountId } = useAuth();
  const params = useSearchParams();
  const contactId = params.get('contact');

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagId, setTagId] = useState<string>('');
  const [contact, setContact] = useState<{
    id: string;
    name: string | null;
    email: string | null;
  } | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Hi {{name}},\n\n');
  const [count, setCount] = useState<{
    total: number;
    with_email: number;
    max: number;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [batches, setBatches] = useState<Batch[]>([]);

  const loadLog = useCallback(async () => {
    if (!accountId) return;
    const { data } = await supabase
      .from('email_messages')
      .select('batch_id, subject, status, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1000);
    setBatches(groupBatches((data ?? []) as LogRow[]).slice(0, 20));
  }, [accountId, supabase]);

  useEffect(() => {
    fetch('/api/email/config')
      .then((r) => r.json())
      .then((d) => setConfigured(!!d.configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    supabase
      .from('tags')
      .select('id, name')
      .eq('account_id', accountId)
      .order('name')
      .then(({ data }) => setTags((data ?? []) as Tag[]));
    if (contactId) {
      supabase
        .from('contacts')
        .select('id, name, email')
        .eq('id', contactId)
        .maybeSingle()
        .then(({ data }) => setContact(data));
    }
    void loadLog();
  }, [accountId, contactId, supabase, loadLog]);

  const target = contact
    ? { mode: 'contacts' as const, contact_ids: [contact.id] }
    : tagId
      ? { mode: 'tag' as const, tag_id: tagId }
      : null;

  useEffect(() => {
    setCount(null);
    setConfirming(false);
    if (!target) return;
    fetch('/api/email/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...target, dry_run: true }),
    })
      .then((r) => r.json())
      .then((d) => (typeof d.total === 'number' ? setCount(d) : null))
      .catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagId, contact?.id]);

  async function send() {
    if (!target) return;
    setSending(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...target, subject, body }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Send failed');
      const parts = [`${d.sent} sent`];
      if (d.skipped) parts.push(`${d.skipped} skipped`);
      if (d.failed) parts.push(`${d.failed} failed`);
      if (d.sent) toast.success(parts.join(' · '));
      else
        toast.error(
          d.firstError
            ? `${parts.join(' · ')}: ${d.firstError}`
            : parts.join(' · ')
        );
      setConfirming(false);
      void loadLog();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  const tooMany = !!count && count.with_email > count.max;
  const canSend =
    !!target &&
    !!subject.trim() &&
    body.trim().length > 10 &&
    !!count?.with_email &&
    !tooMany;

  if (configured === false) {
    return (
      <Card className="mx-auto mt-8 max-w-xl">
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Mail className="h-5 w-5" aria-hidden="true" /> Set up email first
          </CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground space-y-4 text-sm">
          <p>
            Connect your Brevo account and choose the sender name and email.
          </p>
          <Link href="/settings?tab=email" className={buttonVariants()}>
            Open email settings
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Email
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Email contacts who have reached out to you or agreed to hear from you.
          Unsubscribed and missing addresses are skipped automatically.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">New email</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email-to">To</Label>
              {contact ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded-md border px-3 py-2">
                    {contact.name || 'Contact'} · {contact.email || 'no email'}
                  </span>
                  <Link
                    href="/email"
                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                  >
                    Send to a tag instead
                  </Link>
                </div>
              ) : (
                <Select
                  value={tagId}
                  onValueChange={(v) => setTagId(v ?? '')}
                  items={tags.map((t) => ({ value: t.id, label: t.name }))}
                >
                  <SelectTrigger id="email-to" className="w-full">
                    <SelectValue placeholder="Everyone with tag…" />
                  </SelectTrigger>
                  <SelectContent>
                    {tags.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {count ? (
                <p
                  className={
                    tooMany
                      ? 'text-destructive text-sm'
                      : 'text-muted-foreground text-sm'
                  }
                >
                  {count.with_email} of {count.total} contacts have an email
                  address
                  {tooMany ? ` — the limit is ${count.max} per send.` : '.'}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={150}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email-body">Message</Label>
              <Textarea
                id="email-body"
                rows={12}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {'{{name}}'} becomes the contact&apos;s first name. Leave a
                blank line between paragraphs. Your footer and an unsubscribe
                link are added automatically.
              </p>
            </div>
            {confirming ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
                <span className="text-foreground text-sm">
                  Send to {count?.with_email ?? 0}{' '}
                  {count?.with_email === 1 ? 'person' : 'people'}?
                </span>
                <Button onClick={send} disabled={sending}>
                  {sending ? (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                  )}
                  Yes, send
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={sending}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                onClick={() => setConfirming(true)}
                disabled={!canSend || configured === null}
              >
                <Send className="mr-2 h-4 w-4" aria-hidden="true" /> Send
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Recent sends</CardTitle>
          </CardHeader>
          <CardContent>
            {batches.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No emails sent yet.
              </p>
            ) : (
              <ul className="space-y-3">
                {batches.map((b) => (
                  <li key={b.batchId} className="text-sm">
                    <div className="text-foreground truncate font-medium">
                      {b.subject}
                    </div>
                    <div className="text-muted-foreground">
                      {b.sent} sent
                      {b.skipped ? ` · ${b.skipped} skipped` : ''}
                      {b.failed ? ` · ${b.failed} failed` : ''} ·{' '}
                      {formatDistanceToNow(new Date(b.createdAt), {
                        addSuffix: true,
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
