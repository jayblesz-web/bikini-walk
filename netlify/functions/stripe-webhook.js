// netlify/functions/stripe-webhook.js
//
// Stripe calls this directly (server to server) every time a checkout is
// paid. Because every call is signed with STRIPE_WEBHOOK_SECRET, it can't
// be faked by a visitor — this is what makes paid access real.
//
// Setup (Stripe → Developers → Webhooks → Add endpoint):
//   URL:    https://bikiniwalk.net/.netlify/functions/stripe-webhook
//   Events: checkout.session.completed, checkout.session.async_payment_succeeded
// Then copy the endpoint's "Signing secret" (whsec_...) into Netlify →
// Environment variables as STRIPE_WEBHOOK_SECRET and redeploy.
//
// What it records (Netlify Blobs, same store as site-state.js):
//   purchase:<ref>  → { kind, tierId, email, amount, currency, paidAt, claimed }
//     <ref> is the client_reference_id the site adds to each Stripe link:
//       "acc_<random>"            full access (main or renewal link)
//       "chat_<tierId>_<random>"  a chat message pack
//   Full-access buyers are also added straight to the approved member list
//   (state.emails + state.emailAccess) so they're recognized on any device.

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const BLOB_KEY = 'state';
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function getSiteStore(){
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if(siteID && token){
    return getStore({ name: 'bikini-walk-site', siteID, token, consistency: 'strong' });
  }
  // 'strong' = always read the latest saved data. The default can lag up to
  // ~60s, which made fresh sign-in links look "invalid" if tapped quickly.
  return getStore({ name: 'bikini-walk-site', consistency: 'strong' });
}

// Stripe's signature scheme: header "t=<timestamp>,v1=<hex hmac>,..." where
// the HMAC-SHA256 is computed over "<timestamp>.<raw body>" with the secret.
function verifyStripeSignature(rawBody, header, secret){
  if(!header || !secret) return false;
  const parts = {};
  header.split(',').forEach(function(item){
    const idx = item.indexOf('=');
    if(idx === -1) return;
    const k = item.slice(0, idx).trim();
    const v = item.slice(idx + 1).trim();
    (parts[k] = parts[k] || []).push(v);
  });
  const t = parts.t && parts.t[0];
  const signatures = parts.v1 || [];
  if(!t || !signatures.length) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if(!isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(t + '.' + rawBody, 'utf8').digest('hex');
  return signatures.some(function(sig){
    try{
      return sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    }catch(e){ return false; }
  });
}

// "$4.99" → 499 (cents). Returns null if it can't be read.
function priceLabelToCents(label){
  const m = String(label || '').replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if(!m) return null;
  return Math.round(parseFloat(m[1]) * 100);
}

// "You're in" email with a sign-in link (up to 3 devices, 7 days), sent right
// after a full-access purchase so buyers can get in from any device.
const PURCHASE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
async function sendPurchaseSignInEmail(store, email, siteUrl){
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('stripe-webhook: RESEND_API_KEY missing, no sign-in email sent'); return; }
  const fromAddress = process.env.RESEND_FROM_ADDRESS || 'Bikini Walk <onboarding@resend.dev>';
  const token = crypto.randomBytes(32).toString('hex');
  await store.setJSON('magic:' + token, { email: email, createdAt: Date.now(), ttlMs: PURCHASE_LINK_TTL_MS, maxUses: 3 });
  const link = siteUrl.replace(/\/+$/, '') + '/?magic=' + token;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: fromAddress,
      to: [email],
      // Plain, personal-looking email (no big button / marketing styling) so
      // Gmail is more likely to put it in Primary instead of Promotions.
      subject: 'Your Bikini Walk sign-in link',
      text:
        'Hi,\n\n' +
        'Thanks for your purchase. Your access to all the doors is active.\n\n' +
        'Use this link to sign in (it works on up to 3 devices for 7 days):\n' + link + '\n\n' +
        'Need to sign in again later? On the site, tap any locked door, then "Already paid? Sign in."\n\n' +
        'Bikini Walk',
      html:
        '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">' +
          '<p>Hi,</p>' +
          '<p>Thanks for your purchase. Your access to all the doors is active.</p>' +
          '<p>Use this link to sign in on any device:<br><a href="' + link + '">Sign in to Bikini Walk</a></p>' +
          '<p style="color:#666;font-size:13px;">The link works on up to 3 devices for 7 days. Need to sign in again later? On the site, tap any locked door, then "Already paid? Sign in."</p>' +
          '<p>Bikini Walk</p>' +
        '</div>',
    }),
  });
  if (!res.ok) console.error('stripe-webhook: sign-in email failed', res.status, await res.text());
}

function parseRef(ref){
  if(!ref) return { kind: 'access', tierId: '' }; // paid via the link directly — treat as full access
  if(ref.indexOf('acc_') === 0) return { kind: 'access', tierId: '' };
  if(ref.indexOf('chat_') === 0){
    const rest = ref.slice(5);
    const cut = rest.lastIndexOf('_');
    return { kind: 'chat', tierId: cut > 0 ? rest.slice(0, cut) : '' };
  }
  return { kind: 'access', tierId: '' };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET is not set');
    return { statusCode: 500, body: 'Webhook not configured' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(rawBody, sigHeader, secret)) {
    console.error('stripe-webhook: bad signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const handled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  if (handled.indexOf(stripeEvent.type) === -1) {
    return { statusCode: 200, body: 'Ignored' }; // other events are fine to ignore
  }

  const session = stripeEvent.data && stripeEvent.data.object ? stripeEvent.data.object : {};
  const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
  if (!paid) {
    // e.g. a bank payment still pending — Stripe sends async_payment_succeeded later.
    return { statusCode: 200, body: 'Not paid yet' };
  }

  const email = ((session.customer_details && session.customer_details.email) || session.customer_email || '')
    .trim().toLowerCase();
  const ref = (session.client_reference_id || '').trim();
  const info = parseRef(ref);
  const store = getSiteStore();

  try {
    const stored = (await store.get(BLOB_KEY, { type: 'json' })) || { state: {}, password: undefined };
    stored.state = stored.state || {};
    const now = Date.now();

    // Chat packs: make sure the amount paid matches that pack's price, so a
    // cheap link can't be relabeled as an expensive pack.
    let tierOk = true;
    if (info.kind === 'chat') {
      const tiers = Array.isArray(stored.state.chatTiers) ? stored.state.chatTiers : [];
      const tier = tiers.find(function (t) { return t.id === info.tierId; });
      const expected = tier ? priceLabelToCents(tier.priceLabel) : null;
      if (!tier) tierOk = false;
      else if (expected !== null && typeof session.amount_total === 'number' && session.amount_total < expected) tierOk = false;
      if (!tierOk) console.error('stripe-webhook: chat pack mismatch', info.tierId, session.amount_total);
    }

    const record = {
      kind: info.kind,
      tierId: info.tierId,
      tierOk: tierOk,
      email: email,
      amount: session.amount_total,
      currency: session.currency,
      sessionId: session.id,
      paidAt: now,
      claimed: false,
    };
    if (ref) {
      const existing = await store.get('purchase:' + ref, { type: 'json' });
      if (!existing) await store.setJSON('purchase:' + ref, record);
    }
    // A permanent per-email payment log (useful for refunds/support).
    let isNewPayment = false;
    if (email) {
      const log = (await store.get('payments:' + email, { type: 'json' })) || [];
      if (!log.some(function (p) { return p.sessionId === session.id; })) {
        log.push(record);
        await store.setJSON('payments:' + email, log);
        isNewPayment = true; // Stripe can resend the same event; only email once
      }
    }

    // Full access: add the buyer to the member list right here on the server.
    if (info.kind === 'access' && email) {
      const emails = Array.isArray(stored.state.emails) ? stored.state.emails : [];
      if (emails.map(function (e) { return (e || '').trim().toLowerCase(); }).indexOf(email) === -1) {
        emails.push(email);
      }
      stored.state.emails = emails;
      stored.state.emailAccess = stored.state.emailAccess || {};
      stored.state.emailAccess[email] = now; // buying again (renewal) restarts the clock
      await store.setJSON(BLOB_KEY, stored);

      if (isNewPayment) {
        const host = event.headers['x-forwarded-host'] || event.headers.host || '';
        // The webhook is called at bikiniwalk.net, so link back to that same address.
        const siteUrl = host ? 'https://' + host : (process.env.URL || '');
        try { if (siteUrl) await sendPurchaseSignInEmail(store, email, siteUrl); }
        catch (e) { console.error('stripe-webhook: sign-in email error', e); } // never fail the webhook over email
      }
    }

    console.log('stripe-webhook: recorded', info.kind, info.tierId || '', email, session.amount_total);
    return { statusCode: 200, body: 'OK' };
  } catch (err) {
    console.error('stripe-webhook error:', err);
    // 500 makes Stripe retry later, which is what we want if storage hiccuped.
    return { statusCode: 500, body: 'Storage error' };
  }
};
