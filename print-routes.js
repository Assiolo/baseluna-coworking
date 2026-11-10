const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const store = require('./print-store');
const logic = require('./lib/print-logic');
const stripe = require('./lib/print-stripe');

const { fail } = logic;

function safeEqual(presented, expected) {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(String(expected || ''));
  if (!expected || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function auth(q, s, next) {
  try {
    q.u = await db.userBySession(q.cookies && q.cookies.sid);
  } catch (err) {
    return next(err);
  }
  if (!q.u) return s.status(401).json({ error: 'Non autenticato' });
  return next();
}

function admin(q, s, next) {
  if (!q.u || q.u.role !== 'admin') return s.status(403).json({ error: 'Solo admin' });
  return next();
}

function agentAuth(q, s, next) {
  const expected = String(process.env.PRINT_AGENT_TOKEN || '').trim();
  if (!expected) return s.status(503).json({ error: 'Agente di stampa non configurato sul server' });
  const header = q.get('authorization') || '';
  const presented = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : String(q.get('x-print-agent-token') || '').trim();
  if (!safeEqual(presented, expected)) return s.status(401).json({ error: 'Token agente non valido' });
  return next();
}

function agentIdOf(q) {
  const id = logic.slugAgent((q.body && q.body.agentId) || q.query.agentId || '');
  if (!id) throw fail(400, 'agentId mancante');
  return id;
}

function sendPdf(s, bytes, filename, download) {
  const name = logic.safeFilename(filename).replace(/"/g, '');
  s.set('Content-Type', 'application/pdf');
  s.set('X-Content-Type-Options', 'nosniff');
  s.set('Cache-Control', 'private, no-store');
  s.set('Content-Disposition', (download ? 'attachment' : 'inline') + '; filename="' + name.replace(/[^\w.\- ()]/g, '_') + '"');
  s.send(bytes);
}

function baseUrl(q) {
  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const proto = q.get('x-forwarded-proto') || q.protocol || 'https';
  return proto + '://' + q.get('host');
}

function dateOrEmpty(value, label) {
  if (value == null || value === '') return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw fail(400, label + ' non valida');
  return String(value);
}

function jobFilter(q, extra) {
  const status = q.query.status ? String(q.query.status) : '';
  if (status && !logic.STATUSES.includes(status)) throw fail(400, 'Stato non valido');
  const printerId = q.query.printerId ? String(q.query.printerId) : '';
  if (printerId && !/^[A-Za-z0-9-]{1,80}$/.test(printerId)) throw fail(400, 'Stampante non valida');
  let userId = null;
  if (q.query.userId) {
    userId = Number(q.query.userId);
    if (!Number.isInteger(userId)) throw fail(400, 'Utente non valido');
  }
  return {
    status,
    printerId,
    userId,
    from: dateOrEmpty(q.query.from, 'Data iniziale'),
    to: dateOrEmpty(q.query.to, 'Data finale'),
    ...extra,
  };
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[;"\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function settingsFromBody(body) {
  const b = body || {};
  const patch = {};
  if ('bw' in b) patch.bwCents = logic.eurosToCents(b.bw, 'Prezzo B/N');
  if ('color' in b) patch.colorCents = logic.eurosToCents(b.color, 'Prezzo colore');
  if ('duplexBw' in b) patch.duplexBwCents = logic.eurosToCents(b.duplexBw, 'Prezzo fronte/retro B/N');
  if ('duplexColor' in b) patch.duplexColorCents = logic.eurosToCents(b.duplexColor, 'Prezzo fronte/retro colore');
  if ('maxUploadMb' in b) {
    const mb = Number(b.maxUploadMb);
    if (!Number.isFinite(mb)) throw fail(400, 'Dimensione massima non valida');
    patch.maxUploadBytes = Math.round(mb * 1024 * 1024);
  }
  if ('maxCopies' in b) patch.maxCopies = Number(b.maxCopies);
  if ('maxPages' in b) patch.maxPages = Number(b.maxPages);
  if ('monthlyPageQuota' in b) {
    if (b.monthlyPageQuota == null || b.monthlyPageQuota === '') patch.monthlyPageQuota = null;
    else {
      const n = Number(b.monthlyPageQuota);
      if (!Number.isInteger(n)) throw fail(400, 'Quota mensile non valida');
      patch.monthlyPageQuota = n;
    }
  }
  return patch;
}

function logConfig() {
  const token = !!String(process.env.PRINT_AGENT_TOKEN || '').trim();
  const pay = stripe.status();
  const cloud = store.cloudStatus();
  console.log('Stampa: agente ' + (token ? 'attivo (token impostato)' : 'in attesa di PRINT_AGENT_TOKEN'));
  console.log('Stampa: ricarica Stripe ' + (pay.enabled ? 'attiva' : 'disattivata'));
  console.log('Stampa: cloud email ' + (cloud.enabled ? 'attiva (' + cloud.transport + ')' : 'disattivata'));
}

function mountWebhook(app) {
  app.post('/api/print/stripe/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (q, s, next) => {
    try {
      const pay = stripe.status();
      if (!pay.enabled) return s.sendStatus(404);
      const raw = Buffer.isBuffer(q.body) ? q.body : Buffer.from(q.body || '');
      const ok = stripe.verifySignature(raw, q.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
      if (!ok) return s.status(400).json({ error: 'Firma non valida' });
      let event;
      try { event = JSON.parse(raw.toString('utf8')); } catch { return s.status(400).json({ error: 'JSON non valido' }); }
      if (event.type === 'checkout.session.completed') {
        const session = event.data && event.data.object;
        if (session && session.payment_status === 'paid' && session.id) {
          const userId = Number(session.metadata && session.metadata.userId);
          const amountCents = Number(session.metadata && session.metadata.amountCents);
          const checkoutId = session.metadata && session.metadata.checkoutId;
          await store.applyStripeCredit({
            sessionId: session.id,
            checkoutId,
            userId,
            amountCents,
          });
        }
      }
      s.json({ received: true });
    } catch (err) {
      next(err);
    }
  });
}

function mount(app) {
  const rawUpload = express.raw({ type: () => true, limit: '26mb' });

  app.get('/api/print/me', auth, async (q, s, next) => {
    try {
      const settings = await store.getSettings();
      const printers = (await store.listPrinters())
        .filter((p) => store.usableByMember(p))
        .map((p) => store.presentPrinter(p, settings, { admin: false }));
      const jobs = await store.listJobs({ userId: q.u.id, limit: 50 });
      const ledger = await store.ledgerFor(q.u.id, 30);
      s.json({
        balanceCents: await store.balanceOf(q.u.id),
        settings: {
          bwCents: settings.bwCents,
          colorCents: settings.colorCents,
          duplexBwCents: settings.duplexBwCents,
          duplexColorCents: settings.duplexColorCents,
          maxUploadBytes: settings.maxUploadBytes,
          maxCopies: settings.maxCopies,
          maxPages: settings.maxPages,
          monthlyPageQuota: settings.monthlyPageQuota,
        },
        quota: await store.quotaView(q.u.id),
        printers,
        defaultPrinterId: (printers.find((p) => p.isDefault) || printers[0] || {}).id || null,
        jobs,
        ledger,
        stripe: { enabled: stripe.status().enabled },
      });
    } catch (err) { next(err); }
  });

  app.post('/api/print/uploads', auth, rawUpload, async (q, s, next) => {
    try {
      const filename = logic.safeFilename(q.get('x-filename') || q.query.name || 'documento.pdf');
      const created = await store.createUpload({
        userId: q.u.id,
        filename,
        bytes: Buffer.isBuffer(q.body) ? q.body : Buffer.alloc(0),
      });
      s.status(201).json(created);
    } catch (err) { next(err); }
  });

  app.get('/api/print/uploads/:id/file', auth, async (q, s, next) => {
    try {
      const row = await store.uploadForUser(q.params.id, q.u.id, { withBytes: true });
      if (!row) return s.status(404).json({ error: 'File non trovato' });
      sendPdf(s, row.bytes, row.filename, q.query.download === '1');
    } catch (err) { next(err); }
  });

  app.post('/api/print/quote', auth, async (q, s, next) => {
    try {
      const b = q.body || {};
      s.json(await store.quoteJob({
        userId: q.u.id,
        uploadId: b.uploadId,
        printerId: b.printerId,
        copies: b.copies,
        color: b.color,
        duplex: b.duplex,
        format: b.format,
        pageRange: b.pageRange,
      }));
    } catch (err) { next(err); }
  });

  app.post('/api/print/jobs', auth, async (q, s, next) => {
    try {
      const b = q.body || {};
      const result = await store.submitJob({
        userId: q.u.id,
        uploadId: b.uploadId,
        printerId: b.printerId,
        copies: b.copies,
        color: b.color,
        duplex: b.duplex,
        format: b.format,
        pageRange: b.pageRange,
      });
      s.status(201).json(result);
    } catch (err) { next(err); }
  });

  app.get('/api/print/jobs', auth, async (q, s, next) => {
    try {
      s.json(await store.listJobs({ userId: q.u.id, limit: 50 }));
    } catch (err) { next(err); }
  });

  app.get('/api/print/jobs/:id/file', auth, async (q, s, next) => {
    try {
      const job = await store.jobById(null, q.params.id, { admin: false, withBytes: true });
      if (!job || !job.bytes || (job.userId !== q.u.id && q.u.role !== 'admin')) return s.status(404).json({ error: 'File non trovato' });
      sendPdf(s, job.bytes, job.filename, q.query.download === '1');
    } catch (err) { next(err); }
  });

  app.post('/api/print/jobs/:id/cancel', auth, async (q, s, next) => {
    try {
      s.json(await store.cancelJob(q.params.id, q.u.id));
    } catch (err) { next(err); }
  });

  app.get('/api/print/ledger', auth, async (q, s, next) => {
    try {
      s.json(await store.ledgerFor(q.u.id, 50));
    } catch (err) { next(err); }
  });

  app.post('/api/print/checkout', auth, async (q, s, next) => {
    try {
      if (!stripe.status().enabled) {
        return s.status(503).json({ error: 'La ricarica online non è attiva. Puoi ricaricare in reception.', stripe: false });
      }
      const euros = Number(q.body && q.body.euros);
      const amountCents = logic.eurosToCents(euros, 'Importo');
      if (amountCents < 100 || amountCents > 20000) throw fail(400, 'Ricarica tra 1 € e 200 €');
      const checkoutId = crypto.randomUUID();
      const base = baseUrl(q);
      const session = await stripe.createCheckout({
        amountCents,
        userId: q.u.id,
        email: q.u.email,
        checkoutId,
        successUrl: base + '/?stampa=ok',
        cancelUrl: base + '/?stampa=annullata',
      });
      await store.openCheckout({ id: checkoutId, userId: q.u.id, amountCents, stripeSessionId: session.id });
      s.json({ url: session.url });
    } catch (err) { next(err); }
  });

  app.get('/api/admin/print/overview', auth, admin, async (q, s, next) => {
    try {
      const settings = await store.getSettings();
      const printers = (await store.listPrinters()).map((p) => store.presentPrinter(p, settings, { admin: true }));
      s.json({
        tokenConfigured: !!String(process.env.PRINT_AGENT_TOKEN || '').trim(),
        stripe: stripe.status(),
        cloud: store.cloudStatus(),
        settings,
        printers,
        stats: await store.stats(),
        quotas: await store.listQuotas(),
        accounts: await store.accounts(),
      });
    } catch (err) { next(err); }
  });

  app.get('/api/admin/print/jobs.csv', auth, admin, async (q, s, next) => {
    try {
      const jobs = await store.listJobs({ ...jobFilter(q, {}), admin: true, limit: 500 });
      const header = ['id', 'data', 'utente', 'email', 'stampante', 'file', 'pagine', 'copie', 'colore', 'fronte_retro', 'formato', 'costo_euro', 'stato', 'pagine_stampate', 'errore'];
      const lines = [header.join(';')];
      for (const job of jobs) {
        lines.push([
          job.id,
          job.createdAt ? new Date(job.createdAt).toISOString() : '',
          job.userName || '',
          job.userEmail || '',
          job.printerName || '',
          job.filename,
          job.pagesCharged,
          job.copies,
          job.color ? 'colore' : 'b/n',
          job.duplex ? 'fronte/retro' : 'solo fronte',
          job.format,
          (job.costCents / 100).toFixed(2).replace('.', ','),
          job.status,
          job.pagesPrinted == null ? '' : job.pagesPrinted,
          job.error || '',
        ].map(csvCell).join(';'));
      }
      s.set('Content-Type', 'text/csv; charset=utf-8');
      s.set('Content-Disposition', 'attachment; filename="stampe.csv"');
      s.send('\uFEFF' + lines.join('\n'));
    } catch (err) { next(err); }
  });

  app.get('/api/admin/print/jobs', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.listJobs({ ...jobFilter(q, {}), admin: true, limit: 200 }));
    } catch (err) { next(err); }
  });

  app.post('/api/admin/print/jobs/:id/refund', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.adminRefund(q.params.id, q.u.id, (q.body && q.body.note) || ''));
    } catch (err) { next(err); }
  });

  app.post('/api/admin/print/jobs/:id/printed', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.markPrinted(q.params.id));
    } catch (err) { next(err); }
  });

  app.post('/api/admin/print/jobs/:id/resend', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.resendCloud(q.params.id));
    } catch (err) { next(err); }
  });

  app.get('/api/admin/print/printers', auth, admin, async (q, s, next) => {
    try {
      const settings = await store.getSettings();
      const printers = (await store.listPrinters()).map((p) => store.presentPrinter(p, settings, { admin: true }));
      s.json(printers);
    } catch (err) { next(err); }
  });

  app.post('/api/admin/print/printers', auth, admin, async (q, s, next) => {
    try {
      const printer = await store.createPrinter(q.body || {});
      const settings = await store.getSettings();
      s.status(201).json(store.presentPrinter(printer, settings, { admin: true }));
    } catch (err) { next(err); }
  });

  app.patch('/api/admin/print/printers/:id', auth, admin, async (q, s, next) => {
    try {
      const printer = await store.updatePrinter(q.params.id, q.body || {});
      const settings = await store.getSettings();
      s.json(store.presentPrinter(printer, settings, { admin: true }));
    } catch (err) { next(err); }
  });

  app.delete('/api/admin/print/printers/:id', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.deletePrinter(q.params.id));
    } catch (err) { next(err); }
  });

  app.patch('/api/admin/print/pricing', auth, admin, async (q, s, next) => {
    try {
      s.json(await store.updateSettings(settingsFromBody(q.body)));
    } catch (err) { next(err); }
  });

  app.post('/api/admin/print/topup', auth, admin, async (q, s, next) => {
    try {
      const userId = Number(q.body && q.body.userId);
      if (!Number.isInteger(userId)) throw fail(400, 'Utente non valido');
      const amountCents = logic.eurosToCents(q.body && q.body.euros, 'Importo');
      const result = await store.topup({
        userId,
        amountCents,
        note: q.body && q.body.note,
        actorId: q.u.id,
      });
      s.json(result);
    } catch (err) { next(err); }
  });

  app.put('/api/admin/print/users/:id/quota', auth, admin, async (q, s, next) => {
    try {
      const userId = Number(q.params.id);
      if (!Number.isInteger(userId)) throw fail(400, 'Utente non valido');
      s.json(await store.setUserQuota(userId, {
        mode: q.body && q.body.mode,
        pages: q.body && q.body.pages,
        note: q.body && q.body.note,
      }));
    } catch (err) { next(err); }
  });

  app.get('/api/agent/config', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      const settings = await store.getSettings();
      const printers = (await store.printersForAgent(agentId)).map((p) => ({
        ...store.presentPrinter(p, settings, { admin: true }),
        enabled: p.enabled,
      }));
      s.json({ agentId, pollHintMs: 5000, printers });
    } catch (err) { next(err); }
  });

  app.get('/api/agent/jobs', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      s.json({ jobs: await store.pullJobs(agentId) });
    } catch (err) { next(err); }
  });

  app.post('/api/agent/jobs/:id/claim', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      s.json(await store.claimJob(q.params.id, agentId));
    } catch (err) { next(err); }
  });

  app.get('/api/agent/jobs/:id/file', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      const file = await store.jobFileForAgent(q.params.id, agentId);
      sendPdf(s, file.bytes, file.filename, true);
    } catch (err) { next(err); }
  });

  app.post('/api/agent/jobs/:id/result', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      const job = await store.applyAgentResult({
        id: q.params.id,
        agentId,
        status: q.body && q.body.status,
        pagesPrinted: q.body && q.body.pagesPrinted,
        error: q.body && q.body.error,
      });
      s.json({ ok: true, job });
    } catch (err) { next(err); }
  });

  app.post('/api/agent/heartbeat', agentAuth, async (q, s, next) => {
    try {
      const agentId = agentIdOf(q);
      const printers = await store.heartbeat(agentId, q.body && q.body.printers);
      s.json({ ok: true, printers: printers.map((p) => ({ id: p.id, online: logic.isOnline(p.lastHeartbeat) })) });
    } catch (err) { next(err); }
  });
}

module.exports = { mount, mountWebhook, logConfig };
