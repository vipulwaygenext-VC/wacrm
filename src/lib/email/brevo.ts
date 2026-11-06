/**
 * Minimal Brevo (ex-Sendinblue) transactional email client.
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 */

const BREVO_API = 'https://api.brevo.com/v3';

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface BrevoSendInput {
  apiKey: string;
  from: EmailAddress;
  to: EmailAddress;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  headers?: Record<string, string>;
}

export class BrevoError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BrevoError';
  }
}

async function brevoError(res: Response): Promise<BrevoError> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { message?: string; code?: string };
    if (body.message) detail = body.message;
  } catch {
    // non-JSON error body — keep the status line
  }
  return new BrevoError(detail, res.status);
}

/** Send one email. Resolves to Brevo's message id. */
export async function sendBrevoEmail(input: BrevoSendInput): Promise<string> {
  const res = await fetch(`${BREVO_API}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key': input.apiKey,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: input.from.email, name: input.from.name },
      to: [
        {
          email: input.to.email,
          ...(input.to.name ? { name: input.to.name } : {}),
        },
      ],
      subject: input.subject,
      htmlContent: input.html,
      textContent: input.text,
      ...(input.replyTo ? { replyTo: { email: input.replyTo } } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
    }),
  });
  if (!res.ok) throw await brevoError(res);
  const body = (await res.json().catch(() => ({}))) as { messageId?: string };
  return body.messageId ?? '';
}

/** Check an API key by reading the Brevo account it belongs to. */
export async function validateBrevoKey(
  apiKey: string
): Promise<{ email?: string }> {
  const res = await fetch(`${BREVO_API}/account`, {
    headers: { 'api-key': apiKey, accept: 'application/json' },
  });
  if (!res.ok) throw await brevoError(res);
  return (await res.json().catch(() => ({}))) as { email?: string };
}
