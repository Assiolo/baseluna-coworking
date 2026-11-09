const crypto = require('crypto');
const db = require('./db');
const logic = require('./lib/print-logic');
const files = require('./lib/print-files');

const { fail } = logic;

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS print_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bw_cents INTEGER NOT NULL DEFAULT 5,
      color_cents INTEGER NOT NULL DEFAULT 20,
      duplex_bw_cents INTEGER NOT NULL DEFAULT 4,
      duplex_color_cents INTEGER NOT NULL DEFAULT 15,
      max_upload_bytes INTEGER NOT NULL DEFAULT 20971520,
      max_copies INTEGER NOT NULL DEFAULT 20,
      max_pages INTEGER NOT NULL DEFAULT 200,
      monthly_page_quota INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`INSERT INTO print_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      protocol TEXT NOT NULL,
      uri TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      port INTEGER,
      queue TEXT NOT NULL DEFAULT '',
      supports_color BOOLEAN NOT NULL DEFAULT FALSE,
      supports_duplex BOOLEAN NOT NULL DEFAULT FALSE,
      formats TEXT NOT NULL DEFAULT 'A4',
      bw_cents INTEGER,
      color_cents INTEGER,
      duplex_bw_cents INTEGER,
      duplex_color_cents INTEGER,
      agent_id TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      visible BOOLEAN NOT NULL DEFAULT FALSE,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      last_heartbeat TIMESTAMPTZ,
      status_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS printers_agent_idx ON printers (agent_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS print_uploads (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      page_count INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS print_uploads_user_idx ON print_uploads (user_id, created_at)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
      filename TEXT NOT NULL,
      bytes BYTEA,
      page_count INTEGER NOT NULL,
      page_range TEXT NOT NULL DEFAULT '',
      pages_selected INTEGER NOT NULL,
      copies INTEGER NOT NULL,
      color BOOLEAN NOT NULL,
      duplex BOOLEAN NOT NULL,
      format TEXT NOT NULL DEFAULT 'A4',
      unit_cents INTEGER NOT NULL,
      pages_charged INTEGER NOT NULL,
      pages_printed INTEGER,
      cost_cents INTEGER NOT NULL,
      actual_cost_cents INTEGER,
      refunded_cents INTEGER NOT NULL DEFAULT 0,
      unbilled_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '',
      claimed_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS print_jobs_user_idx ON print_jobs (user_id, created_at DESC)');
  await client.query('CREATE INDEX IF NOT EXISTS print_jobs_status_idx ON print_jobs (status, created_at)');
  await client.query('CREATE INDEX IF NOT EXISTS print_jobs_printer_idx ON print_jobs (printer_id)');
  await client.query(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      kind TEXT NOT NULL,
      job_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      actor_id INTEGER,
      stripe_session_id TEXT,
      balance_after_cents INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC)');
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_stripe_idx
    ON credit_ledger (stripe_session_id)
    WHERE stripe_session_id IS NOT NULL
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS credit_checkouts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_cents INTEGER NOT NULL,
      stripe_session_id TEXT UNIQUE,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS print_user_quota (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      monthly_pages INTEGER NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function mapSettings(r) {
  return {
    bwCents: r.bw_cents,
    colorCents: r.color_cents,
    duplexBwCents: r.duplex_bw_cents,
    duplexColorCents: r.duplex_color_cents,
    maxUploadBytes: r.max_upload_bytes,
    maxCopies: r.max_copies,
    maxPages: r.max_pages,
    monthlyPageQuota: r.monthly_page_quota == null ? null : Number(r.monthly_page_quota),
  };
}

function mapPrinter(r) {
  if (!r) return null;
  const formats = String(r.formats || 'A4').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    id: r.id,
    name: r.name,
    location: r.location || '',
    protocol: r.protocol,
    uri: r.uri || '',
    host: r.host || '',
    port: r.port == null ? null : Number(r.port),
    queue: r.queue || '',
    supportsColor: !!r.supports_color,
    supportsDuplex: !!r.supports_duplex,
    formats,
    bwCents: num(r.bw_cents),
    colorCents: num(r.color_cents),
    duplexBwCents: num(r.duplex_bw_cents),
    duplexColorCents: num(r.duplex_color_cents),
    agentId: r.agent_id || '',
    enabled: !!r.enabled,
    visible: !!r.visible,
    isDefault: !!r.is_default,
    lastHeartbeat: r.last_heartbeat || null,
    status: r.status_json || {},
    createdAt: r.created_at,
  };
}

function presentPrinter(p, settings, { admin }) {
  const online = logic.isOnline(p.lastHeartbeat);
  const connection = logic.buildConnectionUri(p);
  const base = {
    id: p.id,
    name: p.name,
    location: p.location,
    protocol: p.protocol,
    supportsColor: p.supportsColor,
    supportsDuplex: p.supportsDuplex,
    formats: p.formats,
    enabled: p.enabled,
    visible: p.visible,
    isDefault: p.isDefault,
    online,
    lastHeartbeat: p.lastHeartbeat,
    connection,
    targetReady: logic.targetReady(p),
    prices: {
      bwCents: p.bwCents == null ? settings.bwCents : p.bwCents,
      colorCents: p.colorCents == null ? settings.colorCents : p.colorCents,
      duplexBwCents: p.duplexBwCents == null ? settings.duplexBwCents : p.duplexBwCents,
      duplexColorCents: p.duplexColorCents == null ? settings.duplexColorCents : p.duplexColorCents,
    },
  };
  if (!admin) return base;
  return {
    ...base,
    host: p.host,
    port: p.port,
    queue: p.queue,
    uri: p.uri,
    agentId: p.agentId,
    overrides: {
      bwCents: p.bwCents,
      colorCents: p.colorCents,
      duplexBwCents: p.duplexBwCents,
      duplexColorCents: p.duplexColorCents,
    },
    status: p.status || {},
  };
}

const JOB_COLS = `
  j.id, j.user_id, j.printer_id, j.filename, j.page_count, j.page_range, j.pages_selected,
  j.copies, j.color, j.duplex, j.format, j.unit_cents, j.pages_charged, j.pages_printed,
  j.cost_cents, j.actual_cost_cents, j.refunded_cents, j.unbilled_cents, j.status, j.error,
  j.claimed_by, j.created_at, j.updated_at, j.finished_at
`;

function mapJob(r, { admin }) {
  if (!r) return null;
  const job = {
    id: r.id,
    userId: Number(r.user_id),
    printerId: r.printer_id,
    printerName: r.printer_name || '',
    filename: r.filename,
    pageCount: r.page_count,
    pageRange: r.page_range || '',
    pagesSelected: r.pages_selected,
    copies: r.copies,
    color: !!r.color,
    duplex: !!r.duplex,
    format: r.format,
    unitCents: r.unit_cents,
    pagesCharged: r.pages_charged,
    pagesPrinted: r.pages_printed == null ? null : Number(r.pages_printed),
    costCents: r.cost_cents,
    actualCostCents: r.actual_cost_cents == null ? null : Number(r.actual_cost_cents),
    refundedCents: r.refunded_cents,
    unbilledCents: r.unbilled_cents,
    status: r.status,
    error: r.error || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
  if (admin) {
    job.userName = r.user_name || '';
    job.userEmail = r.user_email || '';
    job.claimedBy = r.claimed_by || '';
  }
  return job;
}

function mapLedger(r) {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    amountCents: r.amount_cents,
    kind: r.kind,
    jobId: r.job_id,
    note: r.note || '',
    balanceAfterCents: r.balance_after_cents,
    createdAt: r.created_at,
    userName: r.user_name || undefined,
  };
}

async function withTx(fn) {
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function lockUser(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [8000000000 + Number(userId)]);
}

async function settingsOf(client) {
  const runner = client || db.getPool();
  const { rows } = await runner.query('SELECT * FROM print_settings WHERE id = 1');
  if (!rows[0]) throw fail(500, 'Listino stampa mancante');
  return mapSettings(rows[0]);
}

async function balanceTx(client, userId) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM credit_ledger WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

async function addLedger(client, { userId, amountCents, kind, jobId, note, actorId, stripeSessionId }) {
  if (!amountCents) return null;
  const current = await balanceTx(client, userId);
  const next = current + amountCents;
  if (next < 0) throw fail(402, 'Credito insufficiente');
  const ins = await client.query(
    `INSERT INTO credit_ledger (user_id, amount_cents, kind, job_id, note, actor_id, stripe_session_id, balance_after_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, balance_after_cents`,
    [userId, amountCents, kind, jobId || null, (note || '').slice(0, 300), actorId || null, stripeSessionId || null, next]
  );
  return ins.rows[0];
}

async function netCharged(client, jobId) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(amount_cents), 0)::int AS n FROM credit_ledger WHERE job_id = $1',
    [jobId]
  );
  return -rows[0].n;
}

async function monthPages(client, userId) {
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(pages_charged), 0)::int AS n
     FROM print_jobs
     WHERE user_id = $1
       AND status IN ('in coda', 'in stampa', 'completata')
       AND (created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')`,
    [userId]
  );
  return rows[0].n;
}

async function quotaLimit(client, userId) {
  const q = await client.query('SELECT monthly_pages FROM print_user_quota WHERE user_id = $1', [userId]);
  if (q.rowCount) {
    const n = Number(q.rows[0].monthly_pages);
    return n < 0 ? null : n;
  }
  const settings = await settingsOf(client);
  return settings.monthlyPageQuota;
}

async function getSettings() {
  return settingsOf(null);
}

async function updateSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (!Number.isInteger(next.bwCents) || next.bwCents < 0) throw fail(400, 'Prezzo B/N non valido');
  if (!Number.isInteger(next.colorCents) || next.colorCents < 0) throw fail(400, 'Prezzo colore non valido');
  if (!Number.isInteger(next.duplexBwCents) || next.duplexBwCents < 0) throw fail(400, 'Prezzo fronte/retro B/N non valido');
  if (!Number.isInteger(next.duplexColorCents) || next.duplexColorCents < 0) throw fail(400, 'Prezzo fronte/retro colore non valido');
  if (!Number.isInteger(next.maxUploadBytes) || next.maxUploadBytes < 100000 || next.maxUploadBytes > 26 * 1024 * 1024) {
    throw fail(400, 'Dimensione massima file: tra 0,1 e 25 MB');
  }
  if (!Number.isInteger(next.maxCopies) || next.maxCopies < 1 || next.maxCopies > 100) throw fail(400, 'Copie massime non valide');
  if (!Number.isInteger(next.maxPages) || next.maxPages < 1 || next.maxPages > 2000) throw fail(400, 'Pagine massime non valide');
  if (next.monthlyPageQuota != null && (!Number.isInteger(next.monthlyPageQuota) || next.monthlyPageQuota < 0 || next.monthlyPageQuota > 100000)) {
    throw fail(400, 'Quota mensile non valida');
  }
  await db.getPool().query(
    `UPDATE print_settings SET
      bw_cents=$1, color_cents=$2, duplex_bw_cents=$3, duplex_color_cents=$4,
      max_upload_bytes=$5, max_copies=$6, max_pages=$7, monthly_page_quota=$8, updated_at=NOW()
     WHERE id = 1`,
    [next.bwCents, next.colorCents, next.duplexBwCents, next.duplexColorCents, next.maxUploadBytes, next.maxCopies, next.maxPages, next.monthlyPageQuota]
  );
  return getSettings();
}

async function listPrinters() {
  const { rows } = await db.getPool().query('SELECT * FROM printers ORDER BY name, created_at');
  return rows.map(mapPrinter);
}

async function getPrinter(id) {
  const { rows } = await db.getPool().query('SELECT * FROM printers WHERE id = $1', [id]);
  return mapPrinter(rows[0]);
}

async function createPrinter(input) {
  const row = logic.validatePrinter(input);
  const id = crypto.randomUUID();
  await withTx(async (client) => {
    if (row.is_default) await client.query('UPDATE printers SET is_default = FALSE WHERE is_default');
    await client.query(
      `INSERT INTO printers (
        id, name, location, protocol, uri, host, port, queue, supports_color, supports_duplex, formats,
        bw_cents, color_cents, duplex_bw_cents, duplex_color_cents, agent_id, enabled, visible, is_default
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, row.name, row.location, row.protocol, row.uri, row.host, row.port, row.queue, row.supports_color, row.supports_duplex, row.formats,
        row.bw_cents, row.color_cents, row.duplex_bw_cents, row.duplex_color_cents, row.agent_id, row.enabled, row.visible, row.is_default]
    );
  });
  return getPrinter(id);
}

async function updatePrinter(id, input) {
  const existing = await getPrinter(id);
  if (!existing) throw fail(404, 'Stampante non trovata');
  const merged = {
    name: input.name != null ? input.name : existing.name,
    location: input.location != null ? input.location : existing.location,
    protocol: input.protocol != null ? input.protocol : existing.protocol,
    host: input.host != null ? input.host : existing.host,
    port: input.port !== undefined ? input.port : existing.port,
    uri: input.uri != null ? input.uri : existing.uri,
    queue: input.queue != null ? input.queue : existing.queue,
    supportsColor: input.supportsColor != null ? input.supportsColor : existing.supportsColor,
    supportsDuplex: input.supportsDuplex != null ? input.supportsDuplex : existing.supportsDuplex,
    formats: input.formats != null ? input.formats : existing.formats,
    agentId: input.agentId != null ? input.agentId : existing.agentId,
    enabled: input.enabled != null ? input.enabled : existing.enabled,
    visible: input.visible != null ? input.visible : existing.visible,
    isDefault: input.isDefault != null ? input.isDefault : existing.isDefault,
    priceBw: input.priceBw !== undefined ? input.priceBw : (existing.bwCents == null ? '' : existing.bwCents / 100),
    priceColor: input.priceColor !== undefined ? input.priceColor : (existing.colorCents == null ? '' : existing.colorCents / 100),
    priceDuplexBw: input.priceDuplexBw !== undefined ? input.priceDuplexBw : (existing.duplexBwCents == null ? '' : existing.duplexBwCents / 100),
    priceDuplexColor: input.priceDuplexColor !== undefined ? input.priceDuplexColor : (existing.duplexColorCents == null ? '' : existing.duplexColorCents / 100),
  };
  const row = logic.validatePrinter(merged);
  await withTx(async (client) => {
    if (row.is_default) await client.query('UPDATE printers SET is_default = FALSE WHERE id <> $1', [id]);
    const upd = await client.query(
      `UPDATE printers SET
        name=$2, location=$3, protocol=$4, uri=$5, host=$6, port=$7, queue=$8,
        supports_color=$9, supports_duplex=$10, formats=$11,
        bw_cents=$12, color_cents=$13, duplex_bw_cents=$14, duplex_color_cents=$15,
        agent_id=$16, enabled=$17, visible=$18, is_default=$19, updated_at=NOW()
       WHERE id=$1`,
      [id, row.name, row.location, row.protocol, row.uri, row.host, row.port, row.queue, row.supports_color, row.supports_duplex, row.formats,
        row.bw_cents, row.color_cents, row.duplex_bw_cents, row.duplex_color_cents, row.agent_id, row.enabled, row.visible, row.is_default]
    );
    if (!upd.rowCount) throw fail(404, 'Stampante non trovata');
  });
  return getPrinter(id);
}

async function deletePrinter(id) {
  const { rowCount } = await db.getPool().query('DELETE FROM printers WHERE id = $1', [id]);
  if (!rowCount) throw fail(404, 'Stampante non trovata');
  return { ok: true };
}

async function createUpload({ userId, filename, bytes }) {
  const settings = await getSettings();
  if (!bytes || !bytes.length) throw fail(400, 'File vuoto');
  if (bytes.length > settings.maxUploadBytes) {
    throw fail(400, 'File troppo grande (max ' + Math.round(settings.maxUploadBytes / (1024 * 1024)) + ' MB)');
  }
  const normalized = await files.normalizeToPdf(bytes, filename);
  if (normalized.pageCount < 1) throw fail(400, 'Documento senza pagine');
  if (normalized.pageCount > settings.maxPages) {
    throw fail(400, 'Il documento ha troppe pagine (massimo ' + settings.maxPages + ')');
  }
  const id = crypto.randomUUID();
  const safe = logic.safeFilename(filename);
  await db.getPool().query(
    `DELETE FROM print_uploads WHERE created_at < NOW() - INTERVAL '24 hours'
     OR (user_id = $1 AND created_at < NOW() - INTERVAL '6 hours')`,
    [userId]
  );
  await db.getPool().query(
    `INSERT INTO print_uploads (id, user_id, filename, bytes, page_count) VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, safe, normalized.bytes, normalized.pageCount]
  );
  return { id, filename: safe, pageCount: normalized.pageCount };
}

async function uploadForUser(id, userId, { withBytes }) {
  const cols = withBytes ? '*' : 'id, user_id, filename, page_count, created_at';
  const { rows } = await db.getPool().query(
    `SELECT ${cols} FROM print_uploads WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  return rows[0] || null;
}

function printerForQuote(p) {
  return p;
}

async function quoteJob({ userId, uploadId, printerId, copies, color, duplex, format, pageRange }) {
  const upload = await uploadForUser(uploadId, userId, { withBytes: false });
  if (!upload) throw fail(404, 'File non trovato o scaduto. Ricaricalo.');
  const settings = await getSettings();
  const printer = await getPrinter(printerId);
  if (!logic.memberCanUse(printer)) throw fail(400, 'Stampante non disponibile');
  const opt = logic.validateOptions({
    copies, color, duplex, format, pageRange, pageCount: upload.page_count, printer, settings,
  });
  const balance = await db.getPool().query(
    'SELECT COALESCE(SUM(amount_cents),0)::int AS n FROM credit_ledger WHERE user_id = $1',
    [userId]
  );
  const balanceCents = balance.rows[0].n;
  const limit = await quotaLimit(db.getPool(), userId);
  const used = await monthPages(db.getPool(), userId);
  return {
    filename: upload.filename,
    pageCount: upload.page_count,
    pagesSelected: opt.pages.length,
    copies: opt.copies,
    color: opt.color,
    duplex: opt.duplex,
    format: opt.format,
    unitCents: opt.unitCents,
    impressions: opt.impressions,
    costCents: opt.costCents,
    balanceCents,
    enough: balanceCents >= opt.costCents,
    quota: { limit, used, remaining: limit == null ? null : Math.max(0, limit - used) },
  };
}

async function submitJob({ userId, uploadId, printerId, copies, color, duplex, format, pageRange }) {
  return withTx(async (client) => {
    await lockUser(client, userId);
    const up = await client.query(
      'SELECT * FROM print_uploads WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [uploadId, userId]
    );
    if (!up.rowCount) throw fail(404, 'File non trovato o scaduto. Ricaricalo.');
    const upload = up.rows[0];
    const settings = await settingsOf(client);
    const pr = await client.query('SELECT * FROM printers WHERE id = $1 FOR UPDATE', [printerId]);
    const printer = mapPrinter(pr.rows[0]);
    if (!logic.memberCanUse(printer)) throw fail(400, 'Stampante non disponibile');
    const opt = logic.validateOptions({
      copies, color, duplex, format, pageRange,
      pageCount: upload.page_count,
      printer,
      settings,
    });
    const limit = await quotaLimit(client, userId);
    if (limit != null) {
      const used = await monthPages(client, userId);
      if (used + opt.impressions > limit) {
        throw fail(400, 'Hai raggiunto il tetto di pagine di questo mese (' + limit + ').');
      }
    }
    const balance = await balanceTx(client, userId);
    if (balance < opt.costCents) {
      const missing = ((opt.costCents - balance) / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
      throw fail(402, 'Credito insufficiente: mancano ' + missing + '.');
    }
    let pdf;
    try {
      pdf = await files.slicePdf(upload.bytes, opt.pages);
    } catch (err) {
      if (err.expose) throw err;
      throw fail(400, 'PDF non leggibile');
    }
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO print_jobs (
        id, user_id, printer_id, filename, bytes, page_count, page_range, pages_selected, copies,
        color, duplex, format, unit_cents, pages_charged, cost_cents, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'in coda')`,
      [id, userId, printer.id, upload.filename, pdf, upload.page_count, opt.pageRange, opt.pages.length, opt.copies,
        opt.color, opt.duplex, opt.format, opt.unitCents, opt.impressions, opt.costCents]
    );
    if (opt.costCents > 0) {
      await addLedger(client, {
        userId,
        amountCents: -opt.costCents,
        kind: 'addebito',
        jobId: id,
        note: 'Stampa ' + upload.filename,
      });
    }
    await client.query('DELETE FROM print_uploads WHERE id = $1', [upload.id]);
    const job = await jobById(client, id, { admin: false });
    const balanceCents = await balanceTx(client, userId);
    return { job, balanceCents };
  });
}

async function jobById(client, id, { admin, withBytes }) {
  const runner = client || db.getPool();
  const cols = (withBytes ? JOB_COLS + ', j.bytes' : JOB_COLS);
  const { rows } = await runner.query(
    `SELECT ${cols}, p.name AS printer_name, u.name AS user_name, u.email AS user_email
     FROM print_jobs j
     LEFT JOIN printers p ON p.id = j.printer_id
     LEFT JOIN users u ON u.id = j.user_id
     WHERE j.id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;
  const job = mapJob(row, { admin });
  if (withBytes) job.bytes = row.bytes;
  return job;
}

async function listJobs(filter) {
  const where = [];
  const vals = [];
  const add = (sql, val) => {
    vals.push(val);
    where.push(sql.replace('?', '$' + vals.length));
  };
  if (filter.userId) add('j.user_id = ?', filter.userId);
  if (filter.status) add('j.status = ?', filter.status);
  if (filter.printerId) add('j.printer_id = ?', filter.printerId);
  if (filter.from) add(`(j.created_at AT TIME ZONE 'Europe/Rome')::date >= ?::date`, filter.from);
  if (filter.to) add(`(j.created_at AT TIME ZONE 'Europe/Rome')::date <= ?::date`, filter.to);
  const limit = Math.min(Math.max(filter.limit || 200, 1), 500);
  vals.push(limit);
  const sql = `
    SELECT ${JOB_COLS}, p.name AS printer_name, u.name AS user_name, u.email AS user_email
    FROM print_jobs j
    LEFT JOIN printers p ON p.id = j.printer_id
    LEFT JOIN users u ON u.id = j.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY j.created_at DESC
    LIMIT $${vals.length}`;
  const { rows } = await db.getPool().query(sql, vals);
  return rows.map((r) => mapJob(r, { admin: !!filter.admin }));
}

async function ledgerFor(userId, limit) {
  const { rows } = await db.getPool().query(
    `SELECT l.*, u.name AS user_name
     FROM credit_ledger l
     LEFT JOIN users u ON u.id = l.user_id
     WHERE ($1::int IS NULL OR l.user_id = $1)
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $2`,
    [userId || null, Math.min(limit || 50, 200)]
  );
  return rows.map(mapLedger);
}

async function balanceOf(userId) {
  const { rows } = await db.getPool().query(
    'SELECT COALESCE(SUM(amount_cents),0)::int AS n FROM credit_ledger WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}

async function quotaView(userId) {
  const client = db.getPool();
  const limit = await quotaLimit(client, userId);
  const used = await monthPages(client, userId);
  return { limit, used, remaining: limit == null ? null : Math.max(0, limit - used) };
}

async function refundJob(client, job, { note, actorId, nextStatus, errorText }) {
  const net = await netCharged(client, job.id);
  if (net > 0) {
    await addLedger(client, {
      userId: job.userId,
      amountCents: net,
      kind: 'rimborso',
      jobId: job.id,
      note,
      actorId,
    });
  }
  const refunded = (job.refundedCents || 0) + Math.max(net, 0);
  await client.query(
    `UPDATE print_jobs
     SET status = $2, error = $3, refunded_cents = $4, actual_cost_cents = 0,
         updated_at = NOW(), finished_at = COALESCE(finished_at, NOW())
     WHERE id = $1`,
    [job.id, nextStatus, (errorText || '').slice(0, 500), refunded]
  );
}

async function cancelJob(id, userId) {
  return withTx(async (client) => {
    await lockUser(client, userId);
    await client.query('SELECT id FROM print_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
    const job = await jobById(client, id, { admin: false });
    if (!job || job.userId !== userId) throw fail(404, 'Lavoro non trovato');
    if (job.status === 'rimborsata') return jobById(client, id, { admin: false });
    if (job.status !== 'in coda') {
      throw fail(409, 'La stampa è già partita: chiedi allo staff un rimborso se serve.');
    }
    await refundJob(client, job, {
      note: 'Annullata prima della stampa',
      nextStatus: 'rimborsata',
      errorText: 'Annullata dal membro',
    });
    return jobById(client, id, { admin: false });
  });
}

async function adminRefund(id, actorId, note) {
  return withTx(async (client) => {
    const peek = await client.query('SELECT user_id FROM print_jobs WHERE id = $1', [id]);
    if (!peek.rowCount) throw fail(404, 'Lavoro non trovato');
    const userId = Number(peek.rows[0].user_id);
    await lockUser(client, userId);
    await client.query('SELECT id FROM print_jobs WHERE id = $1 FOR UPDATE', [id]);
    const job = await jobById(client, id, { admin: true });
    if (job.status === 'rimborsata') throw fail(409, 'Lavoro già rimborsato');
    const net = await netCharged(client, job.id);
    if (net <= 0 && job.costCents <= 0) throw fail(409, 'Niente da rimborsare');
    await refundJob(client, job, {
      note: (note || 'Rimborso da banco').slice(0, 300),
      actorId,
      nextStatus: 'rimborsata',
      errorText: job.error || 'Rimborso da banco',
    });
    return jobById(client, id, { admin: true });
  });
}

async function topup({ userId, amountCents, note, actorId }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100000) {
    throw fail(400, 'Importo ricarica non valido');
  }
  const user = await db.userById(userId);
  if (!user) throw fail(404, 'Utente non trovato');
  return withTx(async (client) => {
    await lockUser(client, userId);
    await addLedger(client, {
      userId,
      amountCents,
      kind: 'ricarica',
      note: note || 'Ricarica da banco',
      actorId,
    });
    return { balanceCents: await balanceTx(client, userId) };
  });
}

async function openCheckout({ id, userId, amountCents, stripeSessionId }) {
  const checkoutId = id || crypto.randomUUID();
  await db.getPool().query(
    `INSERT INTO credit_checkouts (id, user_id, amount_cents, stripe_session_id, status)
     VALUES ($1,$2,$3,$4,'pending')`,
    [checkoutId, userId, amountCents, stripeSessionId]
  );
  return checkoutId;
}

async function applyStripeCredit({ sessionId, checkoutId, userId, amountCents }) {
  return withTx(async (client) => {
    const existing = await client.query(
      'SELECT id FROM credit_ledger WHERE stripe_session_id = $1',
      [sessionId]
    );
    if (existing.rowCount) return { duplicate: true };
    const checkout = await client.query(
      'SELECT * FROM credit_checkouts WHERE stripe_session_id = $1 FOR UPDATE',
      [sessionId]
    );
    const row = checkout.rows[0];
    if (!row) throw fail(400, 'Sessione di ricarica sconosciuta');
    if (Number(row.user_id) !== Number(userId) || Number(row.amount_cents) !== Number(amountCents)) {
      throw fail(400, 'Importo ricarica non coerente');
    }
    if (checkoutId && row.id !== checkoutId) throw fail(400, 'Sessione di ricarica non coerente');
    await lockUser(client, row.user_id);
    if (row.status === 'paid') return { duplicate: true };
    try {
      await addLedger(client, {
        userId: Number(row.user_id),
        amountCents: Number(row.amount_cents),
        kind: 'ricarica',
        note: 'Ricarica online',
        stripeSessionId: sessionId,
      });
    } catch (err) {
      if (err.code === '23505') return { duplicate: true };
      throw err;
    }
    await client.query(`UPDATE credit_checkouts SET status = 'paid' WHERE id = $1`, [row.id]);
    return { ok: true, balanceCents: await balanceTx(client, row.user_id) };
  });
}

async function setUserQuota(userId, { mode, pages, note }) {
  const user = await db.userById(userId);
  if (!user) throw fail(404, 'Utente non trovato');
  if (mode === 'inherit') {
    await db.getPool().query('DELETE FROM print_user_quota WHERE user_id = $1', [userId]);
    return { mode: 'inherit' };
  }
  let monthly = -1;
  if (mode === 'cap') {
    monthly = Number(pages);
    if (!Number.isInteger(monthly) || monthly < 0 || monthly > 100000) throw fail(400, 'Quota non valida');
  } else if (mode !== 'unlimited') {
    throw fail(400, 'Quota non valida');
  }
  await db.getPool().query(
    `INSERT INTO print_user_quota (user_id, monthly_pages, note, updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (user_id) DO UPDATE SET monthly_pages = EXCLUDED.monthly_pages, note = EXCLUDED.note, updated_at = NOW()`,
    [userId, monthly, String(note || '').slice(0, 200)]
  );
  return { mode, pages: monthly };
}

async function listQuotas() {
  const { rows } = await db.getPool().query(
    `SELECT q.user_id, q.monthly_pages, q.note, u.name, u.email
     FROM print_user_quota q
     JOIN users u ON u.id = q.user_id
     ORDER BY u.name`
  );
  return rows.map((r) => ({
    userId: Number(r.user_id),
    name: r.name,
    email: r.email,
    monthlyPages: Number(r.monthly_pages),
    unlimited: Number(r.monthly_pages) < 0,
    note: r.note || '',
  }));
}

async function accounts() {
  const { rows } = await db.getPool().query(`
    SELECT u.id, u.name, u.email, u.role,
      COALESCE((SELECT SUM(amount_cents) FROM credit_ledger l WHERE l.user_id = u.id), 0)::int AS balance
    FROM users u
    ORDER BY u.name
  `);
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    email: r.email,
    role: r.role,
    balanceCents: r.balance,
  }));
}

function romeDay(offset) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  const d = Number(parts.find((p) => p.type === 'day').value);
  const utc = Date.UTC(y, m - 1, d);
  const dt = new Date(utc + offset * 86400000);
  return dt.toISOString().slice(0, 10);
}

async function stats() {
  const month = await db.getPool().query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completata')::int AS jobs,
      COALESCE(SUM(pages_printed) FILTER (WHERE status = 'completata'), 0)::int AS pages,
      COALESCE(SUM(actual_cost_cents) FILTER (WHERE status = 'completata'), 0)::int AS cost
    FROM print_jobs
    WHERE (created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')
  `);
  const refunds = await db.getPool().query(`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS n
    FROM credit_ledger
    WHERE kind = 'rimborso'
      AND (created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')
  `);
  const all = await db.getPool().query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completata')::int AS jobs,
      COALESCE(SUM(pages_printed) FILTER (WHERE status = 'completata'), 0)::int AS pages,
      COALESCE(SUM(cost_cents) FILTER (WHERE status <> 'rimborsata'), 0)::int AS reserved,
      COALESCE(SUM(actual_cost_cents) FILTER (WHERE status = 'completata'), 0)::int AS cost
    FROM print_jobs
  `);
  const seriesRows = await db.getPool().query(`
    SELECT to_char((created_at AT TIME ZONE 'Europe/Rome')::date, 'YYYY-MM-DD') AS d,
      COUNT(*) FILTER (WHERE status = 'completata')::int AS jobs,
      COALESCE(SUM(pages_printed) FILTER (WHERE status = 'completata'), 0)::int AS pages,
      COALESCE(SUM(actual_cost_cents) FILTER (WHERE status = 'completata'), 0)::int AS cost
    FROM print_jobs
    WHERE created_at >= NOW() - INTERVAL '32 days'
    GROUP BY 1
  `);
  const byDay = new Map(seriesRows.rows.map((r) => [r.d, r]));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = romeDay(-i);
    const row = byDay.get(d);
    series.push({
      date: d,
      jobs: row ? row.jobs : 0,
      pages: row ? row.pages : 0,
      costCents: row ? row.cost : 0,
    });
  }
  const byUser = await db.getPool().query(`
    SELECT u.id, u.name, u.email,
      COALESCE(SUM(j.pages_printed) FILTER (
        WHERE j.status = 'completata'
          AND (j.created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')
      ), 0)::int AS pages,
      COALESCE(SUM(j.actual_cost_cents) FILTER (
        WHERE j.status = 'completata'
          AND (j.created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')
      ), 0)::int AS cost,
      COUNT(*) FILTER (
        WHERE j.status = 'completata'
          AND (j.created_at AT TIME ZONE 'Europe/Rome') >= date_trunc('month', NOW() AT TIME ZONE 'Europe/Rome')
      )::int AS jobs
    FROM users u
    LEFT JOIN print_jobs j ON j.user_id = u.id
    GROUP BY u.id
    HAVING COUNT(j.id) > 0
    ORDER BY pages DESC, u.name
  `);
  return {
    month: {
      jobs: month.rows[0].jobs,
      pages: month.rows[0].pages,
      costCents: month.rows[0].cost,
      refundedCents: refunds.rows[0].n,
    },
    all: {
      jobs: all.rows[0].jobs,
      pages: all.rows[0].pages,
      costCents: all.rows[0].cost,
    },
    series,
    byUser: byUser.rows.map((r) => ({
      userId: Number(r.id),
      name: r.name,
      email: r.email,
      pages: r.pages,
      costCents: r.cost,
      jobs: r.jobs,
    })),
  };
}

async function pullJobs(agentId) {
  const { rows } = await db.getPool().query(
    `SELECT ${JOB_COLS}, p.name AS printer_name
     FROM print_jobs j
     JOIN printers p ON p.id = j.printer_id
     WHERE j.status = 'in coda' AND p.enabled = TRUE AND p.agent_id = $1
     ORDER BY j.created_at
     LIMIT 5`,
    [agentId]
  );
  return rows.map((r) => mapJob(r, { admin: false }));
}

async function claimJob(id, agentId) {
  const { rows } = await db.getPool().query(
    `UPDATE print_jobs j
     SET status = 'in stampa', claimed_by = $2, updated_at = NOW()
     FROM printers p
     WHERE j.id = $1 AND j.printer_id = p.id AND j.status = 'in coda'
       AND p.enabled = TRUE AND p.agent_id = $2
     RETURNING j.id`,
    [id, agentId]
  );
  if (!rows.length) throw fail(409, 'Lavoro non più in coda');
  return jobById(null, id, { admin: false });
}

async function jobFileForAgent(id, agentId) {
  const { rows } = await db.getPool().query(
    `SELECT j.bytes, j.filename, j.status, j.claimed_by
     FROM print_jobs j
     JOIN printers p ON p.id = j.printer_id
     WHERE j.id = $1 AND p.agent_id = $2
       AND (j.status = 'in coda' OR (j.status = 'in stampa' AND j.claimed_by = $2))`,
    [id, agentId]
  );
  if (!rows[0] || !rows[0].bytes) throw fail(404, 'File non disponibile');
  return { bytes: rows[0].bytes, filename: rows[0].filename };
}

async function applyAgentResult({ id, agentId, status, pagesPrinted, error }) {
  return withTx(async (client) => {
    const peek = await client.query(
      `SELECT j.user_id, j.claimed_by, p.agent_id
       FROM print_jobs j
       LEFT JOIN printers p ON p.id = j.printer_id
       WHERE j.id = $1`,
      [id]
    );
    if (!peek.rowCount) throw fail(404, 'Lavoro non trovato');
    if (peek.rows[0].claimed_by !== agentId && peek.rows[0].agent_id !== agentId) {
      throw fail(403, 'Lavoro di un altro agente');
    }
    const userId = Number(peek.rows[0].user_id);
    await lockUser(client, userId);
    await client.query('SELECT id FROM print_jobs WHERE id = $1 FOR UPDATE', [id]);
    const job = await jobById(client, id, { admin: false });
    if (job.status === 'completata' || job.status === 'rimborsata') return job;
    if (status === 'in stampa') {
      await client.query(
        `UPDATE print_jobs SET status = 'in stampa', claimed_by = $2, updated_at = NOW() WHERE id = $1`,
        [id, agentId]
      );
      return jobById(client, id, { admin: false });
    }
    if (status === 'errore') {
      await refundJob(client, job, {
        note: 'Stampa non riuscita',
        nextStatus: 'rimborsata',
        errorText: error || 'Errore di stampa',
      });
      return jobById(client, id, { admin: false });
    }
    if (status !== 'completata') throw fail(400, 'Stato non valido');
    let printed = pagesPrinted == null ? job.pagesCharged : Number(pagesPrinted);
    if (!Number.isInteger(printed) || printed < 0 || printed > 100000) throw fail(400, 'Pagine stampate non valide');
    if (printed === 0) {
      await refundJob(client, job, {
        note: 'Nessuna pagina stampata',
        nextStatus: 'rimborsata',
        errorText: 'Nessuna pagina stampata',
      });
      return jobById(client, id, { admin: false });
    }
    const actual = job.unitCents * printed;
    let unbilled = 0;
    if (actual < job.costCents) {
      const give = job.costCents - actual;
      if (give > 0) {
        await addLedger(client, {
          userId,
          amountCents: give,
          kind: 'rimborso',
          jobId: id,
          note: 'Pagine non stampate',
        });
      }
    } else if (actual > job.costCents) {
      const extra = actual - job.costCents;
      const bal = await balanceTx(client, userId);
      const debit = Math.min(extra, Math.max(bal, 0));
      if (debit > 0) {
        await addLedger(client, {
          userId,
          amountCents: -debit,
          kind: 'addebito',
          jobId: id,
          note: 'Pagine in più',
        });
      }
      unbilled = extra - debit;
    }
    const net = await netCharged(client, id);
    const refunded = Math.max(0, job.costCents - net);
    await client.query(
      `UPDATE print_jobs SET
        status = 'completata', pages_printed = $2, actual_cost_cents = $3,
        refunded_cents = $4, unbilled_cents = $5, error = '',
        updated_at = NOW(), finished_at = NOW()
       WHERE id = $1`,
      [id, printed, net, refunded, unbilled]
    );
    return jobById(client, id, { admin: false });
  });
}

async function heartbeat(agentId, reports) {
  await db.getPool().query(
    `UPDATE printers SET last_heartbeat = NOW(), updated_at = NOW()
     WHERE agent_id = $1 AND enabled = TRUE`,
    [agentId]
  );
  const list = Array.isArray(reports) ? reports.slice(0, 30) : [];
  for (const report of list) {
    if (!report || typeof report.id !== 'string') continue;
    const payload = {
      state: String(report.state || 'unknown').slice(0, 40),
      message: String(report.message || '').slice(0, 300),
      backend: String(report.backend || '').slice(0, 40),
      supplies: Array.isArray(report.supplies) ? report.supplies.slice(0, 12).map((s) => ({
        name: String((s && s.name) || '').slice(0, 80),
        level: s && s.level != null && Number.isFinite(Number(s.level)) ? Math.max(0, Math.min(100, Math.round(Number(s.level)))) : null,
      })) : [],
    };
    await db.getPool().query(
      `UPDATE printers SET status_json = $2::jsonb, last_heartbeat = NOW(), updated_at = NOW()
       WHERE id = $1 AND agent_id = $3`,
      [report.id, JSON.stringify(payload), agentId]
    );
  }
  const { rows } = await db.getPool().query('SELECT * FROM printers WHERE agent_id = $1 ORDER BY name', [agentId]);
  return rows.map(mapPrinter);
}

async function printersForAgent(agentId) {
  const { rows } = await db.getPool().query(
    'SELECT * FROM printers WHERE agent_id = $1 ORDER BY name',
    [agentId]
  );
  return rows.map(mapPrinter);
}

module.exports = {
  ensureSchema,
  getSettings,
  updateSettings,
  listPrinters,
  getPrinter,
  createPrinter,
  updatePrinter,
  deletePrinter,
  presentPrinter,
  createUpload,
  uploadForUser,
  quoteJob,
  submitJob,
  listJobs,
  jobById,
  ledgerFor,
  balanceOf,
  quotaView,
  cancelJob,
  adminRefund,
  topup,
  openCheckout,
  applyStripeCredit,
  setUserQuota,
  listQuotas,
  accounts,
  stats,
  pullJobs,
  claimJob,
  jobFileForAgent,
  applyAgentResult,
  heartbeat,
  printersForAgent,
  printerForQuote,
};
