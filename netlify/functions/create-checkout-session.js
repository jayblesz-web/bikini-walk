// netlify/functions/create-checkout-session.js
//
// Builds a Stripe Checkout for the cart. The browser sends ONLY item IDs;
// names and prices come from catalog.json (built from index.html on every
// deploy), so nobody can change a price from their browser.
//
// Netlify environment variable (digital1music site):
//   STRIPE_SECRET_KEY_Digital  — restricted key from the Arantxa Stripe
//                                account, "Checkout Sessions: Write"
//
// Every session is tagged metadata.site = "digital1music" so Bikini Walk's
// webhook (same Stripe account) ignores these sales.
//
// POST /.netlify/functions/create-checkout-session
// Body: { itemIds: ["album-r-123", "single-tr-456", "bundle-b-789"], customerEmail }
// Returns: { url } (Stripe Checkout page)

const catalog = require('./catalog.json');

function findItem(id) {
  id = String(id || '');
  if (id.indexOf('album-') === 0) {
    const rid = id.slice('album-'.length);
    const r = catalog.releases.find(function (x) { return x.id === rid; });
    if (r && r.price > 0) return { id: id, name: r.title + ' — ' + (r.artist || 'Digital 1 Music') + ' (Full Album)', price: r.price };
  }
  if (id.indexOf('single-') === 0) {
    const tid = id.slice('single-'.length);
    for (const r of catalog.releases) {
      const t = r.tracks.find(function (x) { return x.id === tid; });
      if (t && r.trackPrice > 0) return { id: id, name: t.title + ' — ' + (r.artist || 'Digital 1 Music') + ' (Single)', price: r.trackPrice };
    }
  }
  if (id.indexOf('bundle-') === 0) {
    const bid = id.slice('bundle-'.length);
    for (const r of catalog.releases) {
      const b = (r.bundles || []).find(function (x) { return x.id === bid; });
      if (b && b.price > 0) return { id: id, name: b.name + ' — ' + r.title, price: b.price, hasMerch: !!b.hasMerch };
    }
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const key = process.env.STRIPE_SECRET_KEY_Digital || process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('create-checkout-session: STRIPE_SECRET_KEY_Digital is not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Checkout is not configured yet.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  const ids = Array.isArray(body.itemIds) ? body.itemIds.slice(0, 50) : [];
  const seen = {};
  const items = [];
  for (const id of ids) {
    if (seen[id]) continue; // one of each item per order
    seen[id] = true;
    const item = findItem(id);
    if (!item) return { statusCode: 400, body: JSON.stringify({ error: 'An item in your cart is no longer available. Please remove it and try again.' }) };
    items.push(item);
  }
  if (!items.length) return { statusCode: 400, body: JSON.stringify({ error: 'Your cart is empty.' }) };

  const host = event.headers['x-forwarded-host'] || event.headers.host || 'digital1music.com';
  const origin = 'https://' + host;
  const email = String(body.customerEmail || '').trim();

  const form = new URLSearchParams();
  form.append('mode', 'payment');
  form.append('success_url', origin + '/?order=success&session_id={CHECKOUT_SESSION_ID}');
  form.append('cancel_url', origin + '/?order=cancelled');
  if (email && email.indexOf('@') > 0) form.append('customer_email', email);
  form.append('metadata[site]', 'digital1music');
  form.append('payment_intent_data[metadata][site]', 'digital1music');
  // Item IDs for the webhook / download page (Stripe metadata values max 500 chars)
  const idList = items.map(function (i) { return i.id; }).join(',');
  for (let i = 0, part = 0; i < idList.length; i += 480, part++) {
    form.append('metadata[items_' + part + ']', idList.slice(i, i + 480));
  }
  items.forEach(function (it, n) {
    form.append('line_items[' + n + '][quantity]', '1');
    form.append('line_items[' + n + '][price_data][currency]', 'usd');
    form.append('line_items[' + n + '][price_data][unit_amount]', String(Math.round(it.price * 100)));
    form.append('line_items[' + n + '][price_data][product_data][name]', it.name.slice(0, 250));
  });
  if (items.some(function (i) { return i.hasMerch; })) {
    form.append('shipping_address_collection[allowed_countries][0]', 'US');
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = await res.json();
    if (!res.ok || !data.url) {
      console.error('Stripe checkout error:', res.status, JSON.stringify(data && data.error));
      return { statusCode: 502, body: JSON.stringify({ error: 'Payment could not be started. Please try again in a moment.' }) };
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: data.url }) };
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Payment could not be started. Please try again in a moment.' }) };
  }
};
