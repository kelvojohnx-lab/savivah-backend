const express = require("express");
const pool = require("../db/pool");
const escrow = require("../services/escrow");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// POST /api/orders/:id/ship
// Seller marks an order shipped. Requires proof of shipment already on file —
// this is the rule from the business model: no proof, no shipped status.
router.post("/:id/ship", requireAuth, requireRole("seller"), async (req, res) => {
  const { fargoTrackingId, proofOfShipmentUrl } = req.body;
  if (!fargoTrackingId || !proofOfShipmentUrl) {
    return res.status(400).json({ error: "Fargo tracking ID and proof of shipment are required" });
  }
  await pool.query(
    `INSERT INTO deliveries (order_id, fargo_tracking_id, proof_of_shipment_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id) DO UPDATE SET fargo_tracking_id = $2, proof_of_shipment_url = $3`,
    [req.params.id, fargoTrackingId, proofOfShipmentUrl]
  );
  await escrow.markShipped(req.params.id);
  res.json({ ok: true });
});

// POST /api/webhooks/fargo — Fargo calls this when a delivery's status changes.
// Verify this request is genuinely from Fargo (shared secret / signature header)
// before trusting it in production — left as a config step here.
router.post("/webhooks/fargo", express.json(), async (req, res) => {
  const { fargo_tracking_id, status } = req.body; // status: 'in_transit' | 'delivered' | 'failed'
  const { rows } = await pool.query(
    `SELECT order_id FROM deliveries WHERE fargo_tracking_id = $1`,
    [fargo_tracking_id]
  );
  if (!rows[0]) return res.status(404).json({ error: "Unknown tracking id" });
  const orderId = rows[0].order_id;

  await pool.query(
    `UPDATE deliveries SET status = $1, last_status_at = now(), raw_webhook_payload = $2,
       attempts = attempts + CASE WHEN $1 = 'failed' THEN 1 ELSE 0 END
     WHERE fargo_tracking_id = $3`,
    [status, JSON.stringify(req.body), fargo_tracking_id]
  );

  if (status === "delivered") {
    await escrow.markDeliveredAwaitingRelease(orderId);
  } else if (status === "failed") {
    const { rows: d } = await pool.query(`SELECT attempts FROM deliveries WHERE fargo_tracking_id = $1`, [fargo_tracking_id]);
    if (d[0].attempts >= 2) {
      // second failed attempt — auto-refund per the business rule
      await escrow.refundOrder(orderId);
    }
  }
  res.json({ ok: true });
});

// POST /api/orders/:id/confirm-receipt — customer confirms early, releasing payout immediately
// instead of waiting for the auto-release window.
router.post("/:id/confirm-receipt", requireAuth, async (req, res) => {
  try {
    await escrow.releasePayout(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// POST /api/orders/:id/dispute — customer raises "not delivered" / "item not as described" / "damaged".
// Raising a dispute blocks payout release until an admin resolves it.
router.post("/:id/dispute", requireAuth, async (req, res) => {
  const { reason, description } = req.body;
  await pool.query(
    `INSERT INTO disputes (order_id, raised_by, reason, description) VALUES ($1, $2, $3, $4)`,
    [req.params.id, req.user.id, reason, description]
  );
  await pool.query(`UPDATE orders SET status = 'disputed' WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

// POST /api/admin/disputes/:id/resolve — admin decides refund vs release.
router.post("/admin/disputes/:id/resolve", requireAuth, requireRole("admin"), async (req, res) => {
  const { resolution } = req.body; // 'refund' | 'release' | 'reject'
  const { rows } = await pool.query(`SELECT order_id FROM disputes WHERE id = $1`, [req.params.id]);
  const orderId = rows[0]?.order_id;
  if (!orderId) return res.status(404).json({ error: "Dispute not found" });

  const statusMap = { refund: "resolved_refund", release: "resolved_release", reject: "rejected" };
  await pool.query(`UPDATE disputes SET status = $1, resolved_by = $2, resolved_at = now() WHERE id = $3`,
    [statusMap[resolution], req.user.id, req.params.id]);

  if (resolution === "refund") await escrow.refundOrder(orderId);
  if (resolution === "release" || resolution === "reject") await escrow.releasePayout(orderId);

  res.json({ ok: true });
});

module.exports = router;
