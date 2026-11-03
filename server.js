const express = require('express');
const cp = require('cookie-parser');
const bc = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const D = path.join(__dirname, 'data');
const DB = path.join(D, 'db.json');
const FP = path.join(D, 'floorplan.json');
const CF = path.join(D, 'config.json');
const NF = path.join(D, 'notifications.json');
const fp = () => JSON.parse(fs.readFileSync(FP));
const cfg = () => { try { return JSON.parse(fs.readFileSync(CF)); } catch { return {}; } };
const notify = (n) => {
  let a = [];
  try { a = JSON.parse(fs.readFileSync(NF)); } catch { /* file assente */ }
  a.push({ ...n, created: new Date().toISOString(), sent: false });
  fs.writeFileSync(NF, JSON.stringify(a, null, 1));
};
const linkFor = (m, amt) => {
  const u = (cfg()[m + 'PaymentUrl'] || '').trim();
  if (!u) return null;
  return u.replace(/\{amount_cents\}/g, Math.round(amt * 100)).replace(/\{amount\}/g, amt);
};

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }), cp(), express.static(path.join(__dirname, 'public')));

const pub = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, bio: u.bio || '', avatar: u.avatar || '', title: u.title || '' });
const COOKIE_MS = 30 * 24 * 60 * 60 * 1000;
const cookieBase = (q) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production' || q.secure,
  path: '/',
});
const cookieOpts = (q) => ({ ...cookieBase(q), maxAge: COOKIE_MS });

const auth = async (q, s, n) => {
  q.u = await db.userBySession(q.cookies && q.cookies.sid);
  if (!q.u) return s.status(401).json({ error: 'Non autenticato' });
  return n();
};
const admin = (q, s, n) => (q.u.role === 'admin' ? n() : s.status(403).json({ error: 'Solo admin' }));

async function login(q, s, u) {
  const t = crypto.randomBytes(24).toString('hex');
  await db.createSession(t, u.id);
  s.cookie('sid', t, cookieOpts(q));
  s.json(pub(u));
}

app.get('/api/health', async (q, s) => {
  try {
    await db.ping();
    s.json({ ok: true });
  } catch (err) {
    console.error('health check failed:', err.message);
    s.status(503).json({ ok: false });
  }
});

app.post('/api/register', async (q, s) => {
  const { name, email, password } = q.body || {};
  if (!name || !email || !password || password.length < 6) return s.status(400).json({ error: 'Compila tutti i campi (password min 6)' });
  const user = await db.createUser({ name, email: email.toLowerCase(), hash: bc.hashSync(password, 10) });
  if (!user) return s.status(409).json({ error: 'Email già registrata' });
  await login(q, s, user);
});

app.post('/api/login', async (q, s) => {
  const u = await db.userByEmail((q.body.email || '').toLowerCase());
  if (!u || !bc.compareSync(q.body.password || '', u.hash)) return s.status(401).json({ error: 'Credenziali non valide' });
  if (!u.active) return s.status(403).json({ error: 'Account disattivato' });
  await login(q, s, u);
});

app.post('/api/logout', async (q, s) => {
  await db.deleteSession(q.cookies && q.cookies.sid);
  s.clearCookie('sid', cookieBase(q)).json({ ok: 1 });
});

app.get('/api/me', auth, (q, s) => s.json(pub(q.u)));

const AV = path.join(__dirname, 'public/uploads/avatars');
fs.mkdirSync(AV, { recursive: true });

app.patch('/api/me/profile', auth, async (q, s) => {
  const b = q.body || {};
  const patch = {};
  if (typeof b.bio === 'string') patch.bio = b.bio.slice(0, 400);
  if (typeof b.title === 'string') patch.title = b.title.slice(0, 60);
  if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 60);
  const u = await db.updateUser(q.u.id, patch);
  s.json(pub(u));
});

app.post('/api/me/avatar', auth, async (q, s) => {
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec((q.body || {}).image || '');
  if (!m) return s.status(400).json({ error: 'Immagine non valida (PNG, JPG o WEBP)' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5e6) return s.status(400).json({ error: 'Max 5 MB' });
  const f = `u${q.u.id}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  if (q.u.avatar) { try { fs.unlinkSync(path.join(__dirname, 'public', q.u.avatar)); } catch { /* file già assente */ } }
  fs.writeFileSync(path.join(AV, f), buf);
  const u = await db.updateUser(q.u.id, { avatar: '/uploads/avatars/' + f });
  s.json(pub(u));
});

app.get('/api/site', (q, s) => {
  const c = cfg();
  s.json({ heroImage: c.heroImage || '', heroVideo: c.heroVideo || '', paypalPaymentUrl: c.paypalPaymentUrl || '', satispayPaymentUrl: c.satispayPaymentUrl || '' });
});
app.get('/api/floorplan', (q, s) => s.json(fp()));

app.get('/api/today', async (q, s) => {
  const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  const u = await db.userBySession(q.cookies && q.cookies.sid);
  const rows = (await db.todayBookings(iso)).map((b) => {
    const row = { deskId: b.deskId, slot: b.slot, status: b.status, mine: !!(u && b.userId === u.id) };
    if (u) { row.name = b.name || 'Ospite'; row.userId = b.userId; }
    return row;
  });
  s.json({ date: iso, bookings: rows });
});

app.get('/api/availability', auth, async (q, s) => {
  const { from, to } = q.query;
  if (!from || !to) return s.json([]);
  const rows = await db.availability(from, to);
  s.json(rows.map((b) => ({ deskId: b.deskId, date: b.date, slot: b.slot, mine: b.userId === q.u.id })));
});

const days = (m) => {
  const [y, mo] = m.split('-').map(Number);
  const r = [];
  for (let d = 1; d <= new Date(y, mo, 0).getDate(); d++) {
    const dt = new Date(y, mo - 1, d);
    if (dt.getDay() % 6) r.push(`${m}-${String(d).padStart(2, '0')}`);
  }
  return r;
};

app.post('/api/bookings', auth, async (q, s) => {
  const { deskId, mode, date, month, slot, payment } = q.body || {};
  const P = fp();
  if (!P.desks.find((d) => d.id === deskId)) return s.status(400).json({ error: 'Scrivania non valida' });
  if (!['bonifico', 'paypal', 'contanti', 'satispay'].includes(payment)) return s.status(400).json({ error: 'Scegli un metodo di pagamento' });
  let dates, sl, price;
  if (mode === 'mensile') {
    if (!/^\d{4}-\d{2}$/.test(month || '')) return s.status(400).json({ error: 'Mese non valido' });
    dates = days(month);
    sl = 'giornata';
    price = P.pricing.mensile;
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !P.pricing[slot]) return s.status(400).json({ error: 'Data o fascia non valida' });
    dates = [date];
    sl = slot;
    price = P.pricing[slot];
  }
  const bookMode = mode === 'mensile' ? 'mensile' : 'giornaliero';
  const online = ['satispay', 'paypal'].includes(payment);
  const st = online ? 'in attesa di pagamento' : 'da saldare';
  const result = await db.createBookingSet({
    userId: q.u.id, deskId, dates, slot: sl, mode: bookMode, payment, status: st, price,
  });
  if (result.conflict) {
    return s.status(409).json({ error: `${deskId} è già occupata il ${result.conflict.date} (${result.conflict.slot})` });
  }
  if (payment === 'contanti') {
    notify({
      type: 'contanti_da_riscuotere',
      to: 'owner (Base Luna Studio)',
      group: result.group,
      user: q.u.name,
      email: q.u.email,
      deskId,
      from: dates[0],
      to_date: dates[dates.length - 1],
      days: dates.length,
      slot: sl,
      amount: price,
      text: `Prenotazione in contanti: ${q.u.name} (${q.u.email}) — scrivania ${deskId}, ${dates[0]}${dates.length > 1 ? ' → ' + dates[dates.length - 1] + ' (' + dates.length + ' giorni)' : ' (' + sl + ')'}, €${price} da riscuotere.`,
    });
  }
  s.json({ ok: 1, group: result.group, amount: price, days: dates.length, status: st, payUrl: online ? `/pay/${payment}?g=${result.group}` : null });
});

app.get('/api/pay/:g', auth, async (q, s) => {
  const p = await db.paymentByGroup(q.params.g);
  if (!p || (p.userId !== q.u.id && q.u.role !== 'admin')) return s.status(404).json({ error: 'Pagamento non trovato' });
  s.json({ ...p, link: linkFor(p.method, p.amount) });
});

app.post('/api/pay/:g/reported', auth, async (q, s) => {
  const ok = await db.markPaymentReported(q.params.g, q.u.id);
  if (!ok) return s.sendStatus(404);
  s.json({ ok: 1 });
});

app.post('/api/admin/pay/:g/paid', auth, admin, async (q, s) => {
  const ok = await db.markPaymentPaid(q.params.g);
  if (!ok) return s.sendStatus(404);
  s.json({ ok: 1 });
});

app.get('/api/admin/payments', auth, admin, async (q, s) => {
  s.json(await db.listOpenPayments());
});

app.get('/api/admin/pricing', auth, admin, (q, s) => {
  const P = fp();
  s.json(P.pricing || {});
});

app.patch('/api/admin/pricing', auth, admin, (q, s) => {
  const b = q.body || {};
  const keys = ['mattina', 'pomeriggio', 'giornata', 'mensile'];
  const P = fp();
  P.pricing = P.pricing || {};
  for (const k of keys) {
    if (k in b) {
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0) return s.status(400).json({ error: 'Prezzo non valido: ' + k });
      P.pricing[k] = Math.round(n * 100) / 100;
    }
  }
  fs.writeFileSync(FP, JSON.stringify(P, null, 2));
  s.json(P.pricing);
});

app.get('/pay/:m', (q, s) => s.sendFile(path.join(__dirname, 'public/pay.html')));

app.get('/api/bookings/mine', auth, async (q, s) => {
  s.json(await db.listBookingsForUser(q.u.id));
});

app.delete('/api/bookings/:id', auth, async (q, s) => {
  const b = await db.getBooking(q.params.id);
  if (!b || (b.userId !== q.u.id && q.u.role !== 'admin')) return s.status(404).json({ error: 'Non trovata' });
  await db.cancelBooking(q.params.id);
  s.json({ ok: 1 });
});

app.get('/api/admin/users', auth, admin, async (q, s) => {
  const rows = await db.listUsers();
  s.json(rows.map(({ user, bookings }) => ({ ...pub(user), bookings })));
});

app.patch('/api/admin/users/:id', auth, admin, async (q, s) => {
  const u = await db.userById(+q.params.id);
  if (!u) return s.sendStatus(404);
  if (u.id === q.u.id) return s.status(400).json({ error: 'Non puoi modificare te stesso' });
  const patch = {};
  if ('active' in q.body) patch.active = !!q.body.active;
  if (q.body.role) patch.role = q.body.role === 'admin' ? 'admin' : 'user';
  const updated = await db.updateUser(u.id, patch);
  s.json(pub(updated));
});

app.get('/api/admin/bookings', auth, admin, async (q, s) => {
  s.json(await db.listBookingsAdmin());
});

app.delete('/api/admin/users/:id', auth, admin, async (q, s) => {
  const id = +q.params.id;
  const u = await db.userById(id);
  if (!u) return s.sendStatus(404);
  if (u.id === q.u.id) return s.status(400).json({ error: 'Non puoi eliminare te stesso' });
  await db.deleteUser(id);
  s.json({ ok: 1 });
});

app.post('/api/admin/bookings/cancel-day', auth, admin, async (q, s) => {
  const day = (q.body || {}).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return s.status(400).json({ error: 'Data non valida' });
  const n = await db.cancelDay(day);
  s.json({ ok: 1, cancelled: n });
});

app.post('/api/admin/bookings/cancel-month', auth, admin, async (q, s) => {
  const month = (q.body || {}).month;
  if (!/^\d{4}-\d{2}$/.test(month || '')) return s.status(400).json({ error: 'Mese non valido' });
  const n = await db.cancelMonth(month);
  s.json({ ok: 1, cancelled: n });
});

app.get('/api/hots', (q, s) => {
  const fpJs = path.join(__dirname, 'public', 'floorplan.js');
  const txt = fs.readFileSync(fpJs, 'utf8');
  const hots = {};
  for (const id of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
    const mm = txt.match(new RegExp(id + ':(\\[[^\\n]+\\])'));
    if (!mm) return s.status(500).json({ error: 'HOTS mancante: ' + id });
    hots[id] = JSON.parse(mm[1]);
  }
  s.json({ hots, version: (txt.match(/v(\d{8}\w)/) || [])[1] || null });
});

app.post('/api/hots', (q, s) => {
  const h = q.body && q.body.hots;
  if (!h) return s.status(400).json({ error: 'hots richiesti' });
  for (const id of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
    if (!Array.isArray(h[id]) || h[id].length !== 4) return s.status(400).json({ error: 'Formato ' + id });
  }
  const fpJs = path.join(__dirname, 'public', 'floorplan.js');
  let txt = fs.readFileSync(fpJs, 'utf8');
  const block = [' _HOTS:{'];
  for (const id of ['A1', 'A2', 'A3', 'B1', 'B2', 'B3']) {
    const pts = h[id].map((p) => '[' + (+p[0]).toFixed(1) + ',' + (+p[1]).toFixed(1) + ']').join(',');
    block.push('   ' + id + ':[' + pts + '],');
  }
  block.push(' },');
  const next = txt.replace(/ _HOTS:\{[\s\S]*?\n \},/, block.join('\n'));
  if (next === txt) return s.status(500).json({ error: 'Sostituzione fallita' });
  const ver = '20261102u';
  const stamped = next.replace(/v20261102\w/g, 'v' + ver).replace(/\?v=20261102\w/g, '?v=' + ver);
  fs.writeFileSync(fpJs, stamped);
  const idx = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(idx)) {
    let i = fs.readFileSync(idx, 'utf8');
    i = i.replace(/\?v=20261102\w/g, '?v=' + ver);
    fs.writeFileSync(idx, i);
  }
  s.json({ ok: 1, version: 'v' + ver, hots: h });
});

app.get(/^\/(?!api).*/, (q, s) => s.sendFile(path.join(__dirname, 'public/index.html')));

app.use((err, q, s, next) => {
  console.error(err);
  if (s.headersSent) return next(err);
  s.status(500).json({ error: 'Errore del server' });
});

let server;
let keepAlive;

function startKeepAlive() {
  keepAlive = setInterval(() => {
    db.ping().catch((err) => console.error('DB keep-alive failed:', err.message));
  }, 4 * 60 * 1000);
  if (typeof keepAlive.unref === 'function') keepAlive.unref();
}

function shutdown() {
  if (keepAlive) clearInterval(keepAlive);
  const done = () => db.close().catch(() => {}).finally(() => process.exit(0));
  if (server) server.close(done);
  else done();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function boot() {
  const url = process.env.DATABASE_URL;
  if (!url || !String(url).trim()) {
    console.error('FATAL: DATABASE_URL non impostata. Il server non parte: utenti, sessioni, prenotazioni e pagamenti stanno su Postgres. Nessun ripiego su data/db.json, perché quel file verrebbe azzerato a ogni deploy su Render.');
    process.exit(1);
  }
  try {
    await db.init({ connectionString: url.trim(), importPath: DB });
  } catch (err) {
    const message = String(err && err.message || err).replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***');
    console.error('FATAL: connessione o schema Postgres non riusciti:', message);
    process.exit(1);
  }
  startKeepAlive();
  const PORT = process.env.PORT || 5173;
  server = app.listen(PORT, '0.0.0.0', () => console.log('Base Luna Coworking su http://localhost:' + PORT));
}

boot();

module.exports = { app };
