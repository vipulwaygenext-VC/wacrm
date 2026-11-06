'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Mail } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface EmailConfigResponse {
  configured: boolean;
  has_key?: boolean;
  from_email?: string;
  from_name?: string;
  reply_to?: string | null;
  footer_text?: string | null;
}

/**
 * Settings → Email. Connects the account to Brevo (free: 300 emails/day)
 * and sets the sender. The key is checked with Brevo and stored
 * encrypted; it is never shown again.
 */
export function EmailSettings() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [footer, setFooter] = useState('');
  const [testEmail, setTestEmail] = useState('');

  useEffect(() => {
    fetch('/api/email/config')
      .then((r) => r.json())
      .then((d: EmailConfigResponse) => {
        if (d.configured) {
          setHasKey(!!d.has_key);
          setFromEmail(d.from_email ?? '');
          setFromName(d.from_name ?? '');
          setReplyTo(d.reply_to ?? '');
          setFooter(d.footer_text ?? '');
        }
      })
      .catch(() => toast.error('Could not load email settings'))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/email/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
          from_email: fromEmail,
          from_name: fromName,
          reply_to: replyTo,
          footer_text: footer,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Save failed');
      if (apiKey.trim()) setHasKey(true);
      setApiKey('');
      toast.success('Email settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'test',
          test_email: testEmail,
          subject: 'Test email from your CRM',
          body: 'Hi {{name}},\n\nThis is a test email from your CRM. If you can read this, email sending works.',
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Test failed');
      if (d.sent) toast.success(`Test email sent to ${testEmail}`);
      else toast.error(d.firstError || 'Brevo did not accept the email');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  const disabled = !canEditSettings || saving || loading;

  return (
    <div>
      <SettingsPanelHead
        title="Email"
        description="Send emails to your contacts from the CRM through Brevo (free for up to 300 emails a day). Every email includes an unsubscribe link."
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground flex items-center gap-2">
            <Mail className="h-5 w-5" aria-hidden="true" /> Brevo connection
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            In Brevo, verify your sender email (Senders, domains &amp; dedicated
            IPs), then create an API key under SMTP &amp; API → API keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <Loader2
              className="text-muted-foreground h-5 w-5 animate-spin"
              aria-label="Loading"
            />
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="email-api-key">Brevo API key</Label>
                <Input
                  id="email-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder={
                    hasKey
                      ? 'Saved — paste a new key to replace it'
                      : 'xkeysib-…'
                  }
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="email-from">Sender email</Label>
                  <Input
                    id="email-from"
                    type="email"
                    placeholder="hello@yourdomain.com"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email-name">Sender name</Label>
                  <Input
                    id="email-name"
                    placeholder="Your business name"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    disabled={disabled}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-reply">Reply-to email (optional)</Label>
                <Input
                  id="email-reply"
                  type="email"
                  placeholder="Where replies should go"
                  value={replyTo}
                  onChange={(e) => setReplyTo(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email-footer">
                  Footer line (business name, address, phone)
                </Label>
                <Textarea
                  id="email-footer"
                  rows={2}
                  value={footer}
                  onChange={(e) => setFooter(e.target.value)}
                  disabled={disabled}
                />
              </div>
              <Button onClick={save} disabled={disabled}>
                {saving ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : null}
                Save
              </Button>
              {!canEditSettings ? (
                <p className="text-muted-foreground text-sm">
                  Only admins can change these settings.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {hasKey ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-foreground">Send a test email</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="email-test">Your email</Label>
              <Input
                id="email-test"
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={sendTest}
              disabled={testing || !testEmail}
            >
              {testing ? (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              ) : null}
              Send test
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
