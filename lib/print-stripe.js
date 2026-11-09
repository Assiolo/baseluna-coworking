const crypto = require('crypto');
const { fail } = require('./print-logic');

const TOLERANCE_SEC = 300;

function status() {
  const flag = String(process.env.PRINT_STRIPE_ENABLED || '') === '1';
  const keysPresent = !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET);
  return { enabled: flag && keysPresent, flag, keysPresent };
}

function verifySignature(rawBody, header, secret, nowMs = Date.now()) {
  if (!header || !secret) return false;
  const parts = { v1: [] };
  for (const bit of String(header).split(',')) {
    const i = bit.indexOf('=');
    if (i === -1) continue;
    const k = bit.slice(0, i).trim();
    const v = bit.slice(i + 1).trim();
    if (k === 'v1') parts.v1.push(v);
    else parts[k] = v;
  }
  const t = parts.t;
  if (!t || !parts.v1.length) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > TOLERANCE_SEC) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
  const signed = Buffer.concat([Buffer.from(String(t)), Buffer.from('.'), payload]);
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  const b = Buffer.from(expected);
  return parts.v1.some((v) => {
    const a = Buffer.from(v);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  });
}

async function createCheckout({ amountCents, userId, email, successUrl, cancelUrl, checkoutId }) {
  if (!status().enabled) throw fail(503, 'La ricarica online non è attiva. Puoi ricaricare in reception.');
  const currency = (process.env.STRIPE_CURRENCY || 'eur').toLowerCase();
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('success_url', successUrl);
  params.set('cancel_url', cancelUrl);
  params.set('client_reference_id', checkoutId);
  if (email) params.set('customer_email', email);
  params.set('line_items[0][quantity]', '1');
  params.set('line_items[0][price_data][currency]', currency);
  params.set('line_items[0][price_data][unit_amount]', String(amountCents));
  params.set('line_items[0][price_data][product_data][name]', 'Ricarica credito stampa — Base Luna');
  params.set('metadata[userId]', String(userId));
  params.set('metadata[amountCents]', String(amountCents));
  params.set('metadata[checkoutId]', checkoutId);
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.url) {
    console.error('Stripe checkout rifiutato:', json.error && json.error.message ? json.error.message : res.status);
    throw fail(502, 'Stripe non ha accettato la ricarica. Riprova più tardi o passa in reception.');
  }
  return { id: json.id, url: json.url };
}

module.exports = { status, verifySignature, createCheckout };
