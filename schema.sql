-- Savivah Global Products — PostgreSQL schema
-- Run against a fresh database: psql -d savivah -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------- Users & auth ----------
-- One table for everyone; a user can be a customer and later also own a store.
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    phone_number    TEXT UNIQUE,               -- nullable: Google sign-in doesn't provide one
    password_hash   TEXT,                       -- nullable: Google-only accounts have no password
    role            TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'seller', 'admin')),
    national_id     TEXT,                      -- required before a seller can list products
    kra_pin         TEXT,                      -- required before a seller can receive payouts
    google_id       TEXT UNIQUE,               -- set when the account signed up/linked via Google
    avatar_url      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Stores ----------
CREATE TABLE stores (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    slug                TEXT UNIQUE NOT NULL,
    business_reg_number TEXT,                  -- null if unregistered seller
    verified            BOOLEAN NOT NULL DEFAULT false,
    payout_method       TEXT CHECK (payout_method IN ('mpesa', 'bank')),
    payout_account       TEXT,                  -- M-Pesa number or bank account number
    subscription_plan   TEXT NOT NULL DEFAULT 'none' CHECK (subscription_plan IN ('none', 'monthly', 'yearly')),
    subscription_expires_at TIMESTAMPTZ,
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Products ----------
CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    price           NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    stock           INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    image_url       TEXT,
    is_featured     BOOLEAN NOT NULL DEFAULT false,
    featured_until  TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'out_of_stock')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_store ON products(store_id);
CREATE INDEX idx_products_category ON products(category);

-- ---------- Orders ----------
-- One "order" = one customer's items from one store (a multi-store cart splits into several orders).
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES users(id),
    store_id            UUID NOT NULL REFERENCES stores(id),
    subtotal            NUMERIC(12,2) NOT NULL,
    commission_rate     NUMERIC(5,4) NOT NULL DEFAULT 0.10,
    commission_amount   NUMERIC(12,2) NOT NULL,
    payout_amount       NUMERIC(12,2) NOT NULL,           -- subtotal - commission
    currency            TEXT NOT NULL DEFAULT 'KES',
    status              TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN (
                            'pending_payment',  -- order created, waiting on Pesapal
                            'escrow_held',       -- payment confirmed, funds held by Savivah
                            'shipped',           -- seller marked as shipped, awaiting delivery
                            'delivered',         -- Fargo confirmed delivery, payout released
                            'delivery_failed',   -- Fargo reported failed delivery
                            'refunded',          -- refunded to customer
                            'disputed'
                         )),
    delivery_address    TEXT NOT NULL,
    shipped_at          TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    payout_released_at  TIMESTAMPTZ,
    auto_release_at     TIMESTAMPTZ,               -- delivered_at + grace window; auto-release deadline
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_store ON orders(store_id);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES products(id),
    product_name    TEXT NOT NULL,   -- snapshot at time of purchase
    unit_price      NUMERIC(12,2) NOT NULL,
    quantity        INTEGER NOT NULL CHECK (quantity > 0)
);

-- ---------- Payments (Pesapal) ----------
CREATE TABLE payments (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id                UUID NOT NULL REFERENCES orders(id),
    pesapal_order_tracking_id  TEXT UNIQUE,
    pesapal_merchant_reference TEXT UNIQUE NOT NULL,   -- our own id, sent to Pesapal
    amount                  NUMERIC(12,2) NOT NULL,
    payment_method          TEXT,                       -- MPESA, VISA, etc. (filled after payment)
    status_code             SMALLINT,                   -- 0 INVALID, 1 COMPLETED, 2 FAILED, 3 REVERSED
    status_description      TEXT,
    confirmation_code       TEXT,
    raw_ipn_payload         JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_order ON payments(order_id);

-- ---------- Deliveries (Fargo) ----------
CREATE TABLE deliveries (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES orders(id) UNIQUE,
    fargo_tracking_id   TEXT UNIQUE,
    proof_of_shipment_url TEXT,               -- receipt/waybill the seller uploads
    status               TEXT NOT NULL DEFAULT 'awaiting_pickup' CHECK (status IN (
                            'awaiting_pickup', 'in_transit', 'delivered', 'failed', 'returned'
                         )),
    attempts            SMALLINT NOT NULL DEFAULT 0,
    last_status_at       TIMESTAMPTZ,
    raw_webhook_payload  JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Disputes ----------
CREATE TABLE disputes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    raised_by       UUID NOT NULL REFERENCES users(id),
    reason          TEXT NOT NULL CHECK (reason IN ('not_delivered', 'item_not_as_described', 'damaged', 'other')),
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_refund', 'resolved_release', 'rejected')),
    resolved_by     UUID REFERENCES users(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Store subscriptions (KES 700/month or 7000/year) ----------
CREATE TABLE subscription_payments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES stores(id),
    plan            TEXT NOT NULL CHECK (plan IN ('monthly', 'yearly')),
    amount          NUMERIC(12,2) NOT NULL,
    pesapal_merchant_reference TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed')),
    period_start    TIMESTAMPTZ,
    period_end      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Featured listings ----------
CREATE TABLE featured_listings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id),
    store_id        UUID NOT NULL REFERENCES stores(id),
    amount_paid     NUMERIC(12,2) NOT NULL,
    starts_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at         TIMESTAMPTZ NOT NULL,
    pesapal_merchant_reference TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Payout ledger (money released to sellers) ----------
CREATE TABLE payouts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id        UUID NOT NULL REFERENCES stores(id),
    order_id        UUID NOT NULL REFERENCES orders(id) UNIQUE,
    amount          NUMERIC(12,2) NOT NULL,
    method          TEXT CHECK (method IN ('mpesa', 'bank')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
