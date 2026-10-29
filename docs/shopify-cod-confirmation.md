# Shopify order confirmation over WhatsApp

New Cash-on-Delivery orders on Shopify get an automatic WhatsApp message with
**Confirm** and **Cancel** buttons. The customer's tap tags the Shopify order.
Prepaid (paid online) orders get a plain confirmation message and are tagged
`WA-Confirmed` straight away. Every message carries the helpline number
(9278142142, override with `SHOPIFY_HELPLINE_NUMBER`).

| Tag | Meaning |
| --- | --- |
| `WA-Sent` | Confirmation sent, no reply yet |
| `WA-Confirmed` | Customer tapped Confirm — ship it |
| `WA-Cancelled` | Customer tapped Cancel |
| `WA-No-Phone` | Order had no usable phone number |
| `WA-Send-Failed` | WhatsApp send failed (check template name / approval) |

Suggested rule for the team: ship `WA-Confirmed` the same day, and ship
`WA-Sent` orders older than 24 hours unless they look risky.

## 1. Create the WhatsApp template

In the CRM, create (or in WhatsApp Manager) a **Utility** template named
`cod_order_confirmation`, language `en`:

```
Namaste {{1}}, Hindrishi Ayurveda par aapka order #{{2}} mil gaya hai.
Product: {{3}}
Amount: ₹{{4}} (Cash on Delivery)
Kripya neeche button dabakar confirm karein, taaki hum aaj hi dispatch kar sakein.
Koi bhi sawaal ho toh humein 9278142142 par call karein.
```

Buttons (both **Quick reply**, in this order): `Confirm Order`, `Cancel Order`.

And a second **Utility** template named `prepaid_order_confirmation`, language
`en`, with no buttons:

```
Namaste {{1}}, Hindrishi Ayurveda par aapka order #{{2}} confirm ho gaya hai.
Product: {{3}}
Amount: ₹{{4}} (Paid)
Hum ise jaldi dispatch karenge aur tracking link WhatsApp par bhejenge.
Koi bhi sawaal ho toh humein 9278142142 par call karein.
```

After Meta approves it, run **Settings → Templates → Sync from Meta** in the CRM.

## 2. Shopify custom app

Shopify admin → Settings → Apps and sales channels → Develop apps → Create app.
Admin API scopes: `read_orders`, `write_orders`. Install it and copy the
Admin API access token.

## 3. Vercel environment variables

| Variable | Value |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `hindrishi-ayurveda.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | token from step 2 |
| `SHOPIFY_WEBHOOK_SECRET` | signing secret from step 4 |
| `SHOPIFY_WACRM_ACCOUNT_ID` | your CRM account id (Supabase `accounts.id`) |
| `SHOPIFY_COD_TEMPLATE_NAME` | optional, default `cod_order_confirmation` |
| `SHOPIFY_COD_TEMPLATE_LANGUAGE` | optional, default `en` |

Redeploy after adding them.

## 4. Shopify webhook

Shopify admin → Settings → Notifications → Webhooks → Create webhook:

- Event: **Order creation**
- Format: JSON
- URL: `https://wacrm-zwrx-1.vercel.app/api/integrations/shopify/orders`

Copy the signing secret shown on that page into `SHOPIFY_WEBHOOK_SECRET`.

## Test

Place a COD test order with your own phone number. You should get the
WhatsApp message within seconds, the order should show `WA-Sent`, and tapping
Confirm should switch it to `WA-Confirmed` and send a thank-you reply.
