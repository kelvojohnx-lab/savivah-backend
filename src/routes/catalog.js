const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// ---- Public marketplace browsing ----
router.get("/products", async (req, res) => {
  const { search, category } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT p.*, s.name AS store_name, s.verified AS store_verified
       FROM products p JOIN stores s ON s.id = p.store_id
       WHERE p.status = 'active'
         AND ($1::text IS NULL OR p.name ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR p.category = $2)
       ORDER BY p.is_featured DESC, p.created_at DESC`,
      [search || null, category || null]
    );
    res.json(rows);
  } catch (e) {
    console.error("GET /products failed:", e.message);
    res.status(503).json({ error: "Database unavailable. Check DATABASE_URL is set correctly." });
  }
});

// ---- Seller: create a store ----
router.post("/stores", requireAuth, requireRole("seller"), async (req, res) => {
  const { name, businessRegNumber, payoutMethod, payoutAccount } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  try {
    const { rows } = await pool.query(
      `INSERT INTO stores (owner_id, name, slug, business_reg_number, payout_method, payout_account, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.id, name, slug, businessRegNumber || null, payoutMethod, payoutAccount, !!businessRegNumber]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "You already have a store with that name" });
    console.error("Create store failed:", e.message);
    res.status(500).json({ error: "Could not create store" });
  }
});

// ---- Seller: see all stores I own ----
router.get("/my/stores", requireAuth, requireRole("seller"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM stores WHERE owner_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
});

// ---- Seller: list a product on their store ----
router.post("/stores/:storeId/products", requireAuth, requireRole("seller"), async (req, res) => {
  const { name, description, category, price, stock, imageUrl } = req.body;
  const store = await pool.query(`SELECT owner_id FROM stores WHERE id = $1`, [req.params.storeId]);
  if (store.rows[0]?.owner_id !== req.user.id) return res.status(403).json({ error: "Not your store" });

  const { rows } = await pool.query(
    `INSERT INTO products (store_id, name, description, category, price, stock, image_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.params.storeId, name, description, category, price, stock, imageUrl]
  );
  res.json(rows[0]);
});

// ---- Seller: see every product in one of my stores (including hidden/out-of-stock — unlike the public /products list) ----
router.get("/stores/:storeId/products", requireAuth, requireRole("seller"), async (req, res) => {
  const store = await pool.query(`SELECT owner_id FROM stores WHERE id = $1`, [req.params.storeId]);
  if (store.rows[0]?.owner_id !== req.user.id) return res.status(403).json({ error: "Not your store" });

  const { rows } = await pool.query(
    `SELECT * FROM products WHERE store_id = $1 ORDER BY created_at DESC`,
    [req.params.storeId]
  );
  res.json(rows);
});

// ---- Seller: edit one of my products ----
router.put("/products/:id", requireAuth, requireRole("seller"), async (req, res) => {
  const { name, description, category, price, stock, imageUrl, status } = req.body;
  const owned = await pool.query(
    `SELECT p.id FROM products p JOIN stores s ON s.id = p.store_id WHERE p.id = $1 AND s.owner_id = $2`,
    [req.params.id, req.user.id]
  );
  if (owned.rowCount === 0) return res.status(403).json({ error: "Not your product" });

  const { rows } = await pool.query(
    `UPDATE products SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       category = COALESCE($3, category),
       price = COALESCE($4, price),
       stock = COALESCE($5, stock),
       image_url = COALESCE($6, image_url),
       status = COALESCE($7, status)
     WHERE id = $8 RETURNING *`,
    [name, description, category, price, stock, imageUrl, status, req.params.id]
  );
  res.json(rows[0]);
});

// ---- Seller: orders for their store ----
router.get("/stores/:storeId/orders", requireAuth, requireRole("seller"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, json_agg(oi.*) AS items
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE o.store_id = $1 GROUP BY o.id ORDER BY o.created_at DESC`,
    [req.params.storeId]
  );
  res.json(rows);
});

module.exports = router;
