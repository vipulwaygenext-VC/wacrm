// Abandoned-cart WhatsApp reminder.
//
// Runs every ~30 minutes (GitHub Actions → /api/cron/cart-reminder).
// For each Shopify abandoned checkout that is between CART_REMINDER_
// MIN_AGE_MINUTES (default 60) and 24 hours old, it sends the approved
// `cart_reminder` template to the shopper's phone:
//   header  the product's image
//   body    {{1}} first name, {{2}} product
//   button  0: URL https://www.hindrishi.com/{{1}} → the checkout's
//              recovery link (path after the domain)
//
// Skips: no / invalid phone, the same phone already ordered since the
// cart was created, and anyone who got a cart reminder in the last
// CART_REMINDER_COOLDOWN_DAYS (default 3). Quiet hours 22:00–08:00 IST:
// nothing is sent; carts are picked up on the morning run.

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { sendMessageToConversation } from '@/lib/whatsapp/send-message';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { shopifyGraphql } from './admin-api';
import { normalizeIndianPhone } from './cod-confirm';
import { appOrigin, codAccountId } from './cod-service';

export const CART_TEMPLATE = () =>
  process.env.CART_REMINDER_TEMPLATE_NAME || 'cart_reminder';
const MAX_PER_RUN = 40;

function minAgeMinutes(): number {
  const n = Number(process.env.CART_REMINDER_MIN_AGE_MINUTES);
  return Number.isFinite(n) && n >= 15 ? n : 60;
}

function cooldownDays(): number {
  const n = Number(process.env.CART_REMINDER_COOLDOWN_DAYS);
  return Number.isFinite(n) && n >= 1 ? n : 3;
}

export interface AbandonedCart {
  id: string;
  name: string;
  createdAt: string;
  url: string;
  phone: string | null;
  firstName: string;
  product: string;
  imageUrl: string | null;
}

/** Hour of day in India (UTC+5:30). */
export function istHour(now = new Date()): number {
  return new Date(now.getTime() + 330 * 60 * 1000).getUTCHours();
}

export function isQuietHour(now = new Date()): boolean {
  const h = istHour(now);
  return h >= 22 || h < 8;
}

/** "Durgesh patel" → "Durgesh"; empty → "Customer". */
export function cartFirstName(raw: string | null | undefined): string {
  const first = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return 'Customer';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Product line for the message: short title, "+N more" for extra items. */
export function cartProduct(titles: string[]): string {
  const first = (titles[0] ?? 'aapka product').split(/\s+[–-]\s+/)[0].trim();
  const short = first.length > 60 ? `${first.slice(0, 57)}...` : first;
  return titles.length > 1 ? `${short} +${titles.length - 1} more` : short;
}

/**
 * Path + query of the recovery link after the store's domain, used as
 * the template's URL-button suffix. Returns null if the link is on a
 * different host than CART_REMINDER_URL_HOST (default www.hindrishi.com),
 * since the approved button can only point at that domain.
 */
export function recoverySuffix(
  url: string,
  host = process.env.CART_REMINDER_URL_HOST || 'www.hindrishi.com'
): string | null {
  try {
    const u = new URL(url);
    if (u.host !== host) return null;
    return `${u.pathname.replace(/^\//, '')}${u.search}`;
  } catch {
    return null;
  }
}

interface CheckoutNode {
  id: string;
  name: string;
  createdAt: string;
  completedAt: string | null;
  abandonedCheckoutUrl: string;
  shippingAddress: { firstName: string | null; phone: string | null } | null;
  billingAddress: { phone: string | null } | null;
  lineItems: { nodes: { title: string; image: { url: string } | null }[] };
}

export async function findAbandonedCarts(
  from: Date,
  to: Date
): Promise<AbandonedCart[]> {
  const q = `created_at:>='${from.toISOString()}' created_at:<='${to.toISOString()}'`;
  const data = await shopifyGraphql<{
    abandonedCheckouts: { nodes: CheckoutNode[] };
  }>(
    `query($q: String!) {
      abandonedCheckouts(first: 100, query: $q, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id name createdAt completedAt abandonedCheckoutUrl
          shippingAddress { firstName phone }
          billingAddress { phone }
          lineItems(first: 5) { nodes { title image { url } } }
        }
      }
    }`,
    { q }
  );
  return data.abandonedCheckouts.nodes
    .filter((n) => !n.completedAt)
    .map((n) => {
      const raw =
        n.shippingAddress?.phone ||
        n.billingAddress?.phone ||
        '';
      const titles = n.lineItems.nodes.map((l) => l.title);
      return {
        id: n.id,
        name: n.name,
        createdAt: n.createdAt,
        url: n.abandonedCheckoutUrl,
        phone: raw ? normalizeIndianPhone(raw) : null,
        firstName: cartFirstName(n.shippingAddress?.firstName),
        product: cartProduct(titles),
        imageUrl:
          n.lineItems.nodes.find((l) => l.image?.url)?.image?.url ?? null,
      };
    });
}

/** Normalised phones of everyone who placed an order since `since`. */
export async function phonesThatOrdered(since: Date): Promise<Set<string>> {
  const data = await shopifyGraphql<{
    orders: {
      nodes: {
        phone: string | null;
        shippingAddress: { phone: string | null } | null;
      }[];
    };
  }>(
    `query($q: String!) {
      orders(first: 250, query: $q, sortKey: CREATED_AT, reverse: true) {
        nodes { phone shippingAddress { phone } }
      }
    }`,
    { q: `created_at:>='${since.toISOString()}'` }
  );
  const out = new Set<string>();
  for (const o of data.orders.nodes) {
    for (const p of [o.phone, o.shippingAddress?.phone]) {
      const n = p ? normalizeIndianPhone(p) : null;
      if (n) out.add(n);
    }
  }
  return out;
}

/**
 * Header picture for the reminder: the product photo with the Hindrishi
 * logo band, rendered by /api/og/cart-image. CART_REMINDER_LOGO=off
 * sends the plain product photo instead.
 */
export function cartImageUrl(productImage: string, origin = appOrigin()): string {
  if (process.env.CART_REMINDER_LOGO === 'off') return productImage;
  return `${origin}/api/og/cart-image?src=${encodeURIComponent(productImage)}`;
}

export async function runCartReminders(
  now = new Date()
): Promise<Record<string, number | string>> {
  const stats: Record<string, number | string> = {
    found: 0,
    sent: 0,
    no_phone: 0,
    ordered: 0,
    recently_reminded: 0,
    bad_link: 0,
    failed: 0,
  };
  if (isQuietHour(now)) return { ...stats, quiet_hours: 'yes' };
  const accountId = await codAccountId();
  if (!accountId) return { ...stats, error: 'no account' };

  const to = new Date(now.getTime() - minAgeMinutes() * 60 * 1000);
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const carts = await findAbandonedCarts(from, to);
  stats.found = carts.length;
  if (!carts.length) return stats;

  const ordered = await phonesThatOrdered(from);
  const db = supabaseAdmin();
  const cooldownSince = new Date(
    now.getTime() - cooldownDays() * 24 * 60 * 60 * 1000
  ).toISOString();
  const seenPhones = new Set<string>();
  let sent = 0;

  for (const cart of carts) {
    if (sent >= MAX_PER_RUN) break;
    if (!cart.phone) {
      stats.no_phone = (stats.no_phone as number) + 1;
      continue;
    }
    // One reminder per person per run, even with several carts.
    if (seenPhones.has(cart.phone)) continue;
    seenPhones.add(cart.phone);
    if (ordered.has(cart.phone)) {
      stats.ordered = (stats.ordered as number) + 1;
      continue;
    }
    const suffix = recoverySuffix(cart.url);
    if (!suffix) {
      stats.bad_link = (stats.bad_link as number) + 1;
      continue;
    }

    try {
      const { conversationId } = await resolveConversationByPhone(
        db,
        accountId,
        cart.phone,
        cart.firstName
      );
      const { data: recent } = await db
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('template_name', CART_TEMPLATE())
        .gte('created_at', cooldownSince)
        .limit(1);
      if (recent && recent.length) {
        stats.recently_reminded = (stats.recently_reminded as number) + 1;
        continue;
      }
      await sendMessageToConversation(db, accountId, {
        conversationId,
        messageType: 'template',
        contentText: null,
        mediaUrl: null,
        filename: null,
        templateName: CART_TEMPLATE(),
        templateLanguage: process.env.SHOPIFY_COD_TEMPLATE_LANGUAGE || 'en',
        templateMessageParams: {
          ...(cart.imageUrl
            ? { headerMediaUrl: cartImageUrl(cart.imageUrl) }
            : {}),
          body: [cart.firstName, cart.product],
          buttonParams: { 0: suffix },
        },
        interactivePayload: null,
        replyToMessageId: null,
      });
      sent++;
      stats.sent = sent;
    } catch (err) {
      stats.failed = (stats.failed as number) + 1;
      console.error(`[cart-reminder] ${cart.name} failed:`, err);
    }
  }
  return stats;
}
