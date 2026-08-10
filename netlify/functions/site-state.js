// netlify/functions/site-state.js
//
// Shared, server-side storage for Bikini Walk's Admin-configured content
// (hero photo/text, doors, Stripe links, chat persona/tiers, approved
// emails, etc.) using Netlify Blobs. This is what makes an Admin change
// visible to EVERY visitor, not just the browser that made it — before
// this, Admin settings only ever lived in that one browser's localStorage.
//
// IMPORTANT — what this does NOT store: anything specific to one customer
// (their chat credits, their conversation history, their fan memory, their
// unlocked-content session) stays exactly where it already was — in that
// visitor's own browser. Only the site-wide content an admin configures
// lives here. That split matters: this file being shared/public-readable
// is fine because it never contains anyone's personal purchase data.
//
// GET  /.netlify/functions/site-state
//   → { state: {...} | null }  (null the very first time, before any save)
//   Public — every visitor's page load calls this to get current content.
//   Never returns the admin password.
//
// POST /.netlify/functions/site-state
//   Body: { action: 'login', password }
//     → { success: true|false }
//   Body: { action: 'save', password, newPassword?, state }
//     → { success: true } or 401 if `password` doesn't match what's stored
//     `newPassword` is optional — only sent when actually changing the
//     password; otherwise the existing one is kept.

const { getStore } = require('@netlify/blobs');

const DEFAULT_PASSWORD = 'changeme';
const BLOB_KEY = 'state';

exports.handler = async function (event) {
  const store = getStore('bikini-walk-site');

  if (event.httpMethod === 'GET') {
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
      if (body.password !== currentPassword) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Incorrect password' }) };
      }
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
