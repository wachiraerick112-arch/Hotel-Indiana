// Run this ONCE after you have: a Till/Paybill number, Daraja API
// Consumer Key + Secret, and your app deployed at a public HTTPS URL.
// It tells Safaricom where to send payment confirmations.
//
// Usage:
//   MPESA_CONSUMER_KEY=xxx MPESA_CONSUMER_SECRET=xxx \
//   MPESA_SHORTCODE=your_till_number \
//   MPESA_WEBHOOK_SECRET=the_same_secret_in_server_env \
//   PUBLIC_URL=https://your-domain.com \
//   MPESA_ENV=sandbox \
//   node register-mpesa-urls.js

const ENV = process.env.MPESA_ENV === "production" ? "production" : "sandbox";
const BASE = ENV === "production"
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

async function main() {
  const { MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_WEBHOOK_SECRET, PUBLIC_URL } = process.env;
  if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_WEBHOOK_SECRET || !PUBLIC_URL) {
    console.error("Missing one of: MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_WEBHOOK_SECRET, PUBLIC_URL");
    process.exit(1);
  }

  // 1. Get an OAuth token
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const tokenRes = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("Could not get an access token:", tokenData);
    process.exit(1);
  }

  // 2. Register the Confirmation + Validation URLs
  const regRes = await fetch(`${BASE}/mpesa/c2b/v2/registerurl`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ShortCode: MPESA_SHORTCODE,
      ResponseType: "Completed",
      ConfirmationURL: `${PUBLIC_URL}/api/mpesa/confirmation/${MPESA_WEBHOOK_SECRET}`,
      ValidationURL: `${PUBLIC_URL}/api/mpesa/validation/${MPESA_WEBHOOK_SECRET}`
    })
  });
  const regData = await regRes.json();
  console.log(regData);
}

main().catch(e => { console.error(e); process.exit(1); });
