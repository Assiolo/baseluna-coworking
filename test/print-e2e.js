const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');
const { Client } = require('pg');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const dbFile = path.join(root, 'data', 'db.json');

function cookieHeader(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const sid = list.find((c) => c.startsWith('sid='));
  assert.ok(sid, 'missing sid cookie');
  return sid.split(';')[0];
}

async function api(base, urlPath, { method = 'GET', body, cookie, raw, headers } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(raw ? {} : body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
      ...(cookie ? { cookie } : {}),
    },
    body: raw || (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res, text };
}

async function pdfBytes(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Pagina ' + (i + 1), { x: 72, y: 760, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

async function resetSchema(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();
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
    } catch (err) { last = err.message; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('health timeout: ' + last + '\n' + child.log());
}

function pdfFromSmtp(raw) {
  const text = raw.split('\r\n').map((line) => (line.startsWith('.') ? line.slice(1) : line)).join('\r\n');
  const marker = 'Content-Transfer-Encoding: base64\r\n\r\n';
  const at = text.indexOf(marker);
  assert.ok(at > 0, 'allegato PDF assente');
  const b64 = text.slice(at + marker.length).split('\r\n--')[0].replace(/\r\n/g, '');
  return Buffer.from(b64, 'base64');
}

function startSmtp() {
  const state = { messages: [], rejectNext: false };
  const server = net.createServer((socket) => {
    let buf = '';
    let collecting = false;
    let data = '';
    const reply = (line) => socket.write(line + '\r\n');
    reply('220 test ready');
    socket.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      if (collecting) {
        data += text;
        const end = data.indexOf('\r\n.\r\n');
        if (end >= 0) {
          state.messages.push(data.slice(0, end));
          data = '';
          collecting = false;
          if (state.rejectNext) {
            state.rejectNext = false;
            reply('550 rejected');
          } else reply('250 queued');
        }
        return;
      }
      buf += text;
      while (!collecting && buf.includes('\r\n')) {
        const i = buf.indexOf('\r\n');
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test\r\n250 OK\r\n');
        else if (cmd === 'DATA') {
          collecting = true;
          data = buf;
          buf = '';
          reply('354 send');
        } else if (cmd.startsWith('QUIT')) {
          reply('221 bye');
          socket.end();
        } else reply('250 OK');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.port = server.address().port;
      resolve(state);
    });
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 4000);
  });
}

async function upload(base, cookie, buf, name, type) {
  return api(base, '/api/print/uploads', {
    method: 'POST',
    cookie,
    raw: buf,
    headers: { 'content-type': type, 'x-filename': encodeURIComponent(name) },
  });
}

async function balanceOf(connectionString, email) {
  const client = new Client({ connectionString });
  await client.connect();
  const { rows } = await client.query(
    `SELECT COALESCE(SUM(l.amount_cents),0)::int AS n
     FROM users u LEFT JOIN credit_ledger l ON l.user_id = u.id
     WHERE u.email = $1 GROUP BY u.id`,
    [email]
  );
  await client.end();
  return rows[0] ? rows[0].n : null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !/@(localhost|127\.0\.0\.1)/.test(url)) {
    console.log('skip print e2e: set DATABASE_URL to a local Postgres');
    return;
  }
  const port = 4174;
  const base = 'http://127.0.0.1:' + port;
  const token = 'agent-token-di-prova-32byte!!';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-print-e2e-'));
  const dbBackup = fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : null;
  if (dbBackup) fs.unlinkSync(dbFile);
  await resetSchema(url);
  const smtp = await startSmtp();
  const child = spawnServer(port, {
    PRINT_AGENT_TOKEN: token,
    PRINT_STRIPE_ENABLED: '',
    PRINT_CLOUD_ENABLED: '1',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtp.port),
    SMTP_SECURE: 'plain',
    SMTP_FROM: 'Base Luna <stampa@studio.test>',
  });
  try {
    await waitHealth(base, child);
    assert.match(child.log(), /Stampa: agente attivo/);
    assert.match(child.log(), /ricarica Stripe disattivata/);
    assert.match(child.log(), /cloud email attiva \(smtp\)/);

    const anon = await api(base, '/api/print/me');
    assert.strictEqual(anon.status, 401);
    const noToken = await api(base, '/api/agent/config?agentId=studio-1');
    assert.strictEqual(noToken.status, 401);

    const admin = await api(base, '/api/register', { method: 'POST', body: { name: 'Ada Admin', email: 'ada-print@example.invalid', password: 'secret1' } });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.json));
    assert.strictEqual(admin.json.role, 'admin');
    const adminCookie = cookieHeader(admin.res);
    const member = await api(base, '/api/register', { method: 'POST', body: { name: 'Lia Luna', email: 'lia-print@example.invalid', password: 'secret2' } });
    assert.strictEqual(member.json.role, 'user');
    const memberCookie = cookieHeader(member.res);
    const other = await api(base, '/api/register', { method: 'POST', body: { name: 'Nico', email: 'nico-print@example.invalid', password: 'secret3' } });
    const otherCookie = cookieHeader(other.res);

    const forbidden = await api(base, '/api/admin/print/overview', { cookie: memberCookie });
    assert.strictEqual(forbidden.status, 403);

    const empty = await api(base, '/api/print/me', { cookie: memberCookie });
    assert.strictEqual(empty.status, 200);
    assert.deepStrictEqual(empty.json.printers, []);
    assert.strictEqual(empty.json.balanceCents, 0);
    assert.strictEqual(empty.json.stripe.enabled, false);

    const draft = await api(base, '/api/admin/print/printers', {
      method: 'POST', cookie: adminCookie,
      body: { name: 'Da definire', protocol: 'ipp', host: '', enabled: false, visible: false, formats: ['A4'] },
    });
    assert.strictEqual(draft.status, 201, JSON.stringify(draft.json));
    const enableEarly = await api(base, '/api/admin/print/printers/' + draft.json.id, {
      method: 'PATCH', cookie: adminCookie, body: { enabled: true, visible: true },
    });
    assert.strictEqual(enableEarly.status, 400);

    const created = await api(base, '/api/admin/print/printers', {
      method: 'POST', cookie: adminCookie,
      body: {
        name: 'Reception', location: 'Bancone', protocol: 'ipp', host: '10.0.0.8', port: 631,
        supportsColor: true, supportsDuplex: true, formats: ['A4', 'A3'],
        agentId: 'studio-1', enabled: true, visible: true, isDefault: true,
      },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.json));
    const printerId = created.json.id;
    assert.strictEqual(created.json.connection, 'ipp://10.0.0.8:631/ipp/print');
    assert.strictEqual(created.json.connectionType, 'agent');
    assert.strictEqual(created.json.online, false);

    const prices = await api(base, '/api/admin/print/pricing', {
      method: 'PATCH', cookie: adminCookie,
      body: { bw: '0,10', color: 0.25, duplexBw: 0.08, duplexColor: 0.2, monthlyPageQuota: '' },
    });
    assert.strictEqual(prices.status, 200, JSON.stringify(prices.json));
    assert.strictEqual(prices.json.bwCents, 10);
    assert.strictEqual(prices.json.duplexBwCents, 8);

    const checkout = await api(base, '/api/print/checkout', { method: 'POST', cookie: memberCookie, body: { euros: 10 } });
    assert.strictEqual(checkout.status, 503);

    const top = await api(base, '/api/admin/print/topup', {
      method: 'POST', cookie: adminCookie,
      body: { userId: member.json.id, euros: 10, note: 'contanti in reception' },
    });
    assert.strictEqual(top.status, 200, JSON.stringify(top.json));
    assert.strictEqual(top.json.balanceCents, 1000);

    const pdf = await pdfBytes(3);
    const bad = await upload(base, memberCookie, Buffer.from('questo non è un pdf'), 'note.txt', 'application/pdf');
    assert.strictEqual(bad.status, 400);

    const up = await upload(base, memberCookie, pdf, 'relazione.pdf', 'application/pdf');
    assert.strictEqual(up.status, 201, JSON.stringify(up.json));
    assert.strictEqual(up.json.pageCount, 3);
    const preview = await api(base, '/api/print/uploads/' + up.json.id + '/file', { cookie: memberCookie });
    assert.strictEqual(preview.status, 200);
    assert.match(preview.res.headers.get('content-type'), /pdf/);
    const stolen = await api(base, '/api/print/uploads/' + up.json.id + '/file', { cookie: otherCookie });
    assert.strictEqual(stolen.status, 404);

    const badRange = await api(base, '/api/print/quote', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up.json.id, printerId, copies: 1, color: false, duplex: false, format: 'A4', pageRange: '9' },
    });
    assert.strictEqual(badRange.status, 400);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 1000);

    const quote = await api(base, '/api/print/quote', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up.json.id, printerId, copies: 2, color: false, duplex: true, format: 'A4', pageRange: '1-2' },
    });
    assert.strictEqual(quote.status, 200, JSON.stringify(quote.json));
    assert.strictEqual(quote.json.costCents, 32);
    assert.strictEqual(quote.json.enough, true);

    const job = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up.json.id, printerId, copies: 2, color: false, duplex: true, format: 'A4', pageRange: '1-2' },
    });
    assert.strictEqual(job.status, 201, JSON.stringify(job.json));
    assert.strictEqual(job.json.job.status, 'in coda');
    assert.strictEqual(job.json.balanceCents, 968);
    const jobId = job.json.job.id;
    const mine = await api(base, '/api/print/jobs', { cookie: memberCookie });
    assert.strictEqual(mine.json.length, 1);
    const others = await api(base, '/api/print/jobs', { cookie: otherCookie });
    assert.strictEqual(others.json.length, 0);
    const otherFile = await api(base, '/api/print/jobs/' + jobId + '/file', { cookie: otherCookie });
    assert.strictEqual(otherFile.status, 404);

    const agentEnv = {
      ...process.env,
      PRINT_SITE_URL: base,
      PRINT_AGENT_TOKEN: token,
      PRINT_AGENT_ID: 'studio-1',
      PRINT_BACKEND: 'file',
      PRINT_OUTPUT_DIR: outDir,
    };
    const agent = spawn(process.execPath, ['print-agent/agent.js', '--once'], { cwd: root, env: agentEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let agentLog = '';
    agent.stdout.on('data', (d) => { agentLog += d; });
    agent.stderr.on('data', (d) => { agentLog += d; });
    const agentCode = await new Promise((resolve) => agent.on('exit', resolve));
    assert.strictEqual(agentCode, 0, agentLog);
    const done = await api(base, '/api/print/jobs', { cookie: memberCookie });
    assert.strictEqual(done.json[0].status, 'completata', agentLog + JSON.stringify(done.json[0]));
    assert.strictEqual(done.json[0].pagesPrinted, 4);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);
    const written = fs.readFileSync(path.join(outDir, jobId + '.pdf'));
    assert.strictEqual(written.slice(0, 5).toString(), '%PDF-');
    const meta = JSON.parse(fs.readFileSync(path.join(outDir, jobId + '.json'), 'utf8'));
    assert.strictEqual(meta.copies, 2);
    assert.strictEqual(meta.duplex, true);
    assert.strictEqual(meta.color, false);
    assert.strictEqual(meta.printer.uri, 'ipp://10.0.0.8:631/ipp/print');
    const doc = await PDFDocument.load(written);
    assert.strictEqual(doc.getPageCount(), 2);

    const again = spawn(process.execPath, ['print-agent/agent.js', '--once'], { cwd: root, env: agentEnv, stdio: 'ignore' });
    assert.strictEqual(await new Promise((resolve) => again.on('exit', resolve)), 0);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);

    const up2 = await upload(base, memberCookie, pdf, 'bozza.pdf', 'application/pdf');
    const cancelJob = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up2.json.id, printerId, copies: 2, color: false, duplex: true, format: 'A4', pageRange: '1-2' },
    });
    assert.strictEqual(cancelJob.json.balanceCents, 936);
    const cancelled = await api(base, '/api/print/jobs/' + cancelJob.json.job.id + '/cancel', { method: 'POST', cookie: memberCookie, body: {} });
    assert.strictEqual(cancelled.status, 200, JSON.stringify(cancelled.json));
    assert.strictEqual(cancelled.json.status, 'rimborsata');
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);

    const up3 = await upload(base, memberCookie, pdf, 'rotto.pdf', 'application/pdf');
    const failJob = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up3.json.id, printerId, copies: 1, color: false, duplex: false, format: 'A4', pageRange: '1' },
    });
    assert.strictEqual(failJob.json.job.costCents, 10);
    const claim = await api(base, '/api/agent/jobs/' + failJob.json.job.id + '/claim', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: { agentId: 'studio-1' },
    });
    assert.strictEqual(claim.status, 200, JSON.stringify(claim.json));
    assert.strictEqual(claim.json.status, 'in stampa');
    const failed = await api(base, '/api/agent/jobs/' + failJob.json.job.id + '/result', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: { agentId: 'studio-1', status: 'errore', error: 'vassoio vuoto' },
    });
    assert.strictEqual(failed.status, 200, JSON.stringify(failed.json));
    assert.strictEqual(failed.json.job.status, 'rimborsata');
    assert.match(failed.json.job.error, /vassoio/);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);
    const replay = await api(base, '/api/agent/jobs/' + failJob.json.job.id + '/result', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: { agentId: 'studio-1', status: 'errore', error: 'di nuovo' },
    });
    assert.strictEqual(replay.json.job.status, 'rimborsata');
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);

    const up4 = await upload(base, memberCookie, pdf, 'troppo.pdf', 'application/pdf');
    const poor = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up4.json.id, printerId, copies: 20, color: true, duplex: false, format: 'A4', pageRange: '' },
    });
    assert.strictEqual(poor.status, 402, JSON.stringify(poor.json));
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), 968);

    const cheap = await api(base, '/api/admin/print/printers', {
      method: 'POST', cookie: adminCookie,
      body: {
        name: 'Economica', protocol: 'raw', host: '10.0.0.9', supportsColor: false, supportsDuplex: false,
        formats: ['A4'], agentId: 'studio-1', enabled: true, visible: true, priceBw: 0.03,
      },
    });
    assert.strictEqual(cheap.status, 201, JSON.stringify(cheap.json));
    assert.strictEqual(cheap.json.prices.bwCents, 3);
    const up5 = await upload(base, memberCookie, await pdfBytes(1), 'scontrino.pdf', 'application/pdf');
    const qCheap = await api(base, '/api/print/quote', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up5.json.id, printerId: cheap.json.id, copies: 1, color: false, duplex: false, format: 'A4', pageRange: '' },
    });
    assert.strictEqual(qCheap.json.costCents, 3);

    await api(base, '/api/admin/print/users/' + member.json.id + '/quota', {
      method: 'PUT', cookie: adminCookie, body: { mode: 'cap', pages: 1 },
    });
    const capped = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: up5.json.id, printerId: cheap.json.id, copies: 2, color: false, duplex: false, format: 'A4', pageRange: '' },
    });
    assert.strictEqual(capped.status, 400, JSON.stringify(capped.json));
    await api(base, '/api/admin/print/users/' + member.json.id + '/quota', {
      method: 'PUT', cookie: adminCookie, body: { mode: 'inherit' },
    });

    const png = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer();
    const image = await upload(base, memberCookie, png, 'logo.png', 'image/png');
    assert.strictEqual(image.status, 201, JSON.stringify(image.json));
    assert.strictEqual(image.json.pageCount, 1);

    const csv = await api(base, '/api/admin/print/jobs.csv?status=completata', { cookie: adminCookie });
    assert.strictEqual(csv.status, 200);
    assert.match(csv.res.headers.get('content-type'), /csv/);
    assert.match(csv.text, /relazione\.pdf/);
    assert.match(csv.text, /completata/);

    const listed = await api(base, '/api/admin/print/jobs?userId=' + member.json.id + '&printerId=' + printerId, { cookie: adminCookie });
    assert.ok(listed.json.every((j) => j.userId === member.json.id));
    assert.ok(listed.json.some((j) => j.filename === 'relazione.pdf'));

    const overview = await api(base, '/api/admin/print/overview', { cookie: adminCookie });
    assert.strictEqual(overview.json.tokenConfigured, true);
    assert.strictEqual(overview.json.stripe.enabled, false);
    assert.strictEqual(overview.json.cloud.enabled, true);
    assert.strictEqual(overview.json.cloud.transport, 'smtp');
    assert.match(overview.json.cloud.from, /stampa@studio\.test/);
    assert.ok(overview.json.stats.series.length === 30);
    assert.ok(overview.json.stats.month.pages >= 4);
    assert.strictEqual(typeof overview.json.stats.pending, 'number');
    assert.strictEqual(typeof overview.json.stats.today.jobs, 'number');
    const act = overview.json.stats.byPrinter.find((p) => p.printerId === printerId);
    assert.ok(act, 'missing per-printer activity');
    assert.ok(act.pagesMonth >= 4);
    assert.strictEqual(act.pending, 0);
    const online = overview.json.printers.find((p) => p.id === printerId);
    assert.strictEqual(online.online, true);

    const duplexCloud = await api(base, '/api/admin/print/printers', {
      method: 'POST', cookie: adminCookie,
      body: {
        name: 'Epson rotta', connectionType: 'cloud', cloudProvider: 'epson',
        cloudEmail: 'rotta@print.epsonconnect.com', supportsDuplex: true, formats: ['A4'],
        enabled: true, visible: true,
      },
    });
    assert.strictEqual(duplexCloud.status, 400, JSON.stringify(duplexCloud.json));
    const cloudPrinter = await api(base, '/api/admin/print/printers', {
      method: 'POST', cookie: adminCookie,
      body: {
        name: 'Epson bancone', location: 'Ingresso', connectionType: 'cloud', cloudProvider: 'epson',
        cloudEmail: 'Bancone@print.epsonconnect.com', cloudNotes: 'mittente già in lista',
        supportsColor: false, supportsDuplex: false, formats: ['A4'],
        agentId: 'studio-1', protocol: 'ipp', host: '10.0.0.8',
        enabled: true, visible: true, priceBw: 0.05,
      },
    });
    assert.strictEqual(cloudPrinter.status, 201, JSON.stringify(cloudPrinter.json));
    assert.strictEqual(cloudPrinter.json.connectionType, 'cloud');
    assert.strictEqual(cloudPrinter.json.cloudEmail, 'bancone@print.epsonconnect.com');
    assert.strictEqual(cloudPrinter.json.protocol, 'ipp');
    const cloudId = cloudPrinter.json.id;
    const meCloud = await api(base, '/api/print/me', { cookie: memberCookie });
    const visibleCloud = meCloud.json.printers.find((p) => p.id === cloudId);
    assert.ok(visibleCloud, 'cloud printer hidden from member');
    assert.strictEqual(visibleCloud.connectionType, 'cloud');
    assert.strictEqual(visibleCloud.cloudLabel, 'Epson Connect');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(visibleCloud, 'cloudEmail'), false);
    const agentCfg = await api(base, '/api/agent/config?agentId=studio-1', {
      headers: { authorization: 'Bearer ' + token },
    });
    assert.ok(agentCfg.json.printers.every((p) => p.id !== cloudId));
    const upCloud = await upload(base, memberCookie, await pdfBytes(1), 'volantino.pdf', 'application/pdf');
    assert.strictEqual(upCloud.status, 201, JSON.stringify(upCloud.json));
    const beforeCloud = await balanceOf(url, 'lia-print@example.invalid');
    const cloudQuote = await api(base, '/api/print/quote', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: upCloud.json.id, printerId: cloudId, copies: 2, color: true, duplex: true, format: 'A3', pageRange: '' },
    });
    assert.strictEqual(cloudQuote.status, 200, JSON.stringify(cloudQuote.json));
    assert.strictEqual(cloudQuote.json.color, false);
    assert.strictEqual(cloudQuote.json.duplex, false);
    assert.strictEqual(cloudQuote.json.format, 'A4');
    assert.strictEqual(cloudQuote.json.costCents, 10);
    assert.strictEqual(cloudQuote.json.delivery, 'cloud');
    const messagesBefore = smtp.messages.length;
    const cloudJob = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: upCloud.json.id, printerId: cloudId, copies: 2, color: true, duplex: true, format: 'A3', pageRange: '' },
    });
    assert.strictEqual(cloudJob.status, 201, JSON.stringify(cloudJob.json));
    assert.strictEqual(cloudJob.json.job.status, 'inviata al cloud');
    assert.strictEqual(cloudJob.json.job.delivery, 'cloud');
    assert.strictEqual(cloudJob.json.balanceCents, beforeCloud - 10);
    assert.strictEqual(smtp.messages.length, messagesBefore + 1);
    const mailed = pdfFromSmtp(smtp.messages[smtp.messages.length - 1]);
    assert.strictEqual((await PDFDocument.load(mailed)).getPageCount(), 2);
    assert.match(smtp.messages[smtp.messages.length - 1], /To: bancone@print\.epsonconnect\.com/);
    assert.doesNotMatch(smtp.messages[smtp.messages.length - 1], /^Bcc:/m);
    const filesBefore = fs.readdirSync(outDir).sort();
    const agentSkip = spawn(process.execPath, ['print-agent/agent.js', '--once'], { cwd: root, env: agentEnv, stdio: 'ignore' });
    assert.strictEqual(await new Promise((resolve) => agentSkip.on('exit', resolve)), 0);
    assert.deepStrictEqual(fs.readdirSync(outDir).sort(), filesBefore);
    const stillSent = await api(base, '/api/print/jobs', { cookie: memberCookie });
    assert.strictEqual(stillSent.json.find((j) => j.id === cloudJob.json.job.id).status, 'inviata al cloud');
    const notCancel = await api(base, '/api/print/jobs/' + cloudJob.json.job.id + '/cancel', {
      method: 'POST', cookie: memberCookie, body: {},
    });
    assert.strictEqual(notCancel.status, 409);
    const marked = await api(base, '/api/admin/print/jobs/' + cloudJob.json.job.id + '/printed', {
      method: 'POST', cookie: adminCookie, body: {},
    });
    assert.strictEqual(marked.status, 200, JSON.stringify(marked.json));
    assert.strictEqual(marked.json.status, 'completata');
    assert.strictEqual(marked.json.pagesPrinted, 2);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), beforeCloud - 10);
    const againMark = await api(base, '/api/admin/print/jobs/' + cloudJob.json.job.id + '/printed', {
      method: 'POST', cookie: adminCookie, body: {},
    });
    assert.strictEqual(againMark.status, 409);
    const upFail = await upload(base, memberCookie, await pdfBytes(1), 'rifiutata.pdf', 'application/pdf');
    smtp.rejectNext = true;
    const failedCloud = await api(base, '/api/print/jobs', {
      method: 'POST', cookie: memberCookie,
      body: { uploadId: upFail.json.id, printerId: cloudId, copies: 1, color: false, duplex: false, format: 'A4', pageRange: '' },
    });
    assert.strictEqual(failedCloud.status, 502, JSON.stringify(failedCloud.json));
    assert.match(failedCloud.json.error, /rimborsato/);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), beforeCloud - 10);
    const failedList = await api(base, '/api/print/jobs', { cookie: memberCookie });
    const failedRow = failedList.json.find((j) => j.filename === 'rifiutata.pdf');
    assert.strictEqual(failedRow.status, 'rimborsata');
    const refundedCloud = await api(base, '/api/admin/print/jobs/' + cloudJob.json.job.id + '/refund', {
      method: 'POST', cookie: adminCookie, body: { note: 'non uscito' },
    });
    assert.strictEqual(refundedCloud.status, 200, JSON.stringify(refundedCloud.json));
    assert.strictEqual(refundedCloud.json.status, 'rimborsata');
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), beforeCloud);
    const doubleRefund = await api(base, '/api/admin/print/jobs/' + cloudJob.json.job.id + '/refund', {
      method: 'POST', cookie: adminCookie, body: {},
    });
    assert.strictEqual(doubleRefund.status, 409);
    assert.strictEqual(await balanceOf(url, 'lia-print@example.invalid'), beforeCloud);
    const agentPrinted = await api(base, '/api/admin/print/jobs/' + jobId + '/printed', {
      method: 'POST', cookie: adminCookie, body: {},
    });
    assert.strictEqual(agentPrinted.status, 400);

    const removed = await api(base, '/api/admin/print/printers/' + printerId, { method: 'DELETE', cookie: adminCookie });
    assert.strictEqual(removed.status, 200);
    const after = await api(base, '/api/print/me', { cookie: memberCookie });
    assert.ok(after.json.printers.every((p) => p.id !== printerId));
    assert.ok(after.json.balanceCents >= 0);

    console.log('print e2e ok');
  } catch (err) {
    console.error(child.log());
    throw err;
  } finally {
    await stop(child);
    if (smtp && smtp.server) await new Promise((resolve) => smtp.server.close(resolve));
    fs.rmSync(outDir, { recursive: true, force: true });
    if (dbBackup) fs.writeFileSync(dbFile, dbBackup);
    else if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
