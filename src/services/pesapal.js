// Pesapal API 3.0 client
// Docs: https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/api-reference
//
// Flow used by Savivah:
//   1. authenticate()          -> bearer token (expires in 5 min, so we cache + refresh)
//   2. registerIpnUrl()        -> run ONCE at setup, store the returned ipn_id in .env
//   3. submitOrderRequest()    -> called at checkout, returns a redirect_url to send the customer to
//   4. Pesapal redirects customer to callback_url AND calls our IPN endpoint
//   5. getTransactionStatus()  -> called from both the callback route and the IPN webhook
//      to confirm the real payment status (callback/IPN params never carry status themselves)

const BASE_URL = process.env.PESAPAL_ENV === "live"
  ? "https://pay.pesapal.com/v3"
  : "https://cybqa.pesapal.com/pesapalv3";

let cachedToken = null;
let cachedTokenExpiry = 0;

async function authenticate() {
  if (cachedToken && Date.now() < cachedTokenExpiry - 15000) {
    return cachedToken;
  }
  const res = await fetch(`${BASE_URL}/api/Auth/RequestToken`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET,
    }),
  });
  const data = await res.json();
  if (!data.token) {
    throw new Error(`Pesapal auth failed: ${data.error?.message || data.message}`);
  }
  cachedToken = data.token;
  cachedTokenExpiry = new Date(data.expiryDate).getTime();
  return cachedToken;
}

// Run once during setup (or whenever your IPN URL changes). Save the returned
// ipn_id as PESAPAL_IPN_ID in your environment — it's required on every order.
async function registerIpnUrl(ipnUrl) {
  const token = await authenticate();
  const res = await fetch(`${BASE_URL}/api/URLSetup/RegisterIPN`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url: ipnUrl, ipn_notification_type: "POST" }),
  });
  return res.json(); // { ipn_id, url, ipn_status_description, ... }
}

// merchantReference must be unique per attempt: alphanumeric, -, _, ., : only, max 50 chars.
async function submitOrderRequest({
  merchantReference,
  amount,
  description,
  customer,
  branch,
}) {
  const token = await authenticate();
  const res = await fetch(`${BASE_URL}/api/Transactions/SubmitOrderRequest`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      id: merchantReference,
      currency: "KES",
      amount,
      description: description.slice(0, 100),
      callback_url: process.env.PESAPAL_CALLBACK_URL,
      notification_id: process.env.PESAPAL_IPN_ID,
      branch,
      billing_address: {
        email_address: customer.email,
        phone_number: customer.phone,
        country_code: "KE",
        first_name: customer.firstName,
        last_name: customer.lastName,
      },
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`SubmitOrderRequest failed: ${data.error.message}`);
  }
  return data; // { order_tracking_id, merchant_reference, redirect_url }
}

async function getTransactionStatus(orderTrackingId) {
  const token = await authenticate();
  const res = await fetch(
    `${BASE_URL}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
    { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } }
  );
  return res.json();
  // status_code: 0 INVALID, 1 COMPLETED, 2 FAILED, 3 REVERSED
}

module.exports = { authenticate, registerIpnUrl, submitOrderRequest, getTransactionStatus, BASE_URL };
