// Minimal Shiprocket API client (https://apidocs.shiprocket.in).
//
// Auth: an API user (Shiprocket → Settings → API → Create API User),
// credentials in SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD. The token is
// valid for 10 days; we cache it per warm function instance.

const BASE = 'https://apiv2.shiprocket.in/v1/external';

let cached: { token: string; at: number } | null = null;

export class ShiprocketError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'ShiprocketError';
  }
}

export function shiprocketConfigured(): boolean {
  return !!(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD);
}

async function token(): Promise<string> {
  if (cached && Date.now() - cached.at < 8 * 24 * 3600 * 1000)
    return cached.token;
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    token?: string;
    message?: string;
  };
  if (!res.ok || !body.token) {
    throw new ShiprocketError(
      `Shiprocket login failed: ${body.message ?? res.status}`,
      res.status,
      body
    );
  }
  cached = { token: body.token, at: Date.now() };
  return body.token;
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { message?: unknown; errors?: unknown };
    const parts: string[] = [];
    if (typeof b.message === 'string') parts.push(b.message);
    if (b.errors) parts.push(JSON.stringify(b.errors));
    if (parts.length) return parts.join(' ').slice(0, 400);
  }
  return `HTTP ${status}`;
}

export async function sr<T = unknown>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown } = {}
): Promise<T> {
  const t = await token();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      authorization: `Bearer ${t}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as T;
  if (res.status === 401) cached = null;
  if (!res.ok)
    throw new ShiprocketError(errorMessage(body, res.status), res.status, body);
  return body;
}

// ---------------------------------------------------------------- types

export interface SrOrder {
  id: number;
  channel_order_id: string;
  payment_method: string;
  total: string | number;
  status: string;
  shipments?: { id: number; awb?: string | null; courier?: string | null }[];
}

export interface SrCourier {
  courier_company_id: number;
  courier_name: string;
  rate?: number;
  freight_charge?: number;
  etd_hours?: number;
  rating?: number;
}

export interface SrPickupLocation {
  pickup_location: string;
  pin_code: string | number;
  is_primary_location?: number;
}

// ------------------------------------------------------------ endpoints

export async function findOrders(search: string): Promise<SrOrder[]> {
  const body = await sr<{ data?: SrOrder[] }>(
    `/orders?search=${encodeURIComponent(search)}&per_page=20`
  );
  return body.data ?? [];
}

export async function pickupLocations(): Promise<SrPickupLocation[]> {
  const body = await sr<{ data?: { shipping_address?: SrPickupLocation[] } }>(
    '/settings/company/pickup'
  );
  return body.data?.shipping_address ?? [];
}

export async function createOrUpdateOrder(
  payload: Record<string, unknown>,
  update: boolean
): Promise<{ order_id?: number; shipment_id?: number }> {
  return sr(update ? '/orders/update/adhoc' : '/orders/create/adhoc', {
    body: payload,
  });
}

/** Cancel Shiprocket orders (only safe before an AWB is assigned). */
export async function cancelOrders(ids: number[]): Promise<void> {
  await sr('/orders/cancel', { body: { ids } });
}

export async function serviceability(q: {
  pickup: string;
  delivery: string;
  cod: boolean;
  weight: number;
  value: number;
}): Promise<{ couriers: SrCourier[]; recommended: number | null }> {
  const params = new URLSearchParams({
    pickup_postcode: q.pickup,
    delivery_postcode: q.delivery,
    cod: q.cod ? '1' : '0',
    weight: String(q.weight),
    declared_value: String(Math.round(q.value)),
  });
  const body = await sr<{
    data?: {
      available_courier_companies?: SrCourier[];
      recommended_courier_company_id?: number;
    };
  }>(`/courier/serviceability/?${params}`);
  return {
    couriers: body.data?.available_courier_companies ?? [],
    recommended: body.data?.recommended_courier_company_id ?? null,
  };
}

export async function assignAwb(
  shipmentId: number,
  courierId: number
): Promise<{ awb: string; courier: string }> {
  const body = await sr<{
    awb_assign_status?: number;
    message?: string;
    response?: { data?: { awb_code?: string; courier_name?: string } };
  }>('/courier/assign/awb', {
    body: { shipment_id: shipmentId, courier_id: courierId },
  });
  const awb = body.response?.data?.awb_code;
  if (!awb)
    throw new ShiprocketError(
      `AWB not assigned: ${body.message ?? 'unknown'}`,
      200,
      body
    );
  return { awb, courier: body.response?.data?.courier_name ?? '' };
}

export async function requestPickup(shipmentId: number): Promise<void> {
  await sr('/courier/generate/pickup', { body: { shipment_id: [shipmentId] } });
}

export async function generateLabel(shipmentId: number): Promise<string> {
  const body = await sr<{
    label_created?: number;
    label_url?: string;
    response?: string;
  }>('/courier/generate/label', { body: { shipment_id: [shipmentId] } });
  if (!body.label_url) {
    throw new ShiprocketError(
      `Label not generated: ${body.response ?? 'unknown'}`,
      200,
      body
    );
  }
  return body.label_url;
}

/** Pick a courier: Shiprocket's recommendation (default), the cheapest, or the fastest. */
export function chooseCourier(
  couriers: SrCourier[],
  recommended: number | null,
  rule = process.env.SHIPROCKET_COURIER_RULE || 'recommended'
): SrCourier | null {
  if (!couriers.length) return null;
  const price = (c: SrCourier) =>
    c.rate ?? c.freight_charge ?? Number.POSITIVE_INFINITY;
  if (rule === 'cheapest')
    return [...couriers].sort((a, b) => price(a) - price(b))[0];
  if (rule === 'fastest') {
    return [...couriers].sort(
      (a, b) =>
        (a.etd_hours ?? 9999) - (b.etd_hours ?? 9999) || price(a) - price(b)
    )[0];
  }
  return (
    couriers.find((c) => c.courier_company_id === recommended) ?? couriers[0]
  );
}
