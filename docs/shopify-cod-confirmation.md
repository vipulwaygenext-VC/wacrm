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
Namaste {{1}}, Hindrishi par aapka order #{{2}} mil gaya hai.
Product: {{3}}
Amount: ₹{{4}} (Cash on Delivery)
Kripya neeche button dabakar confirm karein, taaki hum aaj hi dispatch kar sakein.
Koi bhi sawaal ho toh humein 9278142142 par call karein.
```

Buttons (both **Quick reply**, in this order): `Confirm Order`, `Cancel Order`.

And a second **Utility** template named `prepaid_order_confirmation`, language
`en`, with no buttons:

```
Namaste {{1}}, Hindrishi par aapka order #{{2}} confirm ho gaya hai.
Product: {{3}}
Amount: ₹{{4}} (Paid)
Hum ise jaldi dispatch karenge aur tracking link WhatsApp par bhejenge.
Koi bhi sawaal ho toh humein 9278142142 par call karein.
```

After Meta approves it, run **Settings → Templates → Sync from Meta** in the CRM.

## 2. Shopify app (Dev Dashboard)

Shopify admin no longer creates legacy custom apps. Instead: Settings → Apps →
Develop apps → **Build apps in Dev Dashboard** → Create app. Give it the Admin
API scopes `read_orders` and `write_orders`, release a version, and install it
on the store. From **App settings** copy the **Client ID** and **Client secret**.

## 3. Vercel environment variables

| Variable | Value |
| --- | --- |
| `SHOPIFY_STORE_DOMAIN` | `hindrishi-ayurveda.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | Client ID from step 2 |
| `SHOPIFY_CLIENT_SECRET` | Client secret from step 2 |
| `SHOPIFY_WEBHOOK_SECRET` | signing secret from step 4 |
| `SHOPIFY_WACRM_ACCOUNT_ID` | optional — only needed when the CRM has more than one WhatsApp account (Supabase `accounts.id`) |
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

## Optional: ₹100 advance via Razorpay

When `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set, COD orders above
the advance amount get the `cod_order_advance` template instead. It has a
third **URL** button, "Pay ₹100 Advance", that opens
`https://wacrm-zwrx-1.vercel.app/pay/<token>`. That page creates (or reuses)
a Razorpay Payment Link for the order and redirects to Razorpay's hosted
checkout. When Razorpay reports `payment_link.paid`, the order gets a manual
payment of ₹100 (so the amount due on delivery drops) and the tag
`WA-Advance-Paid`.

Template `cod_order_advance` (Utility, `en`):

```
Namaste {{1}}, Hindrishi par aapka order #{{2}} mil gaya hai.
Product: {{3}}
Amount: ₹{{4}} (Cash on Delivery)
Kripya Confirm dabayein, taaki hum aaj hi dispatch kar sakein.

Chahein toh abhi sirf ₹100 advance pay karein, baaki ₹{{5}} delivery par.
Payment Razorpay ke secure page par hota hai, Hindrishi ke naam se. Hum kabhi OTP, PIN ya password nahi maangte.
Koi bhi sawaal ho toh humein 9278142142 par call karein.
```

Buttons, in this order: Quick reply `Confirm Order`, Quick reply
`Cancel Order`, Visit website `Pay ₹100 Advance` with dynamic URL
`https://wacrm-zwrx-1.vercel.app/pay/{{1}}`.

Razorpay setup: Dashboard → Account & Settings → API Keys (copy Key ID and
Secret), and Webhooks → Add webhook URL
`https://wacrm-zwrx-1.vercel.app/api/integrations/razorpay/webhook`, event
`payment_link.paid`, with a secret of your choice.

| Variable | Value |
| --- | --- |
| `RAZORPAY_KEY_ID` | Razorpay Key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | the webhook secret you chose |
| `SHOPIFY_ADVANCE_AMOUNT` | optional, default `100` |
| `SHOPIFY_COD_ADVANCE_TEMPLATE_NAME` | optional, default `cod_order_advance` |
