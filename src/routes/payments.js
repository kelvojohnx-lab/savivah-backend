const express = require("express");
const pool = require("../db/pool");
const pesapal = require("../services/pesapal");
const escrow = require("../services/escrow");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// POST /api/checkout
// Body: { storeId, items: [{ productId, quantity }], deliveryAddress }
// Splits nothing here — this endpoint handles ONE store's worth of items.
// The frontend calls this once per store when a cart spans multiple stores.
router.post("/checkout", requireAuth, async (req, res) => {
  const { storeId, items, deliveryAddress } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let subtotal = 0;
    const lineItems = [];
    for (const item of items) {
      const { rows } = await client.query(
        `SELECT * FROM products WHERE id = $1 AND store_id = $2 FOR UPDATE`,
        [item.productId, storeId]
      );
      const product = rows[0];
      if (!product) throw new Error(`Product ${item.productId} not found in this store`);
      if (product.stock < item.quantity) throw new Error(`Insufficient stock for ${product.name}`);
      subtotal += Number(product.price) * item.quantity;
      lineItems.push({ product, quantity: item.quantity });
    }

    const commission = subtotal * escrow.COMMISSION_RATE;
    const payout = subtotal - commission;

    const orderRes = await client.query(
      `INSERT INTO orders (customer_id, store_id, subtotal, commission_rate, commission_amount, payout_amount, delivery_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, storeId, subtotal, escrow.COMMISSION_RATE, commission, payout, deliveryAddress]
    );
    const orderId = orderRes.rows[0].id;

    for (const li of lineItems) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, li.product.id, li.product.name, li.product.price, li.quantity]
      );
      await client.query(`UPDATE products SET stock = stock - $1 WHERE id = $2`, [li.quantity, li.product.id]);
    }

    const merchantReference = `SVH-${orderId.slice(0, 8)}-${Date.now()}`;
    await client.query(
      `INSERT INTO payments (order_id, pesapal_merchant_reference, amount) VALUES ($1, $2, $3)`,
      [orderId, merchantReference, subtotal]
    );

    await client.query("COMMIT");

    // Pesapal call happens after the DB commit so a Pesapal outage never leaves
    // half-written order data.
    const pesapalOrder = await pesapal.submitOrderRequest({
      merchantReference,
      amount: subtotal,
      description: `Savivah order ${orderId.slice(0, 8)}`,
      customer: {
        email: req.user.email,
        phone: req.user.phone,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
      },
    });

    await pool.query(
      `UPDATE payments SET pesapal_order_tracking_id = $1 WHERE pesapal_merchant_reference = $2`,
      [pesapalOrder.order_tracking_id, merchantReference]
    );

    res.json({ orderId, redirectUrl: pesapalOrder.redirect_url });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/payments/callback — Pesapal redirects the customer's browser here after payment.
// Per Pesapal's docs, the callback params never carry payment status — always re-check via GetTransactionStatus.
router.get("/callback", async (req, res) => {
  const { OrderTrackingId } = req.query;
  try {
    const status = await pesapal.getTransactionStatus(OrderTrackingId);
    if (status.status_code === 1) {
      const { rows } = await pool.query(
        `SELECT order_id FROM payments WHERE pesapal_order_tracking_id = $1`,
        [OrderTrackingId]
      );
      if (rows[0]) await escrow.confirmPaymentEscrow(rows[0].order_id);
    }
    // Redirect the customer to a real page in your app, e.g.:
    res.redirect(`${process.env.FRONTEND_URL}/orders?payment=${status.payment_status_description}`);
  } catch (e) {
    res.redirect(`${process.env.FRONTEND_URL}/orders?payment=error`);
  }
});

// POST /api/payments/ipn — Pesapal's server-to-server Instant Payment Notification.
// This is the reliable source of truth; the callback above is only for the customer's browser.
router.post("/ipn", express.json(), async (req, res) => {
  const { OrderTrackingId, OrderMerchantReference } = req.body;
  try {
    const status = await pesapal.getTransactionStatus(OrderTrackingId);
    await pool.query(
      `UPDATE payments SET status_code = $1, status_description = $2,
        payment_method = $3, confirmation_code = $4, raw_ipn_payload = $5, updated_at = now()
       WHERE pesapal_order_tracking_id = $6`,
      [status.status_code, status.payment_status_description, status.payment_method,
       status.confirmation_code, JSON.stringify(req.body), OrderTrackingId]
    );
    if (status.status_code === 1) {
      const { rows } = await pool.query(
        `SELECT order_id FROM payments WHERE pesapal_order_tracking_id = $1`,
        [OrderTrackingId]
      );
      if (rows[0]) await escrow.confirmPaymentEscrow(rows[0].order_id);
    }
    // Pesapal expects this exact response shape to acknowledge the IPN.
    res.json({
      orderNotificationType: "IPNCHANGE",
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 200,
    });
  } catch (e) {
    res.json({
      orderNotificationType: "IPNCHANGE",
      orderTrackingId: OrderTrackingId,
      orderMerchantReference: OrderMerchantReference,
      status: 500,
    });
  }
});

module.exports = router;
