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

// Fallback error handler: catches errors passed via next(err), and — combined
// with the process-level handlers below — stops a single failing request
// (e.g. a database connection issue) from taking the whole server down.
app.use((err, req, res, next) => {
  console.error("Unhandled request error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Safety net: log unexpected async errors instead of letting Node crash the process.
// (The real fix for any specific route is still to add try/catch — this just
// prevents one bad request from taking the whole server offline.)
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

// Auto-release sweep: releases payouts for orders whose grace window has passed
// with no open dispute. Runs every 15 minutes.
setInterval(() => {
  escrow.runAutoReleaseSweep().catch((e) => console.error("Auto-release sweep failed:", e));
}, 15 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Savivah API listening on port ${PORT}`));
