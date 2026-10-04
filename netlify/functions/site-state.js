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
//     that email's 72-hour trial clock. Also records the email as a free lead.
//   { action: 'start-trial', email } → { success, email, startedAt }
//     Only works when Admin has "Require email verification" switched OFF.
//   { action: 'member-session', token } → { valid, email, grantedAt, token, doors[{id,url}] }
//   { action: 'check-purchase', ref } → { paid, kind, ... }  (after Stripe redirect;
//     payments are recorded by stripe-webhook.js, never by the browser)
//   { action: 'admin-load', password } → { state (including private lists), loadedAt }
//   { action: 'test-email', password, email } → { success, config, detail?, hint? }
//
// 'save', 'admin-load' and 'test-email' require the admin password.
// GET never includes member emails, access dates, free leads, or paid door links.
// Members prove their email by sign-in link (or by being the browser that
// made the Stripe purchase) and then receive a signed pass.

const { getStore } = require('@netlify/blobs');

const DEFAULT_PASSWORD = 'changeme';
const BLOB_KEY = 'state';
const MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // a magic link is valid for 30 minutes
const MAGIC_LINK_REUSE_GRACE_MS = 15 * 60 * 1000; // still works for 15 min after first use

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

function generateToken(){
  // 32 bytes of randomness as hex — long enough that guessing one isn't practical.
  const bytes = require('crypto').randomBytes(32);
  return bytes.toString('hex');
}

async function sendMagicLinkEmail(email, link, isMember){
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
      // Plain, personal-looking email so Gmail is less likely to file it under Promotions.
      subject: isMember ? 'Your Bikini Walk sign-in link' : 'Your Bikini Walk access link',
      text:
        'Hi,\n\n' +
        (isMember
          ? 'Here is your link to sign in to Bikini Walk:\n'
          : 'Here is your link to start your free 72-hour preview of Bikini Walk:\n') +
        link + '\n\n' +
        'The link expires in 30 minutes. If you didn\'t request this, you can ignore this email.\n\n' +
        'Bikini Walk',
      html:
        '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;">' +
          '<p>Hi,</p>' +
          '<p>' + (isMember
            ? 'Here is your link to sign in to Bikini Walk:'
            : 'Here is your link to start your free 72-hour preview of Bikini Walk:') +
          '<br><a href="' + link + '">' + (isMember ? 'Sign in to Bikini Walk' : 'Start my free preview') + '</a></p>' +
          '<p style="color:#666;font-size:13px;">The link expires in 30 minutes. If you didn\'t request this, you can ignore this email.</p>' +
          '<p>Bikini Walk</p>' +
        '</div>',
    }),
  });
  if(!res.ok){
    const errText = await res.text();
    let detail = errText;
    try{ const j = JSON.parse(errText); detail = j.message || j.error || errText; }catch(e){}
    const err = new Error('Resend error ' + res.status + ': ' + detail);
    err.detail = detail;
    err.hint = explainResendError(res.status, detail);
    throw err;
  }
}

// Turns Resend's raw error into a plain-English fix for the site owner.
function explainResendError(status, detail){
  const d = (detail || '').toLowerCase();
  if(d.includes('testing emails') || d.includes('own email')){
    return 'Resend is still in test mode: the default sender (onboarding@resend.dev) can only email YOUR Resend account address. Verify your domain at resend.com/domains, then set RESEND_FROM_ADDRESS in Netlify to something like "Bikini Walk <hello@yourdomain.com>" and redeploy.';
  }
  if(d.includes('domain') && (d.includes('not verified') || d.includes('verify'))){
    return 'The domain in RESEND_FROM_ADDRESS is not verified in Resend yet. Finish the DNS records at resend.com/domains (status must say Verified), then redeploy.';
  }
  if(status === 401 || d.includes('api key')){
    return 'RESEND_API_KEY is wrong or was revoked. Create a new key at resend.com/api-keys, paste it into Netlify environment variables, and redeploy.';
  }
  if(d.includes('from')){
    return 'RESEND_FROM_ADDRESS is badly formatted. Use: Bikini Walk <hello@yourdomain.com>';
  }
  return 'Resend rejected the email. The exact reason is shown above.';
}

// Adds a verified free lead to the shared state without touching anything else.
async function recordFreeLead(store, email){
  try{
    const stored = (await store.get(BLOB_KEY, { type: 'json' })) || { state: {}, password: DEFAULT_PASSWORD };
    stored.state = stored.state || {};
    const list = Array.isArray(stored.state.freeEmails) ? stored.state.freeEmails : [];
    if(list.map(e => (e || '').toLowerCase()).indexOf(email) === -1){
      list.push(email);
      stored.state.freeEmails = list;
      await store.setJSON(BLOB_KEY, stored);
    }
  }catch(e){ console.error('recordFreeLead failed:', e); }
}

// Member emails, their access dates, and free leads are private: visitors
// get every other setting, but never these lists. Admin gets them through
// the password-protected 'admin-load' action.
// ---- R2 expiring video links ----
// Door videos stored in a PRIVATE Cloudflare R2 bucket are handed out only as
// links that stop working after a few hours, so copied links die. Needs these
// Netlify variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
// R2_BUCKET (optional R2_PUBLIC_BASE = the bucket's old public base URL).
// A door's video field can hold an r2.dev link, an R2_PUBLIC_BASE link, or
// "r2:path/file.mp4". Anything else (e.g. Cloudinary) passes through unchanged.
const crypto = require('crypto');

const LINK_LIFETIME_SECONDS = 4 * 60 * 60; // 4 hours

function r2Configured(){
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

// Returns the object key if this address points into the R2 bucket, else null.
function r2KeyFor(address){
  const a = String(address || '').trim();
  if (!a) return null;
  if (a.toLowerCase().indexOf('r2:') === 0) return a.slice(3).replace(/^\/+/, '');
  let u;
  try { u = new URL(a); } catch (e) { return null; }
  const base = (process.env.R2_PUBLIC_BASE || '').trim().replace(/\/+$/, '');
  let baseHost = '';
  try { if (base) baseHost = new URL(base).host.toLowerCase(); } catch (e) {}
  const host = u.host.toLowerCase();
  if (/\.r2\.dev$/.test(host) || (baseHost && host === baseHost)) {
    return decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  }
  // Direct S3-style address: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
  if (/\.r2\.cloudflarestorage\.com$/.test(host)) {
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    parts.shift(); // bucket
    return decodeURIComponent(parts.join('/'));
  }
  return null;
}

function uriEncode(str){
  return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}
function hmac(key, data){ return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function sha256hex(data){ return crypto.createHash('sha256').update(data, 'utf8').digest('hex'); }

// AWS Signature V4 query-string presign (what R2's S3 API accepts).
function presignR2(key, nowMs, lifetimeSeconds){
  const account = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const host = account + '.r2.cloudflarestorage.com';
  const region = 'auto';
  const now = new Date(nowMs || Date.now());
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/' + region + '/s3/aws4_request';
  const canonicalUri = '/' + uriEncode(bucket) + '/' + key.split('/').map(uriEncode).join('/');

  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
    'X-Amz-Credential': accessKey + '/' + scope,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(lifetimeSeconds || LINK_LIFETIME_SECONDS),
    'X-Amz-SignedHeaders': 'host',
    'x-id': 'GetObject',
  };
  const canonicalQuery = Object.keys(params).sort()
    .map(function (k) { return uriEncode(k) + '=' + uriEncode(params[k]); }).join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secret, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return 'https://' + host + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
}

// The link a viewer should actually get for a stored door address.
function playableUrl(address){
  const key = r2KeyFor(address);
  if (!key) return address;                // not R2 — unchanged
  if (!r2Configured()) {
    console.error('r2-links: R2 env vars missing; serving the stored address unchanged');
    return address;
  }
  return presignR2(key);
}


const PRIVATE_KEYS = ['emails', 'emailAccess', 'freeEmails'];
function publicState(state){
  if(!state) return state;
  const copy = Object.assign({}, state);
  PRIVATE_KEYS.forEach(function(k){ delete copy[k]; });
  // Paid doors' video/image links (or hidden message text) only go to signed-in
  // members via 'member-session'. Visitors just learn the door has content.
  if (Array.isArray(copy.doors)) {
    copy.doors = copy.doors.map(function (d) {
      const has = !!(d && d.url && String(d.url).trim());
      if (!d || d.isFree) return Object.assign({}, d, { url: has ? playableUrl(d.url) : (d && d.url), hasContent: has });
      return Object.assign({}, d, { url: '', hasContent: has });
    });
  }
  return copy;
}
// Admin keeps the stored address for editing, plus a playable link for previews.
function withPlayUrls(state){
  const copy = Object.assign({}, state);
  copy.doors = (Array.isArray(state.doors) ? state.doors : []).map(function (d) {
    if (!d || !d.url) return d;
    const play = playableUrl(d.url);
    return play !== d.url ? Object.assign({}, d, { playUrl: play, playUrlFor: d.url }) : d;
  });
  return copy;
}
function paidDoorContent(state){
  return (Array.isArray(state.doors) ? state.doors : [])
    .filter(function (d) { return d && d.url && String(d.url).trim(); })
    .map(function (d) { return { id: d.id, url: playableUrl(d.url) }; });
}

// ---- Member passes (signed tokens) ----
// After a member proves who they are (email link, or the browser that made
// the Stripe purchase), the server hands that browser a signed pass. The
// browser can't forge or edit one; the server checks it on every visit and
// still checks that the email's paid access hasn't expired.
const TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // a pass lasts up to 60 days on a device
async function getTokenSecret(store){
  let rec = await store.get('secret:member-token', { type: 'json' });
  if (!rec || !rec.secret) {
    rec = { secret: require('crypto').randomBytes(32).toString('hex'), createdAt: Date.now() };
    await store.setJSON('secret:member-token', rec);
  }
  return rec.secret;
}
function b64url(buf){ return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function makeMemberToken(store, email){
  const secret = await getTokenSecret(store);
  const payload = b64url(JSON.stringify({ e: email, x: Date.now() + TOKEN_TTL_MS }));
  const sig = b64url(require('crypto').createHmac('sha256', secret).update(payload).digest());
  return payload + '.' + sig;
}
async function readMemberToken(store, token){
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const secret = await getTokenSecret(store);
    const expected = b64url(require('crypto').createHmac('sha256', secret).update(parts[0]).digest());
    if (expected.length !== parts[1].length ||
        !require('crypto').timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return null;
    const data = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!data.e || !data.x || Date.now() > data.x) return null;
    return data.e;
  } catch (e) { return null; }
}
function memberInfo(state, email){
  const norm = (email || '').trim().toLowerCase();
  const emails = Array.isArray(state.emails) ? state.emails.map(e => (e || '').trim().toLowerCase()) : [];
  if(!norm || emails.indexOf(norm) === -1) return { member: false };
  const days = Number(state.accessDurationDays) || 0;
  const grantedAt = (state.emailAccess && state.emailAccess[norm]) || 0;
  const expired = days > 0 && grantedAt > 0 && (Date.now() - grantedAt) > days * 86400000;
  return { member: true, grantedAt: grantedAt, expired: expired, accessDurationDays: days };
}

async function emailSignInLink(store, event, email, isMember){
  const token = generateToken();
  await store.setJSON('magic:' + token, { email: email, createdAt: Date.now() });
  const host = event.headers['x-forwarded-host'] || event.headers.host;
  const protocol = (event.headers['x-forwarded-proto'] || 'https');
  const link = protocol + '://' + host + '/?magic=' + token;
  await sendMagicLinkEmail(email, link, isMember);
}
async function loadState(store){
  try { const st = await store.get(BLOB_KEY, { type: 'json' }); return (st && st.state) || {}; }
  catch (e) { return {}; }
}
// What a proven member's browser receives: a pass + the paid door links.
async function memberSessionPayload(store, state, email){
  const info = memberInfo(state, email);
  if (!info.member || info.expired) return Object.assign({ valid: false }, info);
  return {
    valid: true,
    email: email,
    grantedAt: info.grantedAt,
    token: await makeMemberToken(store, email),
    doors: paidDoorContent(state),
  };
}

async function startTrialFor(store, email){
  let trial = await store.get('trial:' + email, { type: 'json' });
  if(!trial){
    trial = { startedAt: Date.now() };
    await store.setJSON('trial:' + email, trial);
  }
  await recordFreeLead(store, email);
  return trial;
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
        body: JSON.stringify({ state: stored ? publicState(stored.state) : null }),
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
        const st = await loadState(store);
        await emailSignInLink(store, event, email, memberInfo(st, email).member);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true }),
        };
      } catch (err) {
        console.error('send-magic-link error:', err);
        // The real reason goes to the Netlify function log and the Admin
        // "Send test email" box only — never to visitors (it can contain the
        // owner's personal email address).
        return { statusCode: 500, body: JSON.stringify({
          error: "We couldn't send your link right now. Please try again later.",
        }) };
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
        if (Date.now() - record.createdAt > (record.ttlMs || MAGIC_LINK_TTL_MS)) {
          await store.delete('magic:' + token);
          return { statusCode: 400, body: JSON.stringify({ error: 'This link has expired. Please request a new one.' }) };
        }

        // Mostly single-use: the first open marks the link used, and it keeps
        // working for a short grace period after that. Email security scanners
        // (Outlook, Yahoo, work email) often "pre-open" links, and people
        // double-tap — without this grace they'd see "already used".
        if (record.usedAt && Date.now() - record.usedAt > MAGIC_LINK_REUSE_GRACE_MS) {
          await store.delete('magic:' + token);
          return { statusCode: 400, body: JSON.stringify({ error: 'This link has already been used. Request a new one from the sign-in box.' }) };
        }
        if (!record.usedAt) {
          record.usedAt = Date.now();
          await store.setJSON('magic:' + token, record);
        }

        const email = record.email;
        const st = await loadState(store);

        // A paying member clicked their sign-in link: hand back a member pass.
        const member = await memberSessionPayload(store, st, email);
        if (member.valid) {
          return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ success: true }, member, { member: true })),
          };
        }

        // Only start the clock if this email has never had one before —
        // this is the actual fix for "clear cookies, get a fresh trial":
        // the trial is tied to the email on the server, not the browser.
        const trial = await startTrialFor(store, email);

        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, email: email, startedAt: trial.startedAt, memberExpired: !!member.expired }),
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
    const siteState = (stored && stored.state) || {};

    // Free preview WITHOUT the email link — only allowed when the owner has
    // switched "Require email verification" OFF in Admin. Checked here on the
    // server, so a visitor can't skip verification while it's switched on.
    if (body.action === 'start-trial') {
      if (siteState.requireEmailVerification !== false) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Email verification is required.' }) };
      }
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid email' }) };
      }
      try {
        // Paying members always prove their email with a sign-in link, even
        // when free previews skip verification.
        if (memberInfo(siteState, email).member) {
          await emailSignInLink(store, event, email, true);
          return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, memberLinkSent: true }) };
        }
        const trial = await startTrialFor(store, email);
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ success: true, email: email, startedAt: trial.startedAt }),
        };
      } catch (err) {
        console.error('start-trial error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to start preview' }) };
      }
    }

    // A returning member's browser shows its pass; if it's genuine and their
    // access is still active, they get the paid door links again.
    if (body.action === 'member-session') {
      const email = await readMemberToken(store, body.token);
      if (!email) {
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ valid: false }) };
      }
      const payload = await memberSessionPayload(store, siteState, email);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    }

    // After the Stripe redirect: did the Stripe webhook record a real payment
    // for this checkout? <ref> is the random id this browser added to the
    // Stripe link. Chat packs can be claimed once; full access just reports.
    if (body.action === 'check-purchase') {
      const ref = (body.ref || '').toString().trim();
      if (!/^(acc|chat)_[A-Za-z0-9_-]{6,150}$/.test(ref)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid reference' }) };
      }
      try {
        const purchase = await store.get('purchase:' + ref, { type: 'json' });
        if (!purchase) {
          return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: false }) };
        }
        if (purchase.kind === 'chat') {
          if (!purchase.tierOk) {
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true, kind: 'chat', problem: 'mismatch' }) };
          }
          if (purchase.claimed) {
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true, kind: 'chat', alreadyClaimed: true }) };
          }
          purchase.claimed = true;
          purchase.claimedAt = Date.now();
          await store.setJSON('purchase:' + ref, purchase);
          return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true, kind: 'chat', tierId: purchase.tierId, email: purchase.email }) };
        }
        // Full access: the browser holding this checkout's reference is the
        // buyer's, so it gets a member pass — once. (Later sign-ins use email links.)
        if (purchase.passIssued) {
          return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paid: true, kind: 'access', alreadyUsed: true }) };
        }
        const member = await memberSessionPayload(store, siteState, purchase.email);
        if (member.valid) {
          purchase.passIssued = true;
          purchase.passIssuedAt = Date.now();
          await store.setJSON('purchase:' + ref, purchase);
        }
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ paid: true, kind: 'access' }, member)),
        };
      } catch (err) {
        console.error('check-purchase error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to check purchase' }) };
      }
    }

    // Admin-only: the full state, including the private email lists.
    if (body.action === 'admin-load') {
      if (body.password !== currentPassword) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authorized' }) };
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: withPlayUrls(siteState), loadedAt: Date.now() }),
      };
    }

    // Admin-only: send a real test email and report exactly what Resend said.
    if (body.action === 'test-email') {
      if (body.password !== currentPassword) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authorized' }) };
      }
      const to = (body.email || '').trim().toLowerCase();
      const config = {
        hasApiKey: !!process.env.RESEND_API_KEY,
        fromAddress: process.env.RESEND_FROM_ADDRESS || '(not set — using onboarding@resend.dev, test mode only)',
      };
      if (!to || !to.includes('@')) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Enter an email to send the test to', config }) };
      }
      try {
        const host = event.headers['x-forwarded-host'] || event.headers.host;
        await sendMagicLinkEmail(to, 'https://' + host + '/');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, config }) };
      } catch (err) {
        const notConfigured = /RESEND_API_KEY not configured/.test(err.message || '');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          success: false, config,
          detail: notConfigured ? 'RESEND_API_KEY is not set in Netlify.' : (err.detail || err.message),
          hint: notConfigured ? 'Add RESEND_API_KEY in Netlify → Site configuration → Environment variables, then redeploy.' : (err.hint || ''),
        }) };
      }
    }

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
      // Only the owner can change the site. (Before this check, anyone who
      // knew the URL could overwrite every door, link, and setting.)
      if (body.password !== currentPassword) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Not authorized' }) };
      }
      const newPassword = body.newPassword || currentPassword;
      // Free leads are added by the server as people verify, so an Admin tab
      // that loaded earlier mustn't wipe the ones that arrived since.
      const incoming = body.state;

      // Private lists: if this Admin tab never loaded them, keep the server's
      // copy untouched. If it did, keep Admin's edits but also keep anyone the
      // Stripe webhook added after Admin loaded (so a save can't erase a new buyer).
      const loadedAt = Number(body.privateLoadedAt) || 0;
      if (!loadedAt) {
        incoming.emails = siteState.emails || [];
        incoming.emailAccess = siteState.emailAccess || {};
      } else {
        const keptEmails = Array.isArray(incoming.emails) ? incoming.emails.slice() : [];
        const keptNorm = keptEmails.map(e => (e || '').trim().toLowerCase());
        incoming.emailAccess = Object.assign({}, incoming.emailAccess || {});
        const serverAccess = siteState.emailAccess || {};
        (siteState.emails || []).forEach(function (e) {
          const norm = (e || '').trim().toLowerCase();
          const at = serverAccess[norm] || 0;
          if (at > loadedAt) {
            if (keptNorm.indexOf(norm) === -1) { keptEmails.push(e); keptNorm.push(norm); }
            if (!incoming.emailAccess[norm] || incoming.emailAccess[norm] < at) incoming.emailAccess[norm] = at;
          }
        });
        incoming.emails = keptEmails;
      }

      if (!loadedAt && Array.isArray(incoming.doors)) {
        // This tab only had the public copy, where paid door links are blank.
        const oldDoors = {};
        (siteState.doors || []).forEach(function (d) { if (d && d.id) oldDoors[d.id] = d; });
        incoming.doors = incoming.doors.map(function (d) {
          const old = d && oldDoors[d.id];
          if (old && !d.isFree && (!d.url || !String(d.url).trim())) return Object.assign({}, d, { url: old.url });
          return d;
        });
      }
      incoming.doors = (incoming.doors || []).map(function (d) {
        if (!d) return d;
        const copy = Object.assign({}, d); delete copy.hasContent; delete copy.playUrl; delete copy.playUrlFor; return copy;
      });

      const oldLeads = Array.isArray(siteState.freeEmails) ? siteState.freeEmails : [];
      const newLeads = Array.isArray(incoming.freeEmails) ? incoming.freeEmails : [];
      const seen = {};
      incoming.freeEmails = oldLeads.concat(newLeads).filter(function (e) {
        const k = (e || '').toLowerCase();
        if (!k || seen[k]) return false;
        seen[k] = true;
        return true;
      });
      try {
        await store.setJSON(BLOB_KEY, { state: incoming, password: newPassword });
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
