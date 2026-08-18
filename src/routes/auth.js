const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const router = express.Router();

router.post("/register", async (req, res) => {
  const { fullName, email, phoneNumber, password, role } = req.body;
  if (!fullName || !email || !phoneNumber || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone_number, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name, email, role`,
      [fullName, email, phoneNumber, passwordHash, role === "seller" ? "seller" : "customer"]
    );
    const user = rows[0];
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email or phone already registered" });
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role } });
  } catch (e) {
    console.error("Login failed:", e.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

module.exports = router;
