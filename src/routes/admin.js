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

module.exports = router;
