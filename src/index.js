require("dotenv").config();
const express = require("express");
const cors = require("cors");
const escrow = require("./services/escrow");

const authRoutes = require("./routes/auth");
const catalogRoutes = require("./routes/catalog");
const paymentRoutes = require("./routes/payments");
const orderRoutes = require("./routes/orders");
const adminRoutes = require("./routes/admin");

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api", catalogRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/admin", adminRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

// Auto-release sweep: releases payouts for orders whose grace window has passed
// with no open dispute. Runs every 15 minutes.
setInterval(() => {
  escrow.runAutoReleaseSweep().catch((e) => console.error("Auto-release sweep failed:", e));
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Savivah API listening on port ${PORT}`));
