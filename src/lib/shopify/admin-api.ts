// ============================================================
// Thin Shopify Admin GraphQL client — only what COD confirmation needs.
//
// Env:
//   SHOPIFY_STORE_DOMAIN   e.g. hindrishi-ayurveda.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    Admin API access token (custom app,
//                          scopes: read_orders, write_orders)
//   SHOPIFY_API_VERSION    optional, defaults below
// ============================================================

const DEFAULT_API_VERSION = '2025-10'

export class ShopifyApiError extends Error {}

export async function shopifyGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN
  const token = process.env.SHOPIFY_ADMIN_TOKEN
  if (!domain || !token) {
    throw new ShopifyApiError('SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN not configured')
  }
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
