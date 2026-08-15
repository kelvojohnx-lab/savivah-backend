// Run once: node scripts/register-ipn.js
// Prints the ipn_id to paste into your .env as PESAPAL_IPN_ID.
require("dotenv").config();
const pesapal = require("../src/services/pesapal");

(async () => {
  const ipnUrl = `${process.env.FRONTEND_URL?.includes("localhost") ? "https://your-public-tunnel-url" : process.env.PESAPAL_CALLBACK_URL.replace("/callback", "")}/ipn`;
  const result = await pesapal.registerIpnUrl(ipnUrl);
  console.log(result);
})();
