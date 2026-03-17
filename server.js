const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const crypto = require('crypto');
const app = express();

// ★ CORS — allow ALL origins so Netlify, local testing, everywhere works
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());

// ★ STRIPE WEBHOOK — raw body, must come before express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    const payload = req.body.toString('utf8');
    const ts = sig.match(/t=([^,]+)/)?.[1];
    const expectedSig = crypto.createHmac('sha256', webhookSecret).update(`${ts}.${payload}`).digest('hex');
    const receivedSig = sig.match(/v1=([^,]+)/)?.[1];
    if (expectedSig !== receivedSig) return res.status(400).send('Bad signature');
    event = JSON.parse(payload);
  } catch (err) { return res.status(400).send('Webhook Error'); }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const name = session.customer_details?.name || 'there';
    const amount = session.amount_total;
    const plan = amount >= 6900 ? 'Pro' : amount >= 2900 ? 'Growth' : 'Starter';
    const credits = amount >= 6900 ? 300 : amount >= 2900 ? 100 : 25;
    if (email) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Brand Visable <info@brandvisable.com>',
            to: [email],
            subject: `You now have ${credits} credits on Brand Visable`,
            html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px"><h2>Welcome, ${name}.</h2><p>Your ${plan} pack is live. You have <strong>${credits} credits</strong> to find LinkedIn buyer archetypes and unlock personalised outreach scripts.</p><p><a href="https://brandvisable.com" style="background:#2563eb;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block">Open Brand Visable →</a></p><p style="color:#666;font-size:13px">Strategy generation is free forever. Credits unlock personalised outreach scripts for each LinkedIn archetype.<br><br>— Yahya, Brand Visable</p></div>`
          })
        });
        console.log('Email sent to:', email);
      } catch (e) { console.error('Email error:', e.message); }
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '10mb' }));

// ★ GENERATE — main endpoint
app.post('/generate', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 8000,
        messages: req.body.messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.get('/', (req, res) => res.send('Brand Visable API — running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  // Keep-alive ping every 14 minutes
  setInterval(() => {
    fetch(`http://localhost:${PORT}/`).catch(() => {});
  }, 14 * 60 * 1000);
});
