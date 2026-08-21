// Verifies a Google Identity Services ID token from the frontend's "Continue
// with Google" button. GOOGLE_CLIENT_ID must match the OAuth Client ID from
// Google Cloud Console (Credentials > OAuth 2.0 Client IDs > Web application).
const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function verifyGoogleToken(idToken) {
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  return ticket.getPayload(); // { sub, email, email_verified, name, picture, ... }
}

module.exports = { verifyGoogleToken };
