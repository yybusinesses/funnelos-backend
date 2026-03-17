const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();

// ─── ENVIRONMENT VARIABLES ───────────────────────────────────────────────────
// Set these in your Render dashboard under Environment Variables:
//
//   ANTHROPIC_API_KEY   = your Anthropic key (already set)
//   STRIPE_SECRET_KEY   = sk_live_... (from Stripe dashboard → Developers → API keys)
//   STRIPE_WEBHOOK_SECRET = whsec_... (from Stripe dashboard → Webhooks → signing secret)
//   RESEND_API_KEY      = re_JN9PSQGm_Htq7spEZusmgkK4fpN3uTSM5
//   FROM_EMAIL          = noreply@brandvisable.com  (must be verified in Resend)
//   FRONTEND_URL        = https://brandvisable.com  (your live site URL)

const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET   = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK  = process.env.STRIPE_WEBHOOK_SECRET;
const RESEND_KEY      = process.env.RESEND_API_KEY || 're_JN9PSQGm_Htq7spEZusmgkK4fpN3uTSM5';
const FROM_EMAIL      = process.env.FROM_EMAIL || 'noreply@brandvisable.com';
const FRONTEND_URL    = process.env.FRONTEND_URL || 'https://brandvisable.com';

// ─── TEMPORARY SESSION STORE ─────────────────────────────────────────────────
// Stores buyer session between form submit → Stripe → return
// In production you could use Redis, but this works fine for low volume
const sessions = new Map();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature']
}));

// NOTE: Stripe webhook needs raw body — mount BEFORE express.json()
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'BrandVisable backend running', version: '2.0' });
});

// ─── MAIN AI GENERATE ENDPOINT ───────────────────────────────────────────────
// Used by both the strategy engine and contact generator
app.post('/generate', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !ANTHROPIC_KEY) {
      return res.status(400).json({ error: { message: 'Missing messages or API key' } });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5-20251101',
        max_tokens: 4096,
        messages
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('/generate error:', err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// ─── SAVE SESSION (before Stripe redirect) ───────────────────────────────────
// Frontend calls this to save form data before sending user to Stripe
app.post('/save-session', (req, res) => {
  const { email, formVals, icp, headline, preview } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Store by email as key (simple, works for single user flow)
  const sessionId = Buffer.from(email).toString('base64');
  sessions.set(sessionId, {
    email, formVals, icp, headline, preview,
    createdAt: Date.now()
  });

  // Clean up old sessions older than 2 hours
  for (const [key, val] of sessions.entries()) {
    if (Date.now() - val.createdAt > 7200000) sessions.delete(key);
  }

  res.json({ ok: true, sessionId });
});

// ─── GET SESSION (after Stripe redirect) ─────────────────────────────────────
app.get('/get-session', (req, res) => {
  // Return most recent session (simple approach)
  let latest = null;
  for (const [key, val] of sessions.entries()) {
    if (!latest || val.createdAt > latest.createdAt) latest = val;
  }
  if (latest) return res.json(latest);
  res.status(404).json({ error: 'No session found' });
});

// ─── STRIPE WEBHOOK ──────────────────────────────────────────────────────────
// Stripe calls this automatically after every payment
// Set this URL in Stripe Dashboard → Webhooks → Add endpoint:
//   https://funnelos-backend.onrender.com/webhook
// Events to listen for: checkout.session.completed, payment_intent.succeeded
app.post('/webhook', async (req, res) => {
  if (!STRIPE_SECRET) {
    // Stripe not configured yet — skip webhook handling
    return res.json({ received: true });
  }

  let event;

  try {
    // Verify the webhook came from Stripe (security check)
    const stripe = require('stripe')(STRIPE_SECRET);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle payment confirmed event
  if (event.type === 'checkout.session.completed' ||
      event.type === 'payment_intent.succeeded') {

    const session = event.data.object;
    const customerEmail = session.customer_email ||
                          session.customer_details?.email ||
                          session.receipt_email;

    console.log('Payment confirmed for:', customerEmail);

    if (customerEmail) {
      await sendReceiptEmail(customerEmail);
    }
  }

  res.json({ received: true });
});

// ─── SEND RECEIPT EMAIL via Resend ───────────────────────────────────────────
async function sendReceiptEmail(toEmail) {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: `BrandVisable <${FROM_EMAIL}>`,
        to: [toEmail],
        subject: 'Your BrandVisable contacts are ready ✓',
        html: buildEmailHTML(toEmail)
      })
    });

    const result = await response.json();
    console.log('Email sent:', result);
    return result;
  } catch (err) {
    console.error('Email send failed:', err);
  }
}

function buildEmailHTML(email) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1c1c1c;border-radius:16px;overflow:hidden;border:1px solid #2a2a2a">

          <!-- Header -->
          <tr>
            <td style="background:#0a0a0a;padding:28px 32px;border-bottom:1px solid #2a2a2a">
              <span style="font-size:18px;font-weight:700;color:#fafaf8;font-family:Georgia,serif;font-style:italic">BrandVisable</span>
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#e85d26;margin-left:6px;vertical-align:middle"></span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px">
              <p style="font-size:26px;font-weight:400;color:#fafaf8;margin:0 0 8px;font-family:Georgia,serif;font-style:italic;line-height:1.2">
                Payment confirmed.
              </p>
              <p style="font-size:14px;color:#a0a0a0;margin:0 0 28px;line-height:1.6">
                Your 40 matched contacts are ready. Go back to the site to view and download them.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin-bottom:28px">
                <tr>
                  <td style="background:#e85d26;border-radius:10px">
                    <a href="${FRONTEND_URL}?payment=success" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif">
                      View my 40 contacts →
                    </a>
                  </td>
                </tr>
              </table>

              <!-- What's included -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;border-radius:10px;padding:20px;margin-bottom:24px">
                <tr><td style="padding:0 0 12px">
                  <p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1.5px;color:#6b6b6b;margin:0">What's included</p>
                </td></tr>
                <tr><td style="color:#d4d4d0;font-size:13px;line-height:2">
                  ✓ 40 verified contacts matched to your business<br>
                  ✓ Name · Title · Company · Country<br>
                  ✓ LinkedIn search links<br>
                  ✓ Email patterns<br>
                  ✓ CSV export ready to download
                </td></tr>
              </table>

              <!-- Guarantee -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:9px;padding:14px 16px">
                <tr>
                  <td width="32" style="font-size:20px;vertical-align:top;padding-top:2px">🛡️</td>
                  <td style="padding-left:10px;font-size:13px;color:#a0a0a0;line-height:1.6">
                    <strong style="color:#d4d4d0">Replacement guarantee.</strong>
                    If any contact is wrong or an email bounces, reply to this email and we'll replace it.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;border-top:1px solid #2a2a2a">
              <p style="font-size:12px;color:#6b6b6b;margin:0;line-height:1.6">
                BrandVisable · A company of YY Businesses under YS Global Trade Partners<br>
                Trauns Allee 15, 22043 Hamburg, Germany<br>
                <a href="mailto:info@brandvisable.com" style="color:#e85d26;text-decoration:none">info@brandvisable.com</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BrandVisable backend running on port ${PORT}`);
});
