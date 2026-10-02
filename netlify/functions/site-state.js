// netlify/functions/site-state.js
//
// Shared, server-side storage for Bikini Walk's Admin-configured content
// (hero photo/text, doors, Stripe links, chat persona/tiers, approved
// emails, etc.) using Netlify Blobs. This is what makes an Admin change
// visible to EVERY visitor, not just the browser that made it.
//
// Also handles the free-trial magic-link system: sending a real
// verification email (via Resend), confirming the click, and tracking each
// verified email's 72-hour trial window SERVER-SIDE — specifically so
// clearing cookies or switching browsers can't reset the clock. The trial
// is tied to the verified email address, not the visitor's device.
//
// IMPORTANT — what this does NOT store: anything specific to one
// customer's chat credits, chat history, or fan memory stays exactly where
// it already was — in that visitor's own browser. Only site-wide Admin
// content and the trial/verification records live here.
//
// GET  /.netlify/functions/site-state
//   → { state: {...} | null }  (public, every page load calls this)
// GET  /.netlify/functions/site-state?checkTrial=<email>
//   → { startedAt: <ms epoch> | null }  (re-confirms a trial's real start
//     time from the server, so the countdown can't be tampered with by
//     editing localStorage)
//
// POST /.netlify/functions/site-state
//   { action: 'login', password } → { success }
//   { action: 'save', password, newPassword?, state } → { success } | 401
//   { action: 'send-magic-link', email } → { success } | { error }
//     Generates a one-time token, emails a verification link via Resend.
//   { action: 'verify-magic-link', token } → { success, email, startedAt } | { error }
//     Confirms the click, and starts (or reads, if one already exists)
//     that email's 72-hour trial clock.

const { getStore } = require('@netlify/blobs');

const DEFAULT_PASSWORD = 'changeme';
const BLOB_KEY = 'state';
const MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // a magic link is valid for 30 minutes

function getSiteStore(){
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if(siteID && token){
    return getStore({ name: 'bikini-walk-site', siteID, token });
  }
  return getStore('bikini-walk-site');
}

function generateToken(){
  // 32 bytes of randomness as hex — long enough that guessing one isn't practical.
  const bytes = require('crypto').randomBytes(32);
  return bytes.toString('hex');
}

async function sendMagicLinkEmail(email, link){
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_ADDRESS || 'Bikini Walk <onboarding@resend.dev>';
  if(!apiKey){
    throw new Error('RESEND_API_KEY not configured');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [email],
      subject: 'Your Bikini Walk access link',
      html:
        '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">' +
          '<h2 style="margin-bottom:8px;">You\'re almost in.</h2>' +
          '<p style="color:#555;line-height:1.6;">Click below to verify your email and start your free 72-hour preview of Bikini Walk — Door 1 unlocks immediately.</p>' +
          '<p style="margin:28px 0;"><a href="' + link + '" style="background:#f5c842;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;">Enter Bikini Walk →</a></p>' +
          '<p style="color:#999;font-size:12px;">This link expires in 30 minutes. If you didn\'t request this, you can ignore this email.</p>' +
        '</div>',
    }),
  });
  if(!res.ok){
    const errText = await res.text();
    throw new Error('Resend error ' + res.status + ': ' + errText);
  }
}

exports.handler = async function (event) {
  const store = getSiteStore();

  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};

    if (params.checkTrial) {
      // Re-confirms a trial's real, server-recorded start time — used on
      // return visits so the countdown always reflects the truth even if
      // someone edited their own browser's localStorage.
      try {
        const email = params.checkTrial.trim().toLowerCase();
        const trial = await store.get('trial:' + email, { type: 'json' });
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ startedAt: trial ? trial.startedAt : null }),
        };
      } catch (err) {
        console.error('site-state checkTrial error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check trial' }) };
      }
    }

    try {
      const stored = await store.get(BLOB_KEY, { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: stored ? stored.state : null }),
      };
    } catch (err) {
      console.error('site-state GET error:', err);
      return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load state' }) };
    }
  }

  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    if (body.action === 'send-magic-link') {
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
      }
      try {
        const token = generateToken();
        await store.setJSON('magic:' + token, { email: email, createdAt: Date.now() });

        const host = event.headers['x-forwarded-host'] || event.headers.host;
        const protocol = (event.headers['x-forwarded-proto'] || 'https');
        const link = protocol + '://' + host + '/?magic=' + token;

        await sendMagicLinkEmail(email, link);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true }),
        };
      } catch (err) {
        console.error('send-magic-link error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to send email' }) };
      }
    }

    if (body.action === 'verify-magic-link') {
      const token = (body.token || '').trim();
      if (!token) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing token' }) };
      }
      try {
        const record = await store.get('magic:' + token, { type: 'json' });
        if (!record) {
          return { statusCode: 400, body: JSON.stringify({ error: 'This link is invalid or has already been used.' }) };
        }
        if (Date.now() - record.createdAt > MAGIC_LINK_TTL_MS) {
          await store.delete('magic:' + token);
          return { statusCode: 400, body: JSON.stringify({ error: 'This link has expired. Please request a new one.' }) };
        }

        // Single-use — delete immediately so the same link can't be replayed.
        await store.delete('magic:' + token);

        const email = record.email;
        // Only start the clock if this email has never had one before —
        // this is the actual fix for "clear cookies, get a fresh trial":
        // the trial is tied to the email on the server, not the browser.
        let trial = await store.get('trial:' + email, { type: 'json' });
        if (!trial) {
          trial = { startedAt: Date.now() };
          await store.setJSON('trial:' + email, trial);
        }

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, email: email, startedAt: trial.startedAt }),
        };
      } catch (err) {
        console.error('verify-magic-link error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to verify link' }) };
      }
    }

    let stored;
    try {
      stored = await store.get(BLOB_KEY, { type: 'json' });
    } catch (e) {
      stored = null;
    }
    const currentPassword = (stored && stored.password) || DEFAULT_PASSWORD;

    if (body.action === 'login') {
      const success = body.password === currentPassword;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success }),
      };
    }

    if (body.action === 'save') {
      if (!body.state) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing state' }) };
      }
      const newPassword = body.newPassword || currentPassword;
      try {
        await store.setJSON(BLOB_KEY, { state: body.state, password: newPassword });
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true }),
        };
      } catch (err) {
        console.error('site-state SAVE error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to save state' }) };
      }
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  }

  return { statusCode: 405, body: 'Method Not Allowed' };
};
