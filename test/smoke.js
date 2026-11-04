const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const sharp = require('sharp');
const ConnectionParameters = require('pg/lib/connection-parameters');
const { connectionOptions } = require('../db');

const root = path.join(__dirname, '..');
const dbFile = path.join(root, 'data', 'db.json');

function optsOf(url) {
  return connectionOptions(url);
}

function checkConnectionOptions() {
  const neon = optsOf('postgresql://user:secret@ep-example-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require');
  assert.strictEqual(neon.ssl.rejectUnauthorized, false);
  assert.ok(!/sslmode=/i.test(neon.connectionString), 'sslmode stripped so node-pg does not force verify-full');
  assert.ok(!/secret/.test(JSON.stringify({ ssl: neon.ssl })), 'ssl object must not embed the password');
  const parsed = new ConnectionParameters(neon);
  assert.strictEqual(parsed.ssl && parsed.ssl.rejectUnauthorized, false, 'pg must keep rejectUnauthorized false for Neon');
  assert.ok(/-pooler/.test(parsed.host));

  const local = optsOf('postgres://baseluna:baseluna@127.0.0.1:5432/baseluna_smoke');
  assert.strictEqual(local.ssl, undefined);

  const disabled = optsOf('postgres://baseluna:baseluna@127.0.0.1:5432/baseluna_smoke?sslmode=disable');
  assert.strictEqual(disabled.ssl, undefined);
  console.log('connection options ok');
}

function runNode(args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out, err, killed: true });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, killed: false });
    });
  });
}

async function bootWithoutDatabaseUrl() {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const res = await runNode(['server.js'], env, 8000);
  assert.notStrictEqual(res.code, 0, 'server must refuse to boot without DATABASE_URL');
  assert.match(res.err, /DATABASE_URL/);
  assert.doesNotMatch(res.err + res.out, /data\/db\.json[\s\S]{0,80}fallback|ripiego su JSON che scrive/i);
  console.log('boot without DATABASE_URL exits:', res.code);
}

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sid = list.find((c) => c.startsWith('sid='));
  assert.ok(sid, 'missing sid cookie');
  assert.match(sid, /HttpOnly/i);
  assert.match(sid, /SameSite=Lax/i);
  assert.match(sid, /Max-Age=2592000/);
  assert.match(sid, /Secure/i);
  return sid.split(';')[0];
}

async function api(base, urlPath, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

function spawnServer(port, envExtra) {
  const env = { ...process.env, ...envExtra, PORT: String(port), NODE_ENV: 'production' };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.log = () => log;
  return child;
}

async function waitHealth(base, child) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < 20000) {
    if (child.exitCode != null) throw new Error('server exited early ' + child.exitCode + '\n' + child.log());
    try {
      const r = await api(base, '/api/health');
      if (r.status === 200 && r.json && r.json.ok === true) return;
      last = JSON.stringify(r.json);
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('health timeout: ' + last + '\n' + child.log());
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    }, 5000);
  });
}

async function resetSchema(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();
}

async function counts(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  const q = async (sql) => (await client.query(sql)).rows[0].n;
  const n = {
    users: await q('SELECT COUNT(*)::int AS n FROM users'),
    sessions: await q('SELECT COUNT(*)::int AS n FROM sessions'),
    bookings: await q('SELECT COUNT(*)::int AS n FROM bookings'),
    payments: await q('SELECT COUNT(*)::int AS n FROM payments'),
  };
  await client.end();
  return n;
}

async function noisePng(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 17 + (i % 251)) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function imageBytes(url) {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') || '', buf };
}

function weekdayCount(month) {
  const [y, mo] = month.split('-').map(Number);
  let n = 0;
  for (let d = 1; d <= new Date(y, mo, 0).getDate(); d++) {
    if (new Date(y, mo - 1, d).getDay() % 6) n++;
  }
  return n;
}

async function integration(connectionString) {
  assert.match(connectionString, /@(localhost|127\.0\.0\.1)/, 'smoke test refuses non-local databases');
  const port = 4173;
  const base = 'http://127.0.0.1:' + port;
  const backup = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;

  async function withServer(fn) {
    const child = spawnServer(port);
    try {
      await waitHealth(base, child);
      await fn(child);
    } catch (err) {
      console.error(child.log());
      throw err;
    } finally {
      await stopServer(child);
    }
  }

  if (backup) {
    await resetSchema(connectionString);
    const file = JSON.parse(backup.toString('utf8'));
    await withServer(async (child) => {
      assert.match(child.log(), /Importati da data\/db\.json/);
      const n = await counts(connectionString);
      assert.strictEqual(n.users, (file.users || []).length);
      assert.strictEqual(n.bookings, (file.bookings || []).length);
      assert.strictEqual(n.payments, (file.payments || []).length);
      assert.strictEqual(n.sessions, Object.keys(file.sessions || {}).length);
    });
    await withServer(async (child) => {
      assert.match(child.log(), /import JSON saltato/);
    });
    console.log('real data/db.json imports once');
    await resetSchema(connectionString);
  }

  const hash = bcrypt.hashSync('importpass', 10);
  const fixture = {
    users: [{
      id: 4,
      name: 'Importato',
      email: 'import@example.invalid',
      hash,
      role: 'user',
      active: true,
      bio: 'ciao',
      avatar: '',
      title: 'Ospite',
    }],
    bookings: [{
      id: 'book0001',
      group: 'group001',
      userId: 4,
      deskId: 'B3',
      date: '2026-12-02',
      slot: 'pomeriggio',
      mode: 'giornaliero',
      payment: 'paypal',
      status: 'in attesa di pagamento',
      price: 12,
      created: '2026-11-01T00:00:00.000Z',
    }],
    sessions: {},
    payments: [{
      group: 'group001',
      userId: 4,
      deskId: 'B3',
      dates: ['2026-12-02', '2026-12-02'],
      days: 1,
      mode: 'giornaliero',
      slot: 'pomeriggio',
      amount: 12,
      method: 'paypal',
      status: 'in attesa',
    }],
  };

  try {
    fs.writeFileSync(dbFile, JSON.stringify(fixture));
    await resetSchema(connectionString);
    let adminCookie;
    let userCookie;
    let adaAvatar;
    let legacyAvatar;
    const floorFile = fs.readFileSync(path.join(root, 'data', 'floorplan.json'), 'utf8');
    const avDir = path.join(root, 'public', 'uploads', 'avatars');
    await withServer(async (child) => {
      const health = await api(base, '/api/health');
      assert.deepStrictEqual(health.json, { ok: true });

      assert.match(child.log(), /Prezzi pacchetti importati da data\/floorplan\.json/);
      const floor = await api(base, '/api/floorplan');
      assert.strictEqual(floor.status, 200);
      assert.ok(floor.json.desks.some((d) => d.id === 'A1'));
      assert.strictEqual(floor.json.image, '/media/floorplan.png');
      assert.strictEqual(floor.json.desks.find((d) => d.id === 'A1').x, 37);
      assert.strictEqual(floor.json.pricing.mattina, 12);
      assert.strictEqual(floor.json.pricing.pomeriggio, 12);
      assert.strictEqual(floor.json.pricing.giornata, 20);
      assert.strictEqual(floor.json.pricing.mensile, 290);

      const anonToday = await api(base, '/api/today');
      assert.strictEqual(anonToday.status, 200);
      assert.ok(anonToday.json.date);
      for (const row of anonToday.json.bookings) {
        assert.strictEqual(row.name, undefined);
        assert.strictEqual(row.userId, undefined);
      }

      const imported = await api(base, '/api/login', { method: 'POST', body: { email: 'import@example.invalid', password: 'importpass' } });
      assert.strictEqual(imported.status, 200);
      assert.strictEqual(imported.json.role, 'user');
      assert.strictEqual(imported.json.hash, undefined);
      const importedCookie = cookieHeader(imported.res);
      const mineImported = await api(base, '/api/bookings/mine', { cookie: importedCookie });
      assert.strictEqual(mineImported.status, 200);
      assert.strictEqual(mineImported.json.length, 1);
      assert.strictEqual(mineImported.json[0].date, '2026-12-02');
      assert.strictEqual(mineImported.json[0].price, 12);
      assert.strictEqual(mineImported.json[0].group, 'group001');

      const reg = await api(base, '/api/register', { method: 'POST', body: { name: 'Ada Admin', email: 'Ada@Example.invalid', password: 'secret1' } });
      assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
      assert.strictEqual(reg.json.role, 'admin');
      assert.strictEqual(reg.json.email, 'ada@example.invalid');
      adminCookie = cookieHeader(reg.res);

      const dup = await api(base, '/api/register', { method: 'POST', body: { name: 'Altro', email: 'ada@example.invalid', password: 'secret1' } });
      assert.strictEqual(dup.status, 409);

      const me = await api(base, '/api/me', { cookie: adminCookie });
      assert.strictEqual(me.json.email, 'ada@example.invalid');

      const user = await api(base, '/api/register', { method: 'POST', body: { name: 'Ugo Utente', email: 'ugo@example.invalid', password: 'secret2' } });
      assert.strictEqual(user.json.role, 'user');
      userCookie = cookieHeader(user.res);

      const shortPw = await api(base, '/api/register', { method: 'POST', body: { name: 'X', email: 'x@example.invalid', password: '123' } });
      assert.strictEqual(shortPw.status, 400);

      const prof = await api(base, '/api/me/profile', { method: 'PATCH', cookie: userCookie, body: { name: 'Ugo Luna', title: 'Designer', bio: 'ciao' } });
      assert.strictEqual(prof.json.name, 'Ugo Luna');
      assert.strictEqual(prof.json.title, 'Designer');
      assert.strictEqual(prof.json.bio, 'ciao');
      const meProf = await api(base, '/api/me', { cookie: userCookie });
      assert.strictEqual(meProf.json.name, 'Ugo Luna');
      assert.strictEqual(meProf.json.bio, 'ciao');
      assert.strictEqual(meProf.json.title, 'Designer');

      const unauth = await api(base, '/api/bookings', { method: 'POST', body: {} });
      assert.strictEqual(unauth.status, 401);

      const badDesk = await api(base, '/api/bookings', { method: 'POST', cookie: userCookie, body: { deskId: 'Z9', mode: 'giornaliero', date: '2026-12-01', slot: 'mattina', payment: 'bonifico' } });
      assert.strictEqual(badDesk.status, 400);

      const romeToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
      const todayBook = await api(base, '/api/bookings', {
        method: 'POST', cookie: userCookie,
        body: { deskId: 'B1', mode: 'giornaliero', date: romeToday, slot: 'mattina', payment: 'bonifico' },
      });
      assert.strictEqual(todayBook.status, 200, JSON.stringify(todayBook.json));
      const pubToday = await api(base, '/api/today');
      const privToday = await api(base, '/api/today', { cookie: userCookie });
      const pubRow = pubToday.json.bookings.find((b) => b.deskId === 'B1' && b.slot === 'mattina');
      const privRow = privToday.json.bookings.find((b) => b.deskId === 'B1' && b.slot === 'mattina');
      assert.ok(pubRow, 'public today should list the desk');
      assert.strictEqual(pubRow.name, undefined);
      assert.strictEqual(pubRow.userId, undefined);
      assert.strictEqual(pubRow.mine, false);
      assert.strictEqual(privRow.name, 'Ugo Luna');
      assert.strictEqual(privRow.userId, user.json.id);
      assert.strictEqual(privRow.mine, true);

      const book = await api(base, '/api/bookings', {
        method: 'POST', cookie: userCookie,
        body: { deskId: 'A1', mode: 'giornaliero', date: '2026-12-01', slot: 'mattina', payment: 'bonifico' },
      });
      assert.strictEqual(book.status, 200, JSON.stringify(book.json));
      assert.strictEqual(book.json.amount, 12);
      assert.strictEqual(book.json.status, 'da saldare');
      assert.strictEqual(book.json.payUrl, null);
      assert.strictEqual(book.json.days, 1);

      const clash = await api(base, '/api/bookings', {
        method: 'POST', cookie: adminCookie,
        body: { deskId: 'A1', mode: 'giornaliero', date: '2026-12-01', slot: 'mattina', payment: 'contanti' },
      });
      assert.strictEqual(clash.status, 409);

      const otherSlot = await api(base, '/api/bookings', {
        method: 'POST', cookie: adminCookie,
        body: { deskId: 'A1', mode: 'giornaliero', date: '2026-12-01', slot: 'pomeriggio', payment: 'contanti' },
      });
      assert.strictEqual(otherSlot.status, 200, JSON.stringify(otherSlot.json));
      assert.ok(fs.existsSync(path.join(root, 'data', 'notifications.json')));

      const dayBlock = await api(base, '/api/bookings', {
        method: 'POST', cookie: userCookie,
        body: { deskId: 'A1', mode: 'giornaliero', date: '2026-12-01', slot: 'giornata', payment: 'bonifico' },
      });
      assert.strictEqual(dayBlock.status, 409);

      const month = '2026-11';
      const monthly = await api(base, '/api/bookings', {
        method: 'POST', cookie: userCookie,
        body: { deskId: 'A2', mode: 'mensile', month, slot: 'mattina', payment: 'paypal' },
      });
      assert.strictEqual(monthly.status, 200, JSON.stringify(monthly.json));
      assert.strictEqual(monthly.json.days, weekdayCount(month));
      assert.strictEqual(monthly.json.amount, 290);
      assert.strictEqual(monthly.json.status, 'in attesa di pagamento');
      assert.strictEqual(monthly.json.payUrl, '/pay/paypal?g=' + monthly.json.group);

      const overlap = await api(base, '/api/bookings', {
        method: 'POST', cookie: adminCookie,
        body: { deskId: 'A2', mode: 'giornaliero', date: '2026-11-02', slot: 'mattina', payment: 'bonifico' },
      });
      assert.strictEqual(overlap.status, 409);

      const mine = await api(base, '/api/bookings/mine', { cookie: userCookie });
      const monthRows = mine.json.filter((b) => b.group === monthly.json.group);
      assert.strictEqual(monthRows.length, weekdayCount(month));
      assert.ok(monthRows.every((b) => b.price === null && b.slot === 'giornata' && b.mode === 'mensile'));

      const pay = await api(base, '/api/pay/' + monthly.json.group, { cookie: userCookie });
      assert.strictEqual(pay.status, 200);
      assert.deepStrictEqual(pay.json.dates[0].slice(0, 7), month);
      assert.strictEqual(pay.json.amount, 290);
      assert.strictEqual(pay.json.status, 'in attesa');

      const reported = await api(base, '/api/pay/' + monthly.json.group + '/reported', { method: 'POST', cookie: userCookie });
      assert.deepStrictEqual(reported.json, { ok: 1 });

      const forbidden = await api(base, '/api/admin/payments', { cookie: userCookie });
      assert.strictEqual(forbidden.status, 403);

      const payments = await api(base, '/api/admin/payments', { cookie: adminCookie });
      assert.strictEqual(payments.status, 200);
      const listed = payments.json.find((p) => p.group === monthly.json.group);
      assert.ok(listed);
      assert.strictEqual(listed.user, 'Ugo Luna');
      assert.strictEqual(listed.status, 'segnalato dal cliente');

      const paid = await api(base, '/api/admin/pay/' + monthly.json.group + '/paid', { method: 'POST', cookie: adminCookie });
      assert.deepStrictEqual(paid.json, { ok: 1 });
      const mineAfter = await api(base, '/api/bookings/mine', { cookie: userCookie });
      assert.ok(mineAfter.json.filter((b) => b.group === monthly.json.group).every((b) => b.status === 'confermata'));
      const paymentsAfter = await api(base, '/api/admin/payments', { cookie: adminCookie });
      assert.ok(!paymentsAfter.json.some((p) => p.group === monthly.json.group));

      const avail = await api(base, '/api/availability?from=2026-12-01&to=2026-12-01', { cookie: userCookie });
      assert.ok(avail.json.some((b) => b.deskId === 'A1' && b.slot === 'mattina' && b.mine === true));
      assert.ok(avail.json.some((b) => b.deskId === 'A1' && b.slot === 'pomeriggio' && b.mine === false));

      const users = await api(base, '/api/admin/users', { cookie: adminCookie });
      const ugo = users.json.find((u) => u.email === 'ugo@example.invalid');
      assert.ok(ugo.bookings > 0);
      const off = await api(base, '/api/admin/users/' + ugo.id, { method: 'PATCH', cookie: adminCookie, body: { active: false } });
      assert.strictEqual(off.json.active, false);
      const blocked = await api(base, '/api/login', { method: 'POST', body: { email: 'ugo@example.invalid', password: 'secret2' } });
      assert.strictEqual(blocked.status, 403);
      await api(base, '/api/admin/users/' + ugo.id, { method: 'PATCH', cookie: adminCookie, body: { active: true } });
      const back = await api(base, '/api/login', { method: 'POST', body: { email: 'ugo@example.invalid', password: 'secret2' } });
      assert.strictEqual(back.status, 200);
      assert.strictEqual(back.json.name, 'Ugo Luna');
      assert.strictEqual(back.json.bio, 'ciao');
      assert.strictEqual(back.json.title, 'Designer');
      userCookie = cookieHeader(back.res);

      const self = await api(base, '/api/admin/users/' + reg.json.id, { method: 'DELETE', cookie: adminCookie });
      assert.strictEqual(self.status, 400);

      const day = await api(base, '/api/admin/bookings/cancel-day', { method: 'POST', cookie: adminCookie, body: { date: '2026-12-01' } });
      assert.strictEqual(day.status, 200);
      assert.ok(day.json.cancelled >= 2);
      const monthCancel = await api(base, '/api/admin/bookings/cancel-month', { method: 'POST', cookie: adminCookie, body: { month: '2026-11' } });
      assert.strictEqual(monthCancel.status, 200);
      const todayInMonth = romeToday.startsWith(month) ? 1 : 0;
      assert.strictEqual(monthCancel.json.cancelled, weekdayCount(month) + todayInMonth);

      const del = await api(base, '/api/admin/users/' + ugo.id, { method: 'DELETE', cookie: adminCookie });
      assert.deepStrictEqual(del.json, { ok: 1 });
      const gone = await api(base, '/api/me', { cookie: userCookie });
      assert.strictEqual(gone.status, 401);

      const badPrice = await api(base, '/api/admin/pricing', { method: 'PATCH', cookie: adminCookie, body: { mattina: -1 } });
      assert.strictEqual(badPrice.status, 400);
      assert.match(badPrice.json.error, /Prezzo non valido: mattina/);
      const unchanged = await api(base, '/api/floorplan');
      assert.strictEqual(unchanged.json.pricing.mattina, 12);

      const patched = await api(base, '/api/admin/pricing', {
        method: 'PATCH', cookie: adminCookie,
        body: { mattina: 13, pomeriggio: 14, giornata: 21, mensile: 111 },
      });
      assert.strictEqual(patched.status, 200, JSON.stringify(patched.json));
      assert.strictEqual(patched.json.mattina, 13);
      assert.strictEqual(patched.json.pomeriggio, 14);
      assert.strictEqual(patched.json.giornata, 21);
      assert.strictEqual(patched.json.mensile, 111);
      const floorNow = await api(base, '/api/floorplan');
      assert.strictEqual(floorNow.json.pricing.giornata, 21);
      assert.strictEqual(floorNow.json.pricing.mensile, 111);
      assert.strictEqual(floorNow.json.image, '/media/floorplan.png');
      assert.strictEqual(floorNow.json.desks.find((d) => d.id === 'B3').y, 33.6);
      assert.strictEqual(fs.readFileSync(path.join(root, 'data', 'floorplan.json'), 'utf8'), floorFile);

      const priced = await api(base, '/api/bookings', {
        method: 'POST', cookie: adminCookie,
        body: { deskId: 'B2', mode: 'giornaliero', date: '2026-12-03', slot: 'giornata', payment: 'bonifico' },
      });
      assert.strictEqual(priced.status, 200, JSON.stringify(priced.json));
      assert.strictEqual(priced.json.amount, 21);

      const junk = await api(base, '/api/me/avatar', { method: 'POST', cookie: adminCookie, body: { image: 'data:image/png;base64,aaaa' } });
      assert.strictEqual(junk.status, 400);
      assert.match(junk.json.error, /Immagine non valida/);
      const big = Buffer.alloc(5e6 + 1, 7);
      const over = await api(base, '/api/me/avatar', { method: 'POST', cookie: adminCookie, body: { image: 'data:image/png;base64,' + big.toString('base64') } });
      assert.strictEqual(over.status, 400);
      assert.match(over.json.error, /Max 5 MB/);

      const srcPng = await noisePng(800, 600);
      assert.ok(srcPng.length > 10 * 1024);
      const listedBefore = fs.existsSync(avDir) ? fs.readdirSync(avDir).filter((f) => f !== '.gitkeep') : [];
      const up = await api(base, '/api/me/avatar', { method: 'POST', cookie: adminCookie, body: { image: 'data:image/png;base64,' + srcPng.toString('base64') } });
      assert.strictEqual(up.status, 200, JSON.stringify(up.json));
      assert.match(up.json.avatar, /^\/api\/users\/\d+\/avatar\?v=/);
      const listedAfter = fs.existsSync(avDir) ? fs.readdirSync(avDir).filter((f) => f !== '.gitkeep') : [];
      assert.deepStrictEqual(listedAfter, listedBefore);
      adaAvatar = await imageBytes(base + up.json.avatar);
      assert.strictEqual(adaAvatar.status, 200);
      assert.match(adaAvatar.type, /^image\/jpeg/);
      assert.ok(adaAvatar.buf.length < 80 * 1024, 'compressed avatar was ' + adaAvatar.buf.length);
      assert.ok(adaAvatar.buf.length < srcPng.length);
      const adaMeta = await sharp(adaAvatar.buf).metadata();
      assert.strictEqual(adaMeta.format, 'jpeg');
      assert.strictEqual(adaMeta.width, 256);
      assert.strictEqual(adaMeta.height, 256);

      const legacyPng = await sharp({ create: { width: 32, height: 48, channels: 3, background: { r: 20, g: 140, b: 200 } } }).png().toBuffer();
      fs.mkdirSync(avDir, { recursive: true });
      fs.writeFileSync(path.join(avDir, 'legacy-smoke.png'), legacyPng);
      const pg = new Client({ connectionString });
      await pg.connect();
      await pg.query(`UPDATE users SET avatar = $1 WHERE email = $2`, ['/uploads/avatars/legacy-smoke.png', 'import@example.invalid']);
      await pg.query(`DELETE FROM avatars WHERE user_id = (SELECT id FROM users WHERE email = $1)`, ['import@example.invalid']);
      await pg.query(
        `INSERT INTO users (id, name, email, hash, role, active, bio, avatar, title)
         VALUES (99, 'Ghost', 'ghost@example.invalid', $1, 'user', TRUE, '', '/uploads/avatars/does-not-exist.png', '')`,
        [hash]
      );
      await pg.end();

      const out = await api(base, '/api/logout', { method: 'POST', cookie: adminCookie });
      assert.deepStrictEqual(out.json, { ok: 1 });
      const afterOut = await api(base, '/api/me', { cookie: adminCookie });
      assert.strictEqual(afterOut.status, 401);

      const n = await counts(connectionString);
      assert.strictEqual(n.users, 3);
    });

    const before = await counts(connectionString);
    await withServer(async (child) => {
      assert.match(child.log(), /import JSON saltato/);
      assert.match(child.log(), /Prezzi pacchetti già presenti su Postgres/);
      assert.doesNotMatch(child.log(), /Prezzi pacchetti importati/);
      assert.match(child.log(), /Avatar importati dal disco in Postgres: 1/);
      assert.match(child.log(), /Avatar locali assenti, campo svuotato: 1/);

      const floor = await api(base, '/api/floorplan');
      assert.strictEqual(floor.json.pricing.mattina, 13);
      assert.strictEqual(floor.json.pricing.pomeriggio, 14);
      assert.strictEqual(floor.json.pricing.giornata, 21);
      assert.strictEqual(floor.json.pricing.mensile, 111);
      assert.strictEqual(floor.json.desks.find((d) => d.id === 'A1').x, 37);
      assert.strictEqual(fs.readFileSync(path.join(root, 'data', 'floorplan.json'), 'utf8'), floorFile);

      const login = await api(base, '/api/login', { method: 'POST', body: { email: 'ada@example.invalid', password: 'secret1' } });
      assert.strictEqual(login.status, 200);
      assert.strictEqual(login.json.role, 'admin');
      assert.match(login.json.avatar, /^\/api\/users\/\d+\/avatar\?v=/);
      const adminCookie2 = cookieHeader(login.res);
      const listed = await api(base, '/api/admin/pricing', { cookie: adminCookie2 });
      assert.strictEqual(listed.json.mensile, 111);
      const again = await imageBytes(base + login.json.avatar);
      assert.strictEqual(again.status, 200);
      assert.deepStrictEqual(again.buf, adaAvatar.buf);

      const imported = await api(base, '/api/login', { method: 'POST', body: { email: 'import@example.invalid', password: 'importpass' } });
      assert.strictEqual(imported.status, 200);
      assert.match(imported.json.avatar, /^\/api\/users\/\d+\/avatar\?v=/);
      legacyAvatar = await imageBytes(base + imported.json.avatar);
      assert.strictEqual(legacyAvatar.status, 200);
      assert.match(legacyAvatar.type, /^image\/jpeg/);
      const legacyMeta = await sharp(legacyAvatar.buf).metadata();
      assert.strictEqual(legacyMeta.format, 'jpeg');
      assert.ok(legacyMeta.width <= 256 && legacyMeta.height <= 256);
      assert.ok(legacyAvatar.buf.length < 80 * 1024);
      fs.unlinkSync(path.join(avDir, 'legacy-smoke.png'));
      const still = await imageBytes(base + imported.json.avatar);
      assert.deepStrictEqual(still.buf, legacyAvatar.buf);

      const pg = new Client({ connectionString });
      await pg.connect();
      const ghost = await pg.query('SELECT avatar FROM users WHERE id = 99');
      await pg.end();
      assert.strictEqual(ghost.rows[0].avatar, '');
    });
    const after = await counts(connectionString);
    assert.strictEqual(after.users, before.users);
    assert.strictEqual(after.bookings, before.bookings);
    assert.strictEqual(after.payments, before.payments);

    await withServer(async (child) => {
      assert.match(child.log(), /Prezzi pacchetti già presenti su Postgres/);
      assert.doesNotMatch(child.log(), /Prezzi pacchetti importati/);
      assert.doesNotMatch(child.log(), /Avatar importati dal disco/);
      assert.doesNotMatch(child.log(), /campo svuotato/);
      const floor = await api(base, '/api/floorplan');
      assert.strictEqual(floor.json.pricing.mensile, 111);
      assert.strictEqual(floor.json.pricing.giornata, 21);
      assert.strictEqual(floor.json.image, '/media/floorplan.png');
      const login = await api(base, '/api/login', { method: 'POST', body: { email: 'ada@example.invalid', password: 'secret1' } });
      const img = await imageBytes(base + login.json.avatar);
      assert.deepStrictEqual(img.buf, adaAvatar.buf);
      const imported = await api(base, '/api/login', { method: 'POST', body: { email: 'import@example.invalid', password: 'importpass' } });
      const img2 = await imageBytes(base + imported.json.avatar);
      assert.deepStrictEqual(img2.buf, legacyAvatar.buf);
    });
    console.log('api flow ok');
  } finally {
    const legacy = path.join(root, 'public', 'uploads', 'avatars', 'legacy-smoke.png');
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    if (backup) fs.writeFileSync(dbFile, backup);
    else if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
}

async function main() {
  checkConnectionOptions();
  await bootWithoutDatabaseUrl();
  const url = process.env.DATABASE_URL;
  if (!url || !/@(localhost|127\.0\.0\.1)/.test(url)) {
    console.log('skip http integration: set DATABASE_URL to a local Postgres');
    return;
  }
  await integration(url);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
