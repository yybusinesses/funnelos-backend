const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

const ANTHROPIC_KEY        = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET        = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK       = process.env.STRIPE_WEBHOOK_SECRET;
const RESEND_KEY           = process.env.RESEND_API_KEY;
const FROM_EMAIL           = process.env.FROM_EMAIL || 'noreply@brandvisable.com';
const FRONTEND_URL         = process.env.FRONTEND_URL || 'https://brandvisable.com';
const SUPABASE_URL         = process.env.SUPABASE_URL || 'https://rjahshotfccgsiweiazj.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabase(path, method, body) {
  const res = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method: method || 'GET',
    headers: { 'Content-Type':'application/json', 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':'Bearer '+SUPABASE_SERVICE_KEY, 'Prefer':'return=representation' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) { console.error('Supabase error:', await res.text()); return null; }
  return res.json();
}

app.use(cors({ origin:'*', methods:['GET','POST','OPTIONS'], allowedHeaders:['Content-Type','Authorization','stripe-signature'] }));
app.use('/webhook', express.raw({ type:'application/json' }));
app.use(express.json());

app.get('/', (req,res) => res.json({ status:'BrandVisable v3 running' }));

// AI Generate
app.post('/generate', async (req,res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_KEY, 'anthropic-version':'2023-06-01' },
      body:JSON.stringify({ model:'claude-opus-4-5-20251101', max_tokens:4096, messages:req.body.messages })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error:{message:e.message} }); }
});

// Register
app.post('/auth/register', async (req,res) => {
  const { email, password } = req.body;
  if (!email||!password) return res.status(400).json({ error:'Email and password required' });
  try {
    const r = await fetch(SUPABASE_URL+'/auth/v1/admin/users', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_SERVICE_KEY, 'Authorization':'Bearer '+SUPABASE_SERVICE_KEY },
      body:JSON.stringify({ email, password, email_confirm:true })
    });
    const d = await r.json();
    if (d.error) {
      if (d.error.message && d.error.message.toLowerCase().includes('already')) return res.json({ exists:true });
      return res.status(400).json({ error:d.error.message });
    }
    await supabase('/profiles','POST',{ id:d.id, email });
    // Link any pre-payment purchases
    await supabase('/purchases?email=eq.'+encodeURIComponent(email)+'&user_id=is.null','PATCH',{ user_id:d.id });
    res.json({ success:true, user_id:d.id });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Login
app.post('/auth/login', async (req,res) => {
  const { email, password } = req.body;
  try {
    const r = await fetch(SUPABASE_URL+'/auth/v1/token?grant_type=password', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'apikey':SUPABASE_SERVICE_KEY },
      body:JSON.stringify({ email, password })
    });
    const d = await r.json();
    if (d.error) return res.status(401).json({ error:d.error_description||'Invalid credentials' });
    res.json({ success:true, access_token:d.access_token, user_id:d.user.id, email:d.user.email });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Get user data
app.get('/user/data', async (req,res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ error:'No token' });
  try {
    const ur = await fetch(SUPABASE_URL+'/auth/v1/user', { headers:{ 'Authorization':'Bearer '+token, 'apikey':SUPABASE_SERVICE_KEY } });
    const user = await ur.json();
    if (!user.id) return res.status(401).json({ error:'Invalid token' });
    const [purchases, contacts, strategies] = await Promise.all([
      supabase('/purchases?user_id=eq.'+user.id+'&order=paid_at.desc'),
      supabase('/contacts?user_id=eq.'+user.id+'&order=created_at.desc'),
      supabase('/strategies?user_id=eq.'+user.id+'&order=created_at.desc')
    ]);
    res.json({ user:{ id:user.id, email:user.email }, purchases:purchases||[], contacts:contacts||[], strategies:strategies||[] });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Save contacts
app.post('/user/save-contacts', async (req,res) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  const { contacts, purchase_id } = req.body;
  try {
    let userId = null;
    if (token) {
      const ur = await fetch(SUPABASE_URL+'/auth/v1/user', { headers:{ 'Authorization':'Bearer '+token, 'apikey':SUPABASE_SERVICE_KEY } });
      const user = await ur.json();
      userId = user.id;
    }
    if (!userId||!contacts||!contacts.length) return res.json({ saved:0 });
    const rows = contacts.map(c => ({ user_id:userId, purchase_id:purchase_id||null, name:c.name||'', title:c.title||'', company:c.company||'', country:c.country||'', email:c.email||'', li_url:c.liUrl||'', g_url:c.gUrl||'' }));
    await supabase('/contacts','POST',rows);
    res.json({ saved:rows.length });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// Session store (pre-payment)
const sessions = new Map();
app.post('/save-session', (req,res) => {
  const { email, formVals, icp, headline, preview } = req.body;
  if (!email) return res.status(400).json({ error:'Email required' });
  sessions.set(Buffer.from(email).toString('base64'), { email, formVals, icp, headline, preview, createdAt:Date.now() });
  res.json({ ok:true });
});
app.get('/get-session', (req,res) => {
  let latest = null;
  for (const [,v] of sessions.entries()) { if (!latest||v.createdAt>latest.createdAt) latest=v; }
  if (latest) return res.json(latest);
  res.status(404).json({ error:'No session' });
});

// Stripe webhook
app.post('/webhook', async (req,res) => {
  let event;
  try {
    const stripe = require('stripe')(STRIPE_SECRET);
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK);
  } catch(e) { return res.status(400).send('Webhook error: '+e.message); }

  if (event.type==='checkout.session.completed'||event.type==='payment_intent.succeeded') {
    const s = event.data.object;
    const email = s.customer_email||s.customer_details?.email||s.receipt_email;
    if (email) {
      // Record purchase
      try {
        const users = await supabase('/profiles?email=eq.'+encodeURIComponent(email));
        const userId = users&&users[0]?users[0].id:null;
        const sd = sessions.get(Buffer.from(email).toString('base64'))||{};
        await supabase('/purchases','POST',{ user_id:userId, email, stripe_session_id:s.id, form_vals:sd.formVals||null, icp:sd.icp||null, headline:sd.headline||null });
      } catch(e) { console.error('Purchase record error:',e); }
      // Send receipt
      try {
        await fetch('https://api.resend.com/emails', {
          method:'POST',
          headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+RESEND_KEY },
          body:JSON.stringify({ from:'BrandVisable <'+FROM_EMAIL+'>', to:[email], subject:'Your BrandVisable contacts are ready ✓', html:buildEmail(email) })
        });
      } catch(e) { console.error('Email error:',e); }
    }
  }
  res.json({ received:true });
});

function buildEmail(email) {
  return `<html><body style="margin:0;padding:0;background:#f8f7f5;font-family:Arial,sans-serif"><table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px"><tr><td align="center"><table width="520" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;border:1.5px solid #e5e1db"><tr><td style="background:#1a1a1a;padding:24px 32px"><span style="font-size:18px;color:#fff;font-style:italic;font-family:Georgia,serif">BrandVisable</span></td></tr><tr><td style="padding:32px"><p style="font-size:22px;color:#1a1a1a;font-family:Georgia,serif;font-style:italic;margin:0 0 12px">Payment confirmed. You're in.</p><p style="font-size:14px;color:#5a5650;margin:0 0 20px">Your 40 matched contacts are ready. Set your password and log in to access them anytime from any device.</p><table cellpadding="0" cellspacing="0" style="margin-bottom:20px"><tr><td style="background:#e85d26;border-radius:10px"><a href="${FRONTEND_URL}?payment=success" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:#fff;text-decoration:none">Access my contacts &rarr;</a></td></tr></table><p style="font-size:13px;color:#5a5650;line-height:1.8;background:#f8f7f5;padding:16px;border-radius:9px">✓ 40 AI-matched contact profiles<br>✓ LinkedIn links &amp; email patterns<br>✓ Full strategy engine (5 tools)<br>✓ CSV export<br>✓ Saved to your account forever</p></td></tr><tr><td style="padding:16px 32px;border-top:1px solid #e5e1db"><p style="font-size:12px;color:#8a8580;margin:0">BrandVisable &middot; Hamburg, Germany &middot; <a href="mailto:info@brandvisable.com" style="color:#e85d26;text-decoration:none">info@brandvisable.com</a></p></td></tr></table></td></tr></table></body></html>`;
}

app.listen(process.env.PORT||3000, () => console.log('BrandVisable v3 running'));
