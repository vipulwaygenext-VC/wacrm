import { timingSafeEqual } from 'node:crypto';

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Machine callers (Vercel cron, the GitHub scheduler, the label print
 * agent): `Authorization: Bearer <CRON_SECRET>` or
 * `x-cron-secret: <AUTOMATION_CRON_SECRET>`.
 * Returns null when allowed, otherwise the HTTP status to answer with.
 */
export function cronAuthError(request: Request): 401 | 503 | null {
  const cronSecret = process.env.CRON_SECRET;
  const manualSecret = process.env.AUTOMATION_CRON_SECRET;
  if (!cronSecret && !manualSecret) return 503;
  const bearer = (request.headers.get('authorization') ?? '').replace(
    /^Bearer\s+/i,
    ''
  );
  const manual = request.headers.get('x-cron-secret') ?? '';
  const ok =
    (!!cronSecret && same(bearer, cronSecret)) ||
    (!!manualSecret && same(manual, manualSecret));
  return ok ? null : 401;
}
