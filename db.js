const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

let pool;

// node-postgres 8.13+ treats sslmode=require as verify-full, which rejects
// Neon's certificate chain. Strip sslmode and set ssl explicitly when the
// URL asks for TLS (Neon DATABASE_URL uses sslmode=require). Localhost
// without sslmode stays unencrypted so a dev Postgres still works.
function connectionOptions(connectionString) {
  const sslmode = (/(?:[?&])sslmode=([^&]+)/i.exec(connectionString) || [])[1];
  const mode = sslmode ? sslmode.toLowerCase() : '';
  const local = /@(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(connectionString);
  const neon = /neon\.tech/i.test(connectionString);
  const opts = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 20000,
    application_name: 'baseluna-coworking',
  };
  // verify-full must keep checking the certificate. disable/allow stay as written.
  if (mode === 'disable' || mode === 'allow' || mode === 'verify-full') return opts;
  // pg 8.13+ treats sslmode=require as verify-full and the connection string
  // overwrites an explicit ssl option. Strip sslmode and encrypt without
  // verifying the chain — this is what Neon needs for sslmode=require.
  const encryptWithoutVerify = neon || mode === 'require' || mode === 'prefer' || mode === 'verify-ca' || mode === 'no-verify' || (!local && !mode);
  if (!encryptWithoutVerify) return opts;
  if (mode) {
    opts.connectionString = connectionString.replace(/([?&])sslmode=[^&]*&?/gi, '$1').replace(/[?&]$/, '');
  }
  opts.ssl = { rejectUnauthorized: false };
  return opts;
}

function usingPooledEndpoint(connectionString) {
  return /-pooler/i.test(connectionString);
}

function getPool() {
  if (!pool) throw new Error('Database non inizializzato');
  return pool;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapUser(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name,
    email: r.email,
    hash: r.hash,
    role: r.role,
    active: r.active,
    bio: r.bio || '',
    avatar: r.avatar || '',
    title: r.title || '',
  };
}

function mapBooking(r) {
  return {
    id: r.id,
    group: r.grp,
    userId: Number(r.user_id),
    deskId: r.desk_id,
    date: r.date,
    slot: r.slot,
    mode: r.mode,
    payment: r.payment,
    status: r.status,
    price: num(r.price),
    created: r.created,
  };
}

function mapPayment(r) {
  const p = {
    group: r.grp,
    userId: Number(r.user_id),
    deskId: r.desk_id,
    dates: [r.date_from, r.date_to],
    days: Number(r.days),
    mode: r.mode,
    slot: r.slot,
    amount: num(r.amount),
    method: r.method,
    status: r.status,
  };
  if (r.reported) p.reported = r.reported;
  if (r.paid) p.paid = r.paid;
  return p;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      hash TEXT NOT NULL,
      role TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      bio TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT ''
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      grp TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      desk_id TEXT NOT NULL,
      date TEXT NOT NULL,
      slot TEXT NOT NULL,
      mode TEXT NOT NULL,
      payment TEXT NOT NULL,
      status TEXT NOT NULL,
      price DOUBLE PRECISION,
      created TEXT NOT NULL,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS bookings_desk_date_idx ON bookings (desk_id, date)');
  await client.query('CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings (user_id)');
  await client.query('CREATE INDEX IF NOT EXISTS bookings_grp_idx ON bookings (grp)');
  await client.query('CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings (date)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS payments (
      grp TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      desk_id TEXT NOT NULL,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      days INTEGER NOT NULL,
      mode TEXT NOT NULL,
      slot TEXT NOT NULL,
      amount DOUBLE PRECISION,
      method TEXT NOT NULL,
      status TEXT NOT NULL,
      reported TEXT,
      paid TEXT,
      inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id)');
}

async function importJsonIfEmpty(importPath) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(8675309)');
    const count = await client.query(`
      SELECT (
        (SELECT COUNT(*) FROM users) +
        (SELECT COUNT(*) FROM sessions) +
        (SELECT COUNT(*) FROM bookings) +
        (SELECT COUNT(*) FROM payments)
      )::int AS n
    `);
    if (count.rows[0].n > 0) {
      await client.query('COMMIT');
      return { imported: false, reason: 'rows' };
    }
    if (!importPath || !fs.existsSync(importPath)) {
      await client.query('COMMIT');
      return { imported: false, reason: 'nofile' };
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(importPath, 'utf8'));
    } catch (err) {
      throw new Error('data/db.json non è JSON valido: ' + err.message);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('data/db.json deve essere un oggetto con users, bookings, sessions, payments');
    }
    const users = Array.isArray(data.users) ? data.users : [];
    const bookings = Array.isArray(data.bookings) ? data.bookings : [];
    const payments = Array.isArray(data.payments) ? data.payments : [];
    const sessions = data.sessions || {};
    if (typeof sessions !== 'object' || Array.isArray(sessions)) {
      throw new Error('data/db.json: sessions deve essere un oggetto token → userId');
    }

    for (const u of users) {
      if (u == null || u.id == null || !u.email || !u.hash) {
        throw new Error('data/db.json: utente senza id, email o hash');
      }
      await client.query(
        `INSERT INTO users (id, name, email, hash, role, active, bio, avatar, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          Number(u.id),
          u.name || '',
          String(u.email).toLowerCase(),
          u.hash,
          u.role || 'user',
          u.active !== false,
          u.bio || '',
          u.avatar || '',
          u.title || '',
        ]
      );
    }
    for (const [token, userId] of Object.entries(sessions)) {
      if (!token || userId == null) continue;
      await client.query('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, Number(userId)]);
    }
    for (const b of bookings) {
      await client.query(
        `INSERT INTO bookings (id, grp, user_id, desk_id, date, slot, mode, payment, status, price, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          b.id,
          b.group,
          Number(b.userId),
          b.deskId,
          b.date,
          b.slot,
          b.mode,
          b.payment,
          b.status,
          b.price == null ? null : Number(b.price),
          b.created || new Date().toISOString(),
        ]
      );
    }
    for (const p of payments) {
      const dates = Array.isArray(p.dates) ? p.dates : [];
      await client.query(
        `INSERT INTO payments (grp, user_id, desk_id, date_from, date_to, days, mode, slot, amount, method, status, reported, paid)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          p.group,
          Number(p.userId),
          p.deskId || '',
          dates[0] || '',
          dates[dates.length - 1] || dates[0] || '',
          Number(p.days) || dates.length || 1,
          p.mode,
          p.slot,
          p.amount == null ? null : Number(p.amount),
          p.method,
          p.status,
          p.reported || null,
          p.paid || null,
        ]
      );
    }
    await client.query('COMMIT');
    return {
      imported: true,
      users: users.length,
      sessions: Object.keys(sessions).length,
      bookings: bookings.length,
      payments: payments.length,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function init({ connectionString, importPath }) {
  if (pool) return;
  const neonDirect = /neon\.tech/i.test(connectionString) && !usingPooledEndpoint(connectionString);
  if (neonDirect) {
    console.warn('DATABASE_URL punta all\'endpoint Neon diretto. Per questa app è meglio l\'host pooled (contiene -pooler).');
  } else if (usingPooledEndpoint(connectionString)) {
    console.log('Postgres: endpoint pooled');
  }
  pool = new Pool(connectionOptions(connectionString));
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
  });
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      await ensureSchema(client);
    } finally {
      client.release();
    }
    const result = await importJsonIfEmpty(importPath);
    if (result.imported) {
      console.log(`Importati da data/db.json: ${result.users} utenti, ${result.sessions} sessioni, ${result.bookings} prenotazioni, ${result.payments} pagamenti`);
    } else if (result.reason === 'rows') {
      console.log('Postgres pronto (dati già presenti, import JSON saltato)');
    } else {
      console.log('Postgres pronto (nessun data/db.json da importare)');
    }
    return result;
  } catch (err) {
    await pool.end().catch(() => {});
    pool = null;
    throw err;
  }
}

async function ping() {
  await getPool().query('SELECT 1');
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

async function userBySession(token) {
  if (!token) return null;
  const { rows } = await getPool().query(
    `SELECT u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1
       AND s.created_at > NOW() - INTERVAL '30 days'`,
    [token]
  );
  const u = mapUser(rows[0]);
  return u && u.active ? u : null;
}

async function userByEmail(email) {
  const { rows } = await getPool().query('SELECT * FROM users WHERE email = $1', [email]);
  return mapUser(rows[0]);
}

async function userById(id) {
  if (!Number.isInteger(id)) return null;
  const { rows } = await getPool().query('SELECT * FROM users WHERE id = $1', [id]);
  return mapUser(rows[0]);
}

async function createSession(token, userId) {
  await getPool().query('INSERT INTO sessions (token, user_id) VALUES ($1,$2)', [token, userId]);
}

async function deleteSession(token) {
  if (!token) return;
  await getPool().query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function createUser({ name, email, hash }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    const dup = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const adm = await client.query(`SELECT 1 FROM users WHERE role = 'admin'`);
    const role = adm.rowCount ? 'user' : 'admin';
    const idR = await client.query('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM users');
    const id = Number(idR.rows[0].id);
    const ins = await client.query(
      `INSERT INTO users (id, name, email, hash, role, active, bio, avatar, title)
       VALUES ($1,$2,$3,$4,$5, TRUE, '', '', '')
       RETURNING *`,
      [id, name, email, hash, role]
    );
    await client.query('COMMIT');
    return mapUser(ins.rows[0]);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    if (err.code === '23505') return null;
    throw err;
  } finally {
    client.release();
  }
}

const USER_COLS = {
  name: 'name',
  email: 'email',
  hash: 'hash',
  role: 'role',
  active: 'active',
  bio: 'bio',
  avatar: 'avatar',
  title: 'title',
};

async function updateUser(id, patch) {
  const keys = Object.keys(patch).filter((k) => USER_COLS[k] && patch[k] !== undefined);
  if (!keys.length) return userById(id);
  const sets = keys.map((k, i) => `${USER_COLS[k]} = $${i + 2}`);
  const vals = keys.map((k) => patch[k]);
  const { rows } = await getPool().query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...vals]
  );
  return mapUser(rows[0]);
}

async function listUsers() {
  const { rows } = await getPool().query(`
    SELECT u.*, (
      SELECT COUNT(*)::int FROM bookings b
      WHERE b.user_id = u.id AND b.status <> 'annullata'
    ) AS live_bookings
    FROM users u
    ORDER BY u.id
  `);
  return rows.map((r) => ({ user: mapUser(r), bookings: r.live_bookings }));
}

async function deleteUser(id) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [id]);
    if (!exists.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await client.query(
      `UPDATE bookings SET status = 'annullata' WHERE user_id = $1 AND status <> 'annullata'`,
      [id]
    );
    await client.query(
      `UPDATE payments SET status = 'annullato' WHERE user_id = $1 AND status <> 'pagato'`,
      [id]
    );
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function todayBookings(iso) {
  const { rows } = await getPool().query(
    `SELECT b.*, u.name AS user_name
     FROM bookings b
     LEFT JOIN users u ON u.id = b.user_id
     WHERE b.date = $1 AND b.status <> 'annullata'
     ORDER BY b.inserted_at`,
    [iso]
  );
  return rows.map((r) => ({
    deskId: r.desk_id,
    slot: r.slot,
    status: r.status,
    userId: Number(r.user_id),
    name: r.user_name || 'Ospite',
  }));
}

async function availability(from, to) {
  const { rows } = await getPool().query(
    `SELECT desk_id, date, slot, user_id
     FROM bookings
     WHERE status <> 'annullata' AND date >= $1 AND date <= $2
     ORDER BY date, desk_id, id`,
    [from, to]
  );
  return rows.map((r) => ({
    deskId: r.desk_id,
    date: r.date,
    slot: r.slot,
    userId: Number(r.user_id),
  }));
}

function clash(a, b) {
  return a === 'giornata' || b === 'giornata' || a === b;
}

async function createBookingSet({ userId, deskId, dates, slot, mode, payment, status, price }) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [deskId]);
    const existing = await client.query(
      `SELECT date, slot FROM bookings
       WHERE desk_id = $1 AND date = ANY($2::text[]) AND status <> 'annullata'
       ORDER BY inserted_at
       FOR UPDATE`,
      [deskId, dates]
    );
    const hit = existing.rows.find((r) => clash(r.slot, slot));
    if (hit) {
      await client.query('ROLLBACK');
      return { conflict: { date: hit.date, slot: hit.slot } };
    }
    const group = crypto.randomUUID().slice(0, 8);
    const created = new Date().toISOString();
    const dayPrice = mode === 'mensile' ? null : price;
    for (const date of dates) {
      const id = crypto.randomUUID().slice(0, 8);
      await client.query(
        `INSERT INTO bookings (id, grp, user_id, desk_id, date, slot, mode, payment, status, price, created)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, group, userId, deskId, date, slot, mode, payment, status, dayPrice, created]
      );
    }
    await client.query(
      `INSERT INTO payments (grp, user_id, desk_id, date_from, date_to, days, mode, slot, amount, method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'in attesa')`,
      [group, userId, deskId, dates[0], dates[dates.length - 1], dates.length, mode, slot, price, payment]
    );
    await client.query('COMMIT');
    return { group };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function paymentByGroup(group) {
  const { rows } = await getPool().query('SELECT * FROM payments WHERE grp = $1', [group]);
  return rows[0] ? mapPayment(rows[0]) : null;
}

async function markPaymentReported(group, userId) {
  const reported = new Date().toISOString();
  const { rowCount } = await getPool().query(
    `UPDATE payments SET status = 'segnalato dal cliente', reported = $3
     WHERE grp = $1 AND user_id = $2`,
    [group, userId, reported]
  );
  return rowCount > 0;
}

async function markPaymentPaid(group) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const paid = new Date().toISOString();
    const upd = await client.query(
      `UPDATE payments SET status = 'pagato', paid = $2 WHERE grp = $1`,
      [group, paid]
    );
    if (!upd.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE bookings SET status = 'confermata' WHERE grp = $1 AND status <> 'annullata'`,
      [group]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function listOpenPayments() {
  const { rows } = await getPool().query(`
    SELECT p.*, u.name AS user_name
    FROM payments p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.status <> 'pagato'
      AND p.desk_id <> ''
      AND EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.grp = p.grp AND b.status <> 'annullata'
      )
    ORDER BY p.inserted_at
  `);
  return rows.map((r) => {
    const p = mapPayment(r);
    if (r.user_name != null) p.user = r.user_name;
    return p;
  });
}

async function listBookingsForUser(userId) {
  const { rows } = await getPool().query(
    `SELECT * FROM bookings WHERE user_id = $1 ORDER BY date ASC, inserted_at ASC`,
    [userId]
  );
  return rows.map(mapBooking);
}

async function getBooking(id) {
  const { rows } = await getPool().query('SELECT * FROM bookings WHERE id = $1', [id]);
  return rows[0] ? mapBooking(rows[0]) : null;
}

async function cancelBooking(id) {
  const { rowCount } = await getPool().query(
    `UPDATE bookings SET status = 'annullata' WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

async function listBookingsAdmin() {
  const { rows } = await getPool().query(`
    SELECT b.*, u.name AS user_name
    FROM bookings b
    LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.date DESC, b.inserted_at DESC
  `);
  return rows.map((r) => {
    const b = mapBooking(r);
    if (r.user_name != null) b.user = r.user_name;
    return b;
  });
}

async function cancelDay(date) {
  const { rowCount } = await getPool().query(
    `UPDATE bookings SET status = 'annullata' WHERE date = $1 AND status <> 'annullata'`,
    [date]
  );
  return rowCount;
}

async function cancelMonth(month) {
  const { rowCount } = await getPool().query(
    `UPDATE bookings SET status = 'annullata'
     WHERE date LIKE $1 AND status <> 'annullata'`,
    [month + '%']
  );
  return rowCount;
}

module.exports = {
  init,
  ping,
  close,
  connectionOptions,
  userBySession,
  userByEmail,
  userById,
  createSession,
  deleteSession,
  createUser,
  updateUser,
  listUsers,
  deleteUser,
  todayBookings,
  availability,
  createBookingSet,
  paymentByGroup,
  markPaymentReported,
  markPaymentPaid,
  listOpenPayments,
  listBookingsForUser,
  getBooking,
  cancelBooking,
  listBookingsAdmin,
  cancelDay,
  cancelMonth,
};
