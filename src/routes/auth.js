const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { verifyGoogleToken } = require("../services/google");

const router = express.Router();

// Anyone registering with a @savivah.co.ke email is treated as staff and
// gets the admin role automatically — this is the "admin by default" rule.
// Everyone else gets whichever role they picked (seller or customer).
function resolveRole(email, requestedRole) {
  if (email.toLowerCase().endsWith("@savivah.co.ke")) return "admin";
  return requestedRole === "seller" ? "seller" : "customer";
}

function issueToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function publicUser(user) {
  return { id: user.id, fullName: user.full_name, email: user.email, role: user.role, avatarUrl: user.avatar_url };
}

router.post("/register", async (req, res) => {
  const { fullName, email, phoneNumber, password, role } = req.body;
  if (!fullName || !email || !phoneNumber || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const assignedRole = resolveRole(email, role);
    const { rows } = await pool.query(
      `INSERT INTO users (full_name, email, phone_number, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [fullName, email, phoneNumber, passwordHash, assignedRole]
    );
    const user = rows[0];
    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Email or phone already registered" });
    console.error("Registration failed:", e.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    const user = rows[0];
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("Login failed:", e.message);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// POST /api/auth/google
// Body: { idToken, role? }  — idToken comes from Google Identity Services on
// the frontend. `role` (seller|customer) only matters the first time a given
// Google account signs in; after that their existing role is used.
router.post("/google", async (req, res) => {
  const { idToken, role } = req.body;
  if (!idToken) return res.status(400).json({ error: "Missing Google idToken" });
  try {
    const payload = await verifyGoogleToken(idToken);
    if (!payload.email_verified) {
      return res.status(401).json({ error: "Google account email is not verified" });
    }

    const { rows } = await pool.query(
      `SELECT * FROM users WHERE google_id = $1 OR email = $2`,
      [payload.sub, payload.email]
    );
    let user = rows[0];

    if (!user) {
      const assignedRole = resolveRole(payload.email, role);
      const inserted = await pool.query(
        `INSERT INTO users (full_name, email, password_hash, phone_number, role, google_id, avatar_url)
         VALUES ($1, $2, NULL, NULL, $3, $4, $5) RETURNING *`,
        [payload.name || payload.email, payload.email, assignedRole, payload.sub, payload.picture]
      );
      user = inserted.rows[0];
    } else if (!user.google_id) {
      // An account with this email already existed (e.g. registered via
      // email/password) — link it to this Google identity rather than
      // creating a duplicate.
      const updated = await pool.query(
        `UPDATE users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3 RETURNING *`,
        [payload.sub, payload.picture, user.id]
      );
      user = updated.rows[0];
    }

    res.json({ token: issueToken(user), user: publicUser(user) });
  } catch (e) {
    console.error("Google sign-in failed:", e.message);
    res.status(401).json({ error: "Google sign-in failed" });
  }
});

module.exports = router;
