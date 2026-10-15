// netlify/functions/bw-call.js
//
// Live voice calls with VYRA (ElevenLabs Agents), paid by the minute.
//
// The agent in ElevenLabs has authentication ON, so a call can only start
// with a one-time signed URL that this function requests using the server's
// ELEVENLABS_API_KEY. It only does that for a browser whose wallet (the same
// wallet:<id> used by paid chat) has call time on it.
//
// Billing: when a call starts, up to MAX_CALL_SECONDS of the fan's time is
// set aside ("hold"). When the call is over, this function asks ElevenLabs
// how long the call really lasted and gives back the unused part. Because the
// real length comes from ElevenLabs (not the browser), closing the tab or
// tampering with the page can't avoid being charged; at worst the hold is kept.
//
// Netlify env vars used: ELEVENLABS_API_KEY (already set for bw-voice),
//   ELEVENLABS_AGENT_ID (optional — defaults to the "VYRA Calls" agent below),
//   BLOBS_SITE_ID / BLOBS_TOKEN (already set).
//
// POST /.netlify/functions/bw-call
//   { action: 'status',    walletId }                  → { callSeconds, pending }
//   { action: 'start',     walletId }                  → { signedUrl, maxSeconds, callSeconds } | error
//   { action: 'connected', walletId, conversationId }  → { ok }
//   { action: 'end',       walletId, conversationId? } → { settled, callSeconds, usedSeconds? }

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const DEFAULT_AGENT_ID = 'agent_0101m4wah5kqesrawn6rg5cecghe'; // "VYRA Calls"
const EL_API = 'https://api.elevenlabs.io';
const MAX_CALL_SECONDS = 600;      // same as the agent's "Max conversation duration"
const MIN_START_SECONDS = 30;      // need at least this much time to start a call
const NEVER_CONNECTED_MS = 3 * 60 * 1000;   // no conversation after this → full refund
const STUCK_MS = 20 * 60 * 1000;            // longest a call can still be "wrapping up"
const CONV_ID_RE = /^[A-Za-z0-9_-]{6,120}$/;

function agentId(){ return (process.env.ELEVENLABS_AGENT_ID || DEFAULT_AGENT_ID).trim(); }

function getSiteStore(){
  const siteID = process.env.BLOBS_SITE_ID;
  const token = process.env.BLOBS_TOKEN;
  if (siteID && token) return getStore({ name: 'bikini-walk-site', siteID, token, consistency: 'strong' });
  return getStore({ name: 'bikini-walk-site', consistency: 'strong' });
}
function validWalletId(id){ return /^[a-f0-9]{48}$/.test(String(id || '')); }
function reply(statusCode, obj){
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function elGet(path){
  return fetch(EL_API + path, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY || '' } });
}

// The signed URL request can also hand back the conversation id up front, so
// the server knows which ElevenLabs conversation to bill for this call.
function extractConversationId(data){
  if (data && typeof data.conversation_id === 'string' && CONV_ID_RE.test(data.conversation_id)) return data.conversation_id;
  try {
    const id = new URL(data.signed_url).searchParams.get('conversation_id') || '';
    return CONV_ID_RE.test(id) ? id : '';
  } catch (e) { return ''; }
}

// → { found:false } | { found:true, agentId, status, duration, startUnix }
async function fetchConversation(id){
  const res = await elGet('/v1/convai/conversations/' + encodeURIComponent(id));
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error('ElevenLabs conversation lookup failed: ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const c = await res.json();
  const meta = c.metadata || {};
  return {
    found: true,
    agentId: c.agent_id || '',
    status: c.status || '',
    duration: Number(meta.call_duration_secs != null ? meta.call_duration_secs : c.call_duration_secs) || 0,
    startUnix: Number(meta.start_time_unix_secs != null ? meta.start_time_unix_secs : c.start_time_unix_secs) || 0,
  };
}

async function isClaimed(store, id){
  const a = await store.get('callclaim:' + id, { type: 'json' });
  return !!a;
}

// Backup for when ElevenLabs didn't tell us the conversation id at start:
// look for an unclaimed conversation on this agent that began right after
// this wallet's pass was issued.
async function findUnclaimedConversation(store, startedAt){
  const after = Math.floor(startedAt / 1000) - 30;
  const res = await elGet('/v1/convai/conversations?agent_id=' + encodeURIComponent(agentId()) +
    '&call_start_after_unix=' + after + '&page_size=30');
  if (!res.ok) throw new Error('ElevenLabs conversation list failed: ' + res.status);
  const data = await res.json();
  const list = (Array.isArray(data.conversations) ? data.conversations : [])
    .filter(function (c) {
      const s = Number(c.start_time_unix_secs) || 0;
      return c.conversation_id && CONV_ID_RE.test(c.conversation_id) && s >= after && s <= after + 16 * 60;
    })
    .sort(function (a, b) { return (a.start_time_unix_secs || 0) - (b.start_time_unix_secs || 0); });
  for (const c of list) {
    if (!(await isClaimed(store, c.conversation_id))) return c.conversation_id;
  }
  return '';
}

// Read the freshest copy of the wallet, change it, save it.
async function updateWallet(store, walletId, change){
  const w = await store.get('wallet:' + walletId, { type: 'json' });
  if (!w) return null;
  const result = change(w);
  if (result === false) return w;
  w.updatedAt = Date.now();
  await store.setJSON('wallet:' + walletId, w);
  return w;
}

function finishCall(w, token, usedSeconds, conversationId){
  const p = w.pendingCall;
  if (!p || p.token !== token) return false; // already finished elsewhere
  const used = Math.max(0, Math.min(p.hold, Math.ceil(usedSeconds)));
  w.callSeconds = Math.max(0, (w.callSeconds || 0) + (p.hold - used));
  w.callLog = (Array.isArray(w.callLog) ? w.callLog : []).concat([{ conversationId: conversationId || '', used: used, at: Date.now() }]).slice(-30);
  delete w.pendingCall;
  return true;
}

// Settles this wallet's last call if it's over. Returns
// { settled: true, usedSeconds } when there's no open call (anymore),
// { settled: false } while the call is still going or wrapping up.
async function settlePending(store, walletId){
  let w = await store.get('wallet:' + walletId, { type: 'json' });
  const p = w && w.pendingCall;
  if (!p) return { settled: true, wallet: w };
  const age = Date.now() - (p.startedAt || 0);
  let id = p.conversationId || '';

  if (!id && age > NEVER_CONNECTED_MS) {
    try { id = await findUnclaimedConversation(store, p.startedAt); }
    catch (e) { console.error('bw-call:', e.message); return { settled: false, wallet: w }; }
    if (id) {
      await store.setJSON('callclaim:' + id, { walletId: walletId, at: Date.now() });
      w = await updateWallet(store, walletId, function (x) {
        if (!x.pendingCall || x.pendingCall.token !== p.token) return false;
        x.pendingCall.conversationId = id;
      });
    }
  }
  if (!id) {
    if (age <= NEVER_CONNECTED_MS) return { settled: false, wallet: w };
    // The pass was never used — give all the time back.
    w = await updateWallet(store, walletId, function (x) { return finishCall(x, p.token, 0, ''); });
    return { settled: true, usedSeconds: 0, wallet: w };
  }

  let conv;
  try { conv = await fetchConversation(id); }
  catch (e) { console.error('bw-call:', e.message); return { settled: false, wallet: w }; }

  if (!conv.found || (conv.agentId && conv.agentId !== agentId())) {
    if (age <= NEVER_CONNECTED_MS) return { settled: false, wallet: w };
    w = await updateWallet(store, walletId, function (x) { return finishCall(x, p.token, 0, id); });
    return { settled: true, usedSeconds: 0, wallet: w };
  }
  const finished = conv.status === 'done' || conv.status === 'failed';
  if (!finished && age <= STUCK_MS) return { settled: false, inCall: conv.status !== 'processing', wallet: w };
  // Stuck without a length: keep the hold (the most the call could have used).
  const used = (finished || conv.duration > 0) ? conv.duration : p.hold;
  w = await updateWallet(store, walletId, function (x) { return finishCall(x, p.token, used, id); });
  return { settled: true, usedSeconds: Math.min(p.hold, Math.ceil(used)), wallet: w };
}

// The browser reports the conversation id when the call connects. Only used
// if ElevenLabs didn't give it to us at start — and only after checking it's
// a real, unclaimed call on our agent that started after this pass was issued.
async function adoptConversationId(store, walletId, conversationId){
  const id = String(conversationId || '');
  if (!CONV_ID_RE.test(id)) return;
  const w = await store.get('wallet:' + walletId, { type: 'json' });
  const p = w && w.pendingCall;
  if (!p || p.conversationId) return;
  if (await isClaimed(store, id)) return;
  let conv;
  try { conv = await fetchConversation(id); } catch (e) { console.error('bw-call:', e.message); return; }
  if (!conv.found || conv.agentId !== agentId()) return;
  if (conv.startUnix && conv.startUnix * 1000 < (p.startedAt || 0) - 60 * 1000) return;
  await store.setJSON('callclaim:' + id, { walletId: walletId, at: Date.now() });
  await updateWallet(store, walletId, function (x) {
    if (!x.pendingCall || x.pendingCall.token !== p.token || x.pendingCall.conversationId) return false;
    x.pendingCall.conversationId = id;
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return reply(400, { error: 'Invalid JSON' }); }

  const action = String(body.action || '');
  const walletId = String(body.walletId || '');
  if (!validWalletId(walletId)) return reply(402, { error: 'no_minutes', callSeconds: 0 });

  const store = getSiteStore();
  try {
    const wallet = await store.get('wallet:' + walletId, { type: 'json' });
    if (!wallet) return reply(402, { error: 'no_minutes', callSeconds: 0 });

    if (action === 'status') {
      const s = await settlePending(store, walletId);
      const w = s.wallet || wallet;
      return reply(200, { callSeconds: w.callSeconds || 0, pending: !!w.pendingCall });
    }

    if (action === 'connected') {
      await adoptConversationId(store, walletId, body.conversationId);
      return reply(200, { ok: true });
    }

    if (action === 'end') {
      await adoptConversationId(store, walletId, body.conversationId);
      const s = await settlePending(store, walletId);
      const w = s.wallet || wallet;
      return reply(200, { settled: !!s.settled, usedSeconds: s.usedSeconds || 0, callSeconds: w.callSeconds || 0 });
    }

    if (action === 'start') {
      // Settle the previous call first (and refuse a second call at the same time).
      const s = await settlePending(store, walletId);
      if (!s.settled) return reply(409, { error: 'call_in_progress', callSeconds: (s.wallet && s.wallet.callSeconds) || 0 });
      const current = s.wallet || wallet;
      const available = Math.floor(current.callSeconds || 0);
      if (available < MIN_START_SECONDS) return reply(402, { error: 'no_minutes', callSeconds: available });

      if (!process.env.ELEVENLABS_API_KEY) {
        console.error('bw-call: ELEVENLABS_API_KEY is not set');
        return reply(500, { error: 'not_configured' });
      }
      const res = await elGet('/v1/convai/conversation/get-signed-url?agent_id=' + encodeURIComponent(agentId()) + '&include_conversation_id=true');
      if (!res.ok) {
        console.error('bw-call: signed URL failed', res.status, (await res.text()).slice(0, 500));
        return reply(502, { error: 'unavailable' });
      }
      const data = await res.json();
      if (!data || !data.signed_url) {
        console.error('bw-call: no signed_url in response');
        return reply(502, { error: 'unavailable' });
      }
      const conversationId = extractConversationId(data);
      const token = crypto.randomBytes(12).toString('hex');
      let hold = 0;
      const w = await updateWallet(store, walletId, function (x) {
        if (x.pendingCall) return false;
        const have = Math.floor(x.callSeconds || 0);
        if (have < MIN_START_SECONDS) return false;
        hold = Math.min(have, MAX_CALL_SECONDS);
        x.callSeconds = have - hold;
        x.pendingCall = { token: token, hold: hold, startedAt: Date.now(), conversationId: conversationId };
      });
      // Make sure this request's hold is the one that stuck (two taps at once).
      const check = await store.get('wallet:' + walletId, { type: 'json' });
      if (!hold || !check || !check.pendingCall || check.pendingCall.token !== token) {
        return reply(409, { error: 'call_in_progress', callSeconds: (check && check.callSeconds) || 0 });
      }
      if (conversationId) await store.setJSON('callclaim:' + conversationId, { walletId: walletId, at: Date.now() });
      return reply(200, { signedUrl: data.signed_url, maxSeconds: hold, callSeconds: (w && w.callSeconds) || 0 });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('bw-call error:', err);
    return reply(500, { error: 'Something went wrong' });
  }
};

// Exposed for tests only.
exports._internals = { extractConversationId, settlePending, MAX_CALL_SECONDS };
