const pool = require("../db/pool");

const COMMISSION_RATE = 0.10;
const AUTO_RELEASE_DAYS = 5; // if customer never confirms, release funds this many days after Fargo marks "delivered"

// Called once GetTransactionStatus confirms a Pesapal payment as COMPLETED.
async function confirmPaymentEscrow(orderId) {
  await pool.query(
    `UPDATE orders SET status = 'escrow_held' WHERE id = $1 AND status = 'pending_payment'`,
    [orderId]
  );
}

// Called when the seller marks an order shipped (with proof of shipment already attached
// to the deliveries table). Without proof, this route should reject the request upstream.
async function markShipped(orderId) {
  await pool.query(
    `UPDATE orders SET status = 'shipped', shipped_at = now() WHERE id = $1 AND status = 'escrow_held'`,
    [orderId]
  );
}

// Called from the Fargo delivery webhook when status = 'delivered'.
// Starts the auto-release countdown rather than releasing immediately, so the
// customer has a window to raise a dispute (item not as described / damaged).
async function markDeliveredAwaitingRelease(orderId) {
  await pool.query(
    `UPDATE orders
     SET status = 'delivered', delivered_at = now(),
         auto_release_at = now() + interval '${AUTO_RELEASE_DAYS} days'
     WHERE id = $1 AND status = 'shipped'`,
    [orderId]
  );
}

// Releases escrow funds to the seller: creates a payout record.
// Call this either when the customer explicitly confirms receipt, or via the
// scheduled job below once auto_release_at has passed with no open dispute.
async function releasePayout(orderId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.*, s.payout_method, s.payout_account
       FROM orders o JOIN stores s ON s.id = o.store_id
       WHERE o.id = $1 FOR UPDATE`,
      [orderId]
    );
    const order = rows[0];
    if (!order) throw new Error("Order not found");

    const openDispute = await client.query(
      `SELECT 1 FROM disputes WHERE order_id = $1 AND status = 'open'`,
      [orderId]
    );
    if (openDispute.rowCount > 0) throw new Error("Cannot release payout while a dispute is open");

    await client.query(
      `INSERT INTO payouts (store_id, order_id, amount, method, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [order.store_id, order.id, order.payout_amount, order.payout_method]
    );
    // In production: trigger an actual M-Pesa B2C or bank transfer here, then
    // update the payout row's status to 'sent' once the transfer confirms.
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// No proof of shipment, delivery failed with no reattempt, or an upheld dispute.
async function refundOrder(orderId) {
  await pool.query(
    `UPDATE orders SET status = 'refunded' WHERE id = $1`,
    [orderId]
  );
  // In production: trigger a Pesapal RefundRequest call here using the stored
  // pesapal_order_tracking_id, then record the result on the payments row.
}

// Intended to run as a scheduled job (e.g. every 15 min) to auto-release orders
// whose grace window has passed with no dispute raised.
async function runAutoReleaseSweep() {
  const { rows } = await pool.query(
    `SELECT id FROM orders
     WHERE status = 'delivered' AND auto_release_at <= now()
     AND id NOT IN (SELECT order_id FROM disputes WHERE status = 'open')`
  );
  for (const row of rows) {
    await releasePayout(row.id);
  }
  return rows.length;
}

module.exports = {
  COMMISSION_RATE,
  confirmPaymentEscrow,
  markShipped,
  markDeliveredAwaitingRelease,
  releasePayout,
  refundOrder,
  runAutoReleaseSweep,
};
