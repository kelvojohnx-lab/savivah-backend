const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireRole("admin"));

router.get("/orders", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, s.name AS store_name, d.status AS delivery_status
     FROM orders o
     JOIN stores s ON s.id = o.store_id
     LEFT JOIN deliveries d ON d.order_id = o.id
     ORDER BY o.created_at DESC LIMIT 200`
  );
  res.json(rows);
});

router.get("/stats", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(SUM(commission_amount) FILTER (WHERE status = 'delivered'), 0) AS commission_earned,
      COALESCE(SUM(subtotal) FILTER (WHERE status IN ('escrow_held', 'shipped', 'delivered')), 0) AS in_escrow,
      COUNT(*) AS total_orders
    FROM orders
  `);
  res.json(rows[0]);
});

router.get("/disputes", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM disputes WHERE status = 'open' ORDER BY created_at ASC`
  );
  res.json(rows);
});

// GET /api/admin/sellers — every store with its owner and running totals,
// so admin can see how much each store has earned and how much is still
// sitting in escrow for them.
router.get("/sellers", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      s.id, s.name, s.verified, s.payout_method, s.payout_account, s.created_at,
      u.full_name AS owner_name, u.email AS owner_email,
      COALESCE(SUM(o.payout_amount) FILTER (WHERE o.status IN ('escrow_held', 'shipped')), 0) AS pending_escrow,
      COALESCE(SUM(o.payout_amount) FILTER (WHERE o.status = 'delivered'), 0) AS total_earned,
      COUNT(o.id) AS total_orders
    FROM stores s
    JOIN users u ON u.id = s.owner_id
    LEFT JOIN orders o ON o.store_id = s.id
    GROUP BY s.id, u.full_name, u.email
    ORDER BY s.created_at DESC
  `);
  res.json(rows);
});

// GET /api/admin/payouts — every payout record (money owed or already sent
// to a store), across all stores, for admin to review before dispatching.
router.get("/payouts", async (req, res) => {
  const { status } = req.query; // optional filter: 'pending' | 'sent'
  const { rows } = await pool.query(
    `SELECT p.*, s.name AS store_name, s.payout_method, s.payout_account
     FROM payouts p JOIN stores s ON s.id = p.store_id
     WHERE ($1::text IS NULL OR p.status = $1)
     ORDER BY p.created_at DESC LIMIT 200`,
    [status || null]
  );
  res.json(rows);
});

// POST /api/admin/payouts/:id/mark-sent — admin has manually sent the money
// to the store's M-Pesa/bank account (outside this system) and confirms it
// here. This is the "dispatch" action referenced in the business flow.
router.post("/payouts/:id/mark-sent", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE payouts SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "No pending payout found with that id" });
  res.json(rows[0]);
});

module.exports = router;
