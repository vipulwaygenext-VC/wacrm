// ============================================================
// Thin Shopify Admin GraphQL client — only what COD confirmation needs.
//
// Env:
//   SHOPIFY_STORE_DOMAIN   e.g. hindrishi-ayurveda.myshopify.com
//   Auth, either:
//   SHOPIFY_CLIENT_ID +    Dev Dashboard app credentials (scopes
//   SHOPIFY_CLIENT_SECRET  read_orders, write_orders). A 24-hour token is
//                          fetched with the client credentials grant and
//                          cached in memory.
//   SHOPIFY_ADMIN_TOKEN    or a static Admin API token (legacy custom app)
//   SHOPIFY_API_VERSION    optional, defaults below
// ============================================================

const DEFAULT_API_VERSION = '2026-10'

export class ShopifyApiError extends Error {}

let cachedToken: { value: string; expiresAt: number } | null = null

async function getAccessToken(domain: string): Promise<string> {
  const clientId = process.env.SHOPIFY_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET
  if (clientId && clientSecret) {
    // Refresh five minutes before expiry.
    if (cachedToken && cachedToken.expiresAt - 5 * 60_000 > Date.now()) {
      return cachedToken.value
    }
    const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })
    const json = (await res.json().catch(() => null)) as {
      access_token?: string
      expires_in?: number
    } | null
    if (!res.ok || !json?.access_token) {
      throw new ShopifyApiError(`Shopify token request failed (${res.status})`)
    }
    cachedToken = {
      value: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 86399) * 1000,
    }
    return cachedToken.value
  }
  const token = process.env.SHOPIFY_ADMIN_TOKEN
  if (!token) {
    throw new ShopifyApiError(
      'Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (or SHOPIFY_ADMIN_TOKEN)'
    )
  }
  return token
}

export async function shopifyGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN
  if (!domain) throw new ShopifyApiError('SHOPIFY_STORE_DOMAIN not configured')
  const token = await getAccessToken(domain)
  const version = process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION
  const res = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  })
  const json = (await res.json().catch(() => null)) as {
    data?: T
    errors?: unknown
  } | null
  if (!res.ok || !json || json.errors) {
    throw new ShopifyApiError(
      `Shopify GraphQL failed (${res.status}): ${JSON.stringify(json?.errors ?? json)}`
    )
  }
  return json.data as T
}

export function orderGid(orderId: number | string): string {
  return `gid://shopify/Order/${orderId}`
}

/** Add and/or remove tags on an order. */
export async function updateOrderTags(
  orderId: number | string,
  add: string[],
  remove: string[] = []
): Promise<void> {
  const id = orderGid(orderId)
  if (add.length) {
    await shopifyGraphql(
      `mutation($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { id, tags: add }
    )
  }
  if (remove.length) {
    await shopifyGraphql(
      `mutation($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
      }`,
      { id, tags: remove }
    )
  }
}

export interface AdvanceOrderInfo {
  name: string
  tags: string[]
  outstanding: number
  /** Shipping charged on the order (e.g. the ₹49 COD charge). */
  shipping: number
}

/** What the /pay page needs to know about an order. */
export async function getOrderForAdvance(orderId: number | string): Promise<AdvanceOrderInfo | null> {
  const data = await shopifyGraphql<{
    order: {
      name: string
      tags: string[]
      cancelledAt: string | null
      totalOutstandingSet: { shopMoney: { amount: string } }
      totalShippingPriceSet: { shopMoney: { amount: string } }
    } | null
  }>(
    // No customer / address fields: those are protected customer data and
    // fail for apps without that approval. The pay page doesn't need them.
    `query($id: ID!) {
      order(id: $id) {
        name tags cancelledAt
        totalOutstandingSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
      }
    }`,
    { id: orderGid(orderId) }
  )
  const o = data.order
  if (!o || o.cancelledAt) return null
  return {
    name: o.name,
    tags: o.tags,
    outstanding: Number(o.totalOutstandingSet.shopMoney.amount),
    shipping: Number(o.totalShippingPriceSet.shopMoney.amount),
  }
}

/** Record money received outside checkout (reduces the COD amount due). */
export async function recordManualPayment(
  orderId: number | string,
  amountRupees: number,
  methodName: string
): Promise<void> {
  const data = await shopifyGraphql<{
    orderCreateManualPayment: { userErrors: { message: string }[] }
  }>(
    `mutation($id: ID!, $amount: MoneyInput!, $method: String) {
      orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $method) {
        userErrors { field message }
      }
    }`,
    {
      id: orderGid(orderId),
      amount: { amount: amountRupees.toFixed(2), currencyCode: 'INR' },
      method: methodName,
    }
  )
  const errs = data.orderCreateManualPayment.userErrors
  if (errs.length) throw new ShopifyApiError(errs.map((e) => e.message).join('; '))
}

export type ClaimResult = 'claimed' | 'taken' | 'unknown'

/**
 * Atomically mark an order as handled for `key` (once per order).
 *
 * Uses a metafield with compare-and-swap: `compareDigest: null` means
 * "create only if it doesn't exist", so when Shopify delivers the same
 * webhook twice (retries, or two deliveries racing) only one caller gets
 * 'claimed'. 'unknown' means Shopify couldn't be asked (network/scope) —
 * the caller decides whether to proceed.
 */
export async function claimOrderOnce(orderId: number | string, key: string): Promise<ClaimResult> {
  try {
    const data = await shopifyGraphql<{
      metafieldsSet: { userErrors: { code: string | null; message: string }[] }
    }>(
      `mutation($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { userErrors { field message code } }
      }`,
      {
        m: [
          {
            ownerId: orderGid(orderId),
            namespace: 'wacrm',
            key,
            type: 'single_line_text_field',
            value: new Date().toISOString(),
            compareDigest: null,
          },
        ],
      }
    )
    const errs = data.metafieldsSet.userErrors
    if (!errs.length) return 'claimed'
    if (errs.some((e) => e.code === 'STALE_OBJECT')) return 'taken'
    console.error(`[shopify] claim ${key} on ${orderId} failed:`, errs)
    return 'unknown'
  } catch (err) {
    console.error(`[shopify] claim ${key} on ${orderId} failed:`, err)
    return 'unknown'
  }
}

/** Upsert a `wacrm.<key>` metafield on an order (last write wins). */
export async function setOrderMetafield(
  orderId: number | string,
  key: string,
  value: string
): Promise<void> {
  const data = await shopifyGraphql<{
    metafieldsSet: { userErrors: { message: string }[] }
  }>(
    `mutation($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { userErrors { field message } }
    }`,
    {
      m: [{ ownerId: orderGid(orderId), namespace: 'wacrm', key, type: 'single_line_text_field', value }],
    }
  )
  const errs = data.metafieldsSet.userErrors
  if (errs.length) throw new ShopifyApiError(errs.map((e) => e.message).join('; '))
}

export interface DelayCandidate {
  id: string
  name: string
  tags: string[]
  outstanding: number
  total: number
  shipping: number
  productTitle: string
  conversationId: string | null
}

/**
 * Open, unfulfilled orders created in [olderThan - 1 day, olderThan],
 * not yet reminded. Reads the conversation id we stored when the
 * confirmation went out (no protected customer data needed).
 */
export async function findDelayCandidates(
  olderThanDays: number,
  skipTag: string
): Promise<DelayCandidate[]> {
  const day = 24 * 60 * 60 * 1000
  const to = new Date(Date.now() - olderThanDays * day)
  const from = new Date(to.getTime() - day)
  const q =
    `status:open fulfillment_status:unfulfilled -tag:'${skipTag}' ` +
    `created_at:>='${from.toISOString()}' created_at:<='${to.toISOString()}'`
  const out: DelayCandidate[] = []
  let after: string | null = null
  for (let page = 0; page < 10; page++) {
    const data: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null }
        nodes: {
          id: string
          name: string
          tags: string[]
          totalOutstandingSet: { shopMoney: { amount: string } }
          totalPriceSet: { shopMoney: { amount: string } }
          totalShippingPriceSet: { shopMoney: { amount: string } }
          lineItems: { nodes: { title: string }[] }
          metafield: { value: string } | null
        }[]
      }
    } = await shopifyGraphql(
      `query($q: String!, $after: String) {
        orders(first: 50, after: $after, query: $q) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id name tags
            totalOutstandingSet { shopMoney { amount } }
            totalPriceSet { shopMoney { amount } }
            totalShippingPriceSet { shopMoney { amount } }
            lineItems(first: 1) { nodes { title } }
            metafield(namespace: "wacrm", key: "conversation_id") { value }
          }
        }
      }`,
      { q, after }
    )
    for (const n of data.orders.nodes) {
      out.push({
        id: n.id.split('/').pop()!,
        name: n.name,
        tags: n.tags,
        outstanding: Number(n.totalOutstandingSet.shopMoney.amount),
        total: Number(n.totalPriceSet.shopMoney.amount),
        shipping: Number(n.totalShippingPriceSet.shopMoney.amount),
        productTitle: n.lineItems.nodes[0]?.title ?? 'Your order',
        conversationId: n.metafield?.value ?? null,
      })
    }
    if (!data.orders.pageInfo.hasNextPage) break
    after = data.orders.pageInfo.endCursor
  }
  return out
}
