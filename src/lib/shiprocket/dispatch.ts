// Book a Shopify order in Shiprocket and get its label, ready to print.
//
// Triggers (all end up in dispatchOrder):
//   * Razorpay payment recorded on the WhatsApp pay link (full or ₹100
//     advance)                         → payment-received.ts
//   * prepaid Shopify order created     → orders webhook
//   * staff tag an order "RTD"          → /api/cron/shiprocket sweep
//
// Steps: find the order in Shiprocket (orders synced by the Shopify
// channel are reused, otherwise it's created), set the right payment
// (Prepaid, or COD for only the amount still due), pick a courier
// (SHIPROCKET_COURIER_RULE: recommended | cheapest | fastest), assign
// the AWB, request pickup, generate the label.
//
// The Shopify order is the queue / record:
//   tag  SR-Pending    waiting for Shiprocket (retried by the sweep)
//   tag  Label-Ready   label generated; the print agent picks it up
//   tag  Label-Printed printed (set by the print agent)
//   tag  SR-Error      needs a human (reason in the order note)
//   metafields wacrm.shiprocket_awb / wacrm.shiprocket_label

import {
  appendOrderNote,
  claimOrderOnce,
  orderGid,
  setOrderMetafield,
  shopifyGraphql,
  updateOrderTags,
} from '@/lib/shopify/admin-api';
import {
  assignAwb,
  cancelOrders,
  chooseCourier,
  createOrUpdateOrder,
  findOrders,
  generateLabel,
  pickupLocations,
  requestPickup,
  serviceability,
  shiprocketConfigured,
  ShiprocketError,
  type SrOrder,
} from './client';

export const SR_TAGS = {
  rtd: process.env.SHIPROCKET_RTD_TAG || 'RTD',
  pending: 'SR-Pending',
  ready: 'Label-Ready',
  printed: 'Label-Printed',
  error: 'SR-Error',
};

/** Orders the Shopify→Shiprocket channel hasn't synced yet are created by us after this long. */
const SYNC_WAIT_MS = 10 * 60 * 1000;

export type DispatchOutcome =
  | 'label_ready'
  | 'already_done'
  | 'waiting_for_sync'
  | 'not_configured'
  | 'skipped'
  | 'error';

interface ShopifyOrderForShipping {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFulfillmentStatus: string;
  tags: string[];
  email: string | null;
  total: number;
  outstanding: number;
  shipping: number;
  discount: number;
  advanceUnrecorded: number;
  address: {
    firstName: string | null;
    lastName: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    country: string | null;
    phone: string | null;
  } | null;
  items: {
    name: string;
    sku: string | null;
    quantity: number;
    price: number;
  }[];
  awb: string | null;
}

async function loadOrder(
  orderId: number | string
): Promise<ShopifyOrderForShipping | null> {
  const data = await shopifyGraphql<{
    order: {
      id: string;
      name: string;
      createdAt: string;
      cancelledAt: string | null;
      displayFulfillmentStatus: string;
      tags: string[];
      email: string | null;
      totalPriceSet: { shopMoney: { amount: string } };
      totalOutstandingSet: { shopMoney: { amount: string } };
      totalShippingPriceSet: { shopMoney: { amount: string } };
      totalDiscountsSet: { shopMoney: { amount: string } };
      advanceUnrecorded: { value: string } | null;
      awb: { value: string } | null;
      shippingAddress: ShopifyOrderForShipping['address'];
      lineItems: {
        nodes: {
          name: string;
          sku: string | null;
          quantity: number;
          originalUnitPriceSet: { shopMoney: { amount: string } };
        }[];
      };
    } | null;
  }>(
    `query($id: ID!) {
      order(id: $id) {
        id name createdAt cancelledAt displayFulfillmentStatus tags email
        totalPriceSet { shopMoney { amount } }
        totalOutstandingSet { shopMoney { amount } }
        totalShippingPriceSet { shopMoney { amount } }
        totalDiscountsSet { shopMoney { amount } }
        advanceUnrecorded: metafield(namespace: "wacrm", key: "advance_unrecorded") { value }
        awb: metafield(namespace: "wacrm", key: "shiprocket_awb") { value }
        shippingAddress { firstName lastName address1 address2 city province zip country phone }
        lineItems(first: 30) { nodes { name sku quantity originalUnitPriceSet { shopMoney { amount } } } }
      }
    }`,
    { id: orderGid(orderId) }
  );
  const o = data.order;
  if (!o) return null;
  const n = (m: { shopMoney: { amount: string } }) =>
    Number(m.shopMoney.amount) || 0;
  return {
    id: o.id.split('/').pop() as string,
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    tags: o.tags,
    email: o.email,
    total: n(o.totalPriceSet),
    outstanding: n(o.totalOutstandingSet),
    shipping: n(o.totalShippingPriceSet),
    discount: n(o.totalDiscountsSet),
    advanceUnrecorded: Number(o.advanceUnrecorded?.value ?? 0) || 0,
    address: o.shippingAddress,
    items: o.lineItems.nodes
      .filter((l) => l.quantity > 0)
      .map((l) => ({
        name: l.name,
        sku: l.sku,
        quantity: l.quantity,
        price: n(l.originalUnitPriceSet),
      })),
    awb: o.awb?.value ?? null,
  };
}

/** Cash the courier should collect: what Shopify says is outstanding,
 *  minus a Razorpay advance Shopify couldn't record (non-Plus store). */
export function amountDue(
  o: Pick<ShopifyOrderForShipping, 'outstanding' | 'advanceUnrecorded'>
): number {
  return Math.max(
    0,
    Math.round((o.outstanding - o.advanceUnrecorded) * 100) / 100
  );
}

export function orderRef(name: string): string {
  return name.replace(/^#/, '').trim();
}

function digits(phone: string | null | undefined): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

function parcel(units: number): {
  weight: number;
  length: number;
  breadth: number;
  height: number;
} {
  const perUnit = Number(process.env.SHIPROCKET_WEIGHT_PER_UNIT_KG) || 0.25;
  const [l, b, h] = (process.env.SHIPROCKET_DIMENSIONS_CM || '15x10x8')
    .split('x')
    .map((x) => Number(x) || 10);
  return {
    weight: Math.max(0.2, Math.round(units * perUnit * 100) / 100),
    length: l,
    breadth: b,
    height: h,
  };
}

/** Shiprocket adhoc order payload. COD orders collect only `due`. */
export function buildShiprocketPayload(
  o: ShopifyOrderForShipping,
  pickupLocation: string,
  due: number,
  channelOrderId = orderRef(o.name)
): Record<string, unknown> {
  const a = o.address!;
  const units = o.items.reduce((s, i) => s + i.quantity, 0) || 1;
  const prepaid = due <= 0;
  const created = new Date(o.createdAt);
  const ist = new Date(created.getTime() + 330 * 60 * 1000);
  const orderDate = ist.toISOString().slice(0, 16).replace('T', ' ');
  return {
    order_id: channelOrderId,
    order_date: orderDate,
    pickup_location: pickupLocation,
    billing_customer_name: a.firstName || 'Customer',
    billing_last_name: a.lastName || '',
    billing_address: a.address1 || '',
    billing_address_2: a.address2 || '',
    billing_city: a.city || '',
    billing_pincode: (a.zip || '').replace(/\s/g, ''),
    billing_state: a.province || '',
    billing_country: a.country || 'India',
    billing_email:
      o.email ||
      process.env.SHIPROCKET_FALLBACK_EMAIL ||
      'orders@hindrishi.com',
    billing_phone: digits(a.phone),
    shipping_is_billing: true,
    order_items: o.items.map((i) => ({
      name: i.name.slice(0, 100),
      sku: i.sku || i.name.slice(0, 40),
      units: i.quantity,
      selling_price: i.price,
    })),
    payment_method: prepaid ? 'Prepaid' : 'COD',
    shipping_charges: o.shipping,
    // Shiprocket collects sub_total on COD shipments. For a part-paid
    // order that's only the balance; the advance shows as a discount.
    total_discount: prepaid
      ? o.discount
      : Math.round((o.total - due) * 100) / 100,
    sub_total: prepaid ? o.total : due,
    ...parcel(units),
  };
}

function matchShiprocketOrder(
  orders: SrOrder[],
  o: ShopifyOrderForShipping
): SrOrder | null {
  const ref = orderRef(o.name);
  return (
    orders.find((s) => {
      if (/cancel/i.test(String(s.status ?? ''))) return false;
      const c = String(s.channel_order_id ?? '').replace(/^#/, '');
      return c === ref || c === o.id;
    }) ?? null
  );
}

/** Release the booking claim so a fixed order can be retried (an AWB
 *  already assigned is reused from Shiprocket, so nothing is booked twice). */
async function releaseClaim(orderId: string): Promise<void> {
  await shopifyGraphql(
    `mutation($m: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $m) { userErrors { message } }
    }`,
    {
      m: [
        {
          ownerId: orderGid(orderId),
          namespace: 'wacrm',
          key: 'shiprocket_booking',
        },
      ],
    }
  ).catch((e) => console.warn('[shiprocket] releasing claim failed:', e));
}

async function fail(
  orderId: string,
  reason: string,
  claimed = false
): Promise<DispatchOutcome> {
  console.error(`[shiprocket] ${orderId}: ${reason}`);
  if (claimed) await releaseClaim(orderId);
  await updateOrderTags(orderId, [SR_TAGS.error], [SR_TAGS.pending]).catch(
    () => {}
  );
  await appendOrderNote(orderId, `Shiprocket: ${reason}`).catch(() => {});
  return 'error';
}

export async function dispatchOrder(
  orderId: number | string,
  trigger: string
): Promise<DispatchOutcome> {
  const id = String(orderId);
  if (!shiprocketConfigured()) return 'not_configured';
  const o = await loadOrder(id);
  if (!o || o.cancelledAt) return 'skipped';
  if (
    o.tags.includes(SR_TAGS.ready) ||
    o.tags.includes(SR_TAGS.printed) ||
    o.awb
  ) {
    return 'already_done';
  }
  if (o.displayFulfillmentStatus === 'FULFILLED') return 'skipped';
  if (!o.address?.zip || !o.address.address1) {
    return fail(
      id,
      'shipping address missing — add it in Shopify, then tag RTD again'
    );
  }

  const due = amountDue(o);
  let claimed = false;
  try {
    const locations = await pickupLocations();
    const wanted = process.env.SHIPROCKET_PICKUP_LOCATION;
    const pickup =
      locations.find((l) => l.pickup_location === wanted) ??
      locations.find((l) => l.is_primary_location === 1) ??
      locations[0];
    if (!pickup) return fail(id, 'no pickup location set up in Shiprocket');

    // Reuse the order if the Shopify channel already synced it; give the
    // sync a few minutes before creating it ourselves (avoids duplicates).
    const existing = matchShiprocketOrder(
      await findOrders(orderRef(o.name)),
      o
    );
    const age = Date.now() - new Date(o.createdAt).getTime();
    if (
      !existing &&
      age < SYNC_WAIT_MS &&
      process.env.SHIPROCKET_CREATE_ORDERS !== 'always'
    ) {
      await updateOrderTags(id, [SR_TAGS.pending], []);
      return 'waiting_for_sync';
    }

    let shipmentId = existing?.shipments?.[0]?.id ?? null;
    const existingAwb = existing?.shipments?.[0]?.awb || null;
    const paymentOk =
      existing &&
      ((due <= 0 && /prepaid/i.test(existing.payment_method)) ||
        (due > 0 &&
          /cod/i.test(existing.payment_method) &&
          Number(existing.total) === due));

    if (!existing || (!paymentOk && !existingAwb)) {
      // Shiprocket won't edit orders its Shopify channel synced ("Order
      // doesn't exist" on update). If the synced copy has the wrong
      // payment (e.g. full COD after a ₹100 advance, or COD after the
      // customer paid online) and isn't booked yet, cancel it and create
      // a correct one instead.
      if (existing) {
        await cancelOrders([existing.id]);
        shipmentId = null;
      }
      const payload = buildShiprocketPayload(o, pickup.pickup_location, due);
      const res = await createOrUpdateOrder(payload, false);
      shipmentId = res.shipment_id ?? null;
      if (!shipmentId) {
        const again = matchShiprocketOrder(
          await findOrders(orderRef(o.name)),
          o
        );
        shipmentId = again?.shipments?.[0]?.id ?? null;
      }
    }
    if (!shipmentId) return fail(id, 'Shiprocket did not return a shipment id');

    // From here on, money is spent — make sure only one run books it.
    if ((await claimOrderOnce(id, 'shiprocket_booking')) === 'taken')
      return 'already_done';
    claimed = true;

    let awb = existingAwb;
    let courierName = existing?.shipments?.[0]?.courier ?? '';
    if (!awb) {
      const p = parcel(o.items.reduce((s, i) => s + i.quantity, 0) || 1);
      const { couriers, recommended } = await serviceability({
        pickup: String(pickup.pin_code),
        delivery: (o.address.zip || '').replace(/\s/g, ''),
        cod: due > 0,
        weight: p.weight,
        value: o.total,
      });
      const courier = chooseCourier(couriers, recommended);
      if (!courier)
        return fail(id, `no courier serves pincode ${o.address.zip}`, claimed);
      const assigned = await assignAwb(shipmentId, courier.courier_company_id);
      awb = assigned.awb;
      courierName = assigned.courier || courier.courier_name;
      await requestPickup(shipmentId).catch((e) =>
        console.warn(
          `[shiprocket] pickup request for ${o.name} failed (book it in Shiprocket):`,
          e
        )
      );
    }

    const label = await generateLabel(shipmentId);
    await setOrderMetafield(id, 'shiprocket_awb', awb);
    await setOrderMetafield(id, 'shiprocket_label', label);
    await updateOrderTags(
      id,
      [SR_TAGS.ready],
      [SR_TAGS.pending, SR_TAGS.error]
    );
    await appendOrderNote(
      id,
      `Shiprocket: AWB ${awb}${courierName ? ` via ${courierName}` : ''} · ${
        due > 0 ? `COD ₹${due}` : 'Prepaid'
      } · label ready (${trigger})`
    ).catch(() => {});
    console.log(
      `[shiprocket] ${o.name}: AWB ${awb} ${courierName} (${trigger})`
    );
    return 'label_ready';
  } catch (err) {
    const msg =
      err instanceof ShiprocketError || err instanceof Error
        ? err.message
        : String(err);
    return fail(id, msg.slice(0, 300), claimed);
  }
}

/** Orders waiting for a label: tagged RTD or SR-Pending, not yet labelled. */
export async function findOrdersToDispatch(): Promise<string[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const q =
    `(tag:'${SR_TAGS.rtd}' OR tag:'${SR_TAGS.pending}') -tag:'${SR_TAGS.ready}' ` +
    `-tag:'${SR_TAGS.printed}' -tag:'${SR_TAGS.error}' status:open created_at:>='${since}'`;
  const data = await shopifyGraphql<{ orders: { nodes: { id: string }[] } }>(
    `query($q: String!) { orders(first: 50, query: $q, sortKey: CREATED_AT) { nodes { id } } }`,
    { q }
  );
  return data.orders.nodes.map((n) => n.id.split('/').pop() as string);
}

export interface LabelToPrint {
  orderId: string;
  name: string;
  labelUrl: string;
}

/** Labels generated but not printed yet (for the laptop print agent). */
export async function labelsToPrint(): Promise<LabelToPrint[]> {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const data = await shopifyGraphql<{
    orders: {
      nodes: { id: string; name: string; label: { value: string } | null }[];
    };
  }>(
    `query($q: String!) {
      orders(first: 50, query: $q, sortKey: CREATED_AT) {
        nodes { id name label: metafield(namespace: "wacrm", key: "shiprocket_label") { value } }
      }
    }`,
    {
      q: `tag:'${SR_TAGS.ready}' -tag:'${SR_TAGS.printed}' created_at:>='${since}'`,
    }
  );
  return data.orders.nodes
    .filter((n) => n.label?.value)
    .map((n) => ({
      orderId: n.id.split('/').pop() as string,
      name: n.name,
      labelUrl: n.label!.value,
    }));
}

export async function markPrinted(orderId: string): Promise<void> {
  await updateOrderTags(orderId, [SR_TAGS.printed], []);
}
