# Savivah backend

Node/Express + PostgreSQL API for the Savivah marketplace: multi-vendor stores,
escrow-held payments via Pesapal, and delivery tracking via Fargo.

## Setup

```bash
npm install
cp .env.example .env      # fill in real values
psql -d savivah -f schema.sql
npm run register-ipn      # once — copy the printed ipn_id into .env as PESAPAL_IPN_ID
npm run dev
```

You'll need a public URL for `PESAPAL_CALLBACK_URL` and the IPN endpoint during
development (e.g. an `ngrok` tunnel) — Pesapal cannot reach `localhost`.

## How the money flow maps to code

1. **Checkout** (`POST /api/checkout`) — creates an `orders` row with status
   `pending_payment`, snapshots the cart into `order_items`, decrements stock,
   then calls Pesapal's `SubmitOrderRequest` and returns `redirectUrl` for the
   frontend to send the customer to.
2. **Payment confirmation** — Pesapal calls our `/api/payments/ipn` webhook
   (source of truth) and redirects the browser to `/api/payments/callback`.
   Both re-check the real status via `GetTransactionStatus` before trusting it,
   per Pesapal's own docs — the callback/IPN params never carry status directly.
   On `COMPLETED`, the order moves to `escrow_held`.
3. **Shipping** (`POST /api/orders/:id/ship`) — seller must attach a Fargo
   tracking ID and proof-of-shipment URL; without both, the request is
   rejected — this is the "seller must provide proof of shipment" rule from
   the business model.
4. **Delivery** (`POST /api/orders/webhooks/fargo`) — Fargo posts status
   changes here. `delivered` starts a 5-day auto-release countdown
   (`auto_release_at`); `failed` twice in a row triggers an automatic refund.
5. **Payout release** — either the customer confirms early
   (`POST /api/orders/:id/confirm-receipt`) or the scheduled sweep in
   `src/index.js` releases it automatically once `auto_release_at` passes with
   no open dispute. Releasing creates a `payouts` row — wiring that to a real
   M-Pesa B2C or bank transfer call is marked with a `TODO`-style comment in
   `src/services/escrow.js`.
6. **Disputes** — a customer can raise one any time before payout release
   (`POST /api/orders/:id/dispute`), which blocks the sweep from paying the
   seller until an admin resolves it (`POST /api/admin/disputes/:id/resolve`).

## Still to wire up for production

- Fargo's real webhook payload shape and signature verification — this repo
  assumes `{ fargo_tracking_id, status }`; confirm against Fargo's actual API
  docs once you have partner access.
- Real M-Pesa B2C / bank transfer call inside `releasePayout()` in
  `src/services/escrow.js` — right now it only records the payout as `pending`.
- Pesapal `RefundRequest` call inside `refundOrder()` — currently only flips
  the order status; add the actual refund API call using the stored
  `pesapal_order_tracking_id`.
- File uploads for proof-of-shipment (currently expects a URL — wire to S3 or
  similar).
- Store subscription billing (`subscription_payments` table exists; add a
  route that runs `submitOrderRequest` for the KES 700/7,000 plan and a cron
  to flag `stores.subscription_expires_at` lapses).
- Featured listings checkout (`featured_listings` table exists; pricing model
  still needs to be decided per the business doc).
