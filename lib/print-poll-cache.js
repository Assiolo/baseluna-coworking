// Cache di un solo processo. L'agente chiama il sito ogni pochi secondi: un
// SELECT a ogni giro tiene acceso Neon e consuma i 100 CU-h del piano free.
// «In linea» (finestra 90 s, in print-logic) si legge da qui, con fallback al
// last_heartbeat su Postgres. Il database riceve last_heartbeat — e status_json
// se c'è un report — solo al primo heartbeat del processo per quella stampante,
// se cambiano stato, messaggio o toner, oppure al massimo ogni 10 minuti.
// createPollCache() è per i test; il server usa l'istanza esportata sotto.

const SETTINGS_TTL_MS = 60 * 1000;
const PRINTERS_TTL_MS = 60 * 1000;
const HEARTBEAT_FLUSH_MS = 10 * 60 * 1000;
const JOBS_SAFETY_MS = 5 * 60 * 1000;
const NEVER_FLUSHED = Object.create(null);

function statusSignature(status) {
  const supplies = Array.isArray(status && status.supplies) ? status.supplies : [];
  return JSON.stringify({
    state: String((status && status.state) || ''),
    message: String((status && status.message) || ''),
    supplies: supplies.map((s) => [
      String((s && s.name) || ''),
      s && s.level != null && Number.isFinite(Number(s.level)) ? Number(s.level) : null,
    ]),
  });
}

function cloneStatus(status) {
  const supplies = Array.isArray(status && status.supplies) ? status.supplies : [];
  return {
    state: String((status && status.state) || ''),
    message: String((status && status.message) || ''),
    backend: String((status && status.backend) || ''),
    supplies: supplies.map((s) => ({
      name: String((s && s.name) || ''),
      level: s && s.level != null && Number.isFinite(Number(s.level)) ? Number(s.level) : null,
    })),
  };
}

function createPollCache() {
  const heartbeats = new Map();
  const printers = new Map();
  const agents = new Map();
  let settings = null;

  function readSettings(now = Date.now()) {
    if (!settings || now - settings.at >= SETTINGS_TTL_MS) return null;
    return { ...settings.value };
  }

  function writeSettings(value, now = Date.now()) {
    settings = { value: { ...value }, at: now };
  }

  function invalidateSettings() {
    settings = null;
  }

  function readPrinters(agentId, now = Date.now()) {
    const row = printers.get(String(agentId || ''));
    if (!row || now - row.at >= PRINTERS_TTL_MS) return null;
    return row.value.map((p) => ({ ...p }));
  }

  function writePrinters(agentId, value, now = Date.now()) {
    const list = Array.isArray(value) ? value.map((p) => ({ ...p })) : [];
    printers.set(String(agentId || ''), { value: list, at: now });
  }

  function invalidatePrinters(agentId) {
    if (agentId == null || agentId === '') {
      printers.clear();
      return;
    }
    printers.delete(String(agentId));
  }

  function markJobs(agentId) {
    const id = String(agentId || '');
    if (!id) return;
    const prev = agents.get(id);
    agents.set(id, {
      pending: true,
      checkedAt: prev ? prev.checkedAt : null,
      epoch: (prev ? prev.epoch : 0) + 1,
    });
  }

  function jobsEpoch(agentId) {
    const row = agents.get(String(agentId || ''));
    return row ? row.epoch : 0;
  }

  // true se la coda va riletta: flag alzato, agente mai controllato da questo
  // processo, oppure sono passati 5 minuti (rete di sicurezza).
  function shouldQueryJobs(agentId, now = Date.now()) {
    const row = agents.get(String(agentId || ''));
    if (!row || row.checkedAt == null) return true;
    if (row.pending) return true;
    return now - row.checkedAt >= JOBS_SAFETY_MS;
  }

  function rememberJobs(agentId, found, now = Date.now(), epochAtStart) {
    const id = String(agentId || '');
    if (!id) return;
    const prev = agents.get(id);
    const epoch = prev ? prev.epoch : 0;
    const start = epochAtStart == null ? epoch : epochAtStart;
    const raisedDuring = epoch !== start;
    agents.set(id, {
      pending: !!found || raisedDuring,
      checkedAt: now,
      epoch,
    });
  }

  function observeHeartbeat(printerId, info) {
    const id = String(printerId || '');
    const stamp = Number(info && info.at);
    const hasReport = !!(info && info.hasReport);
    const normalized = hasReport ? cloneStatus(info.status) : null;
    const signature = normalized ? statusSignature(normalized) : null;
    const prev = heartbeats.get(id);
    let flush = false;
    let reason = '';
    if (!prev || prev.flushedAt == null) {
      flush = true;
      reason = 'first';
    } else if (hasReport && signature !== prev.flushedSignature) {
      flush = true;
      reason = 'status';
    } else if (stamp - prev.flushedAt >= HEARTBEAT_FLUSH_MS) {
      flush = true;
      reason = 'interval';
    }
    const entry = {
      at: stamp,
      iso: new Date(stamp).toISOString(),
      status: hasReport ? normalized : (prev && prev.hasStatus ? prev.status : null),
      hasStatus: hasReport ? true : !!(prev && prev.hasStatus),
      flushedAt: flush ? stamp : (prev ? prev.flushedAt : null),
      flushedSignature: flush
        ? (hasReport ? signature : (prev ? prev.flushedSignature : NEVER_FLUSHED))
        : (prev ? prev.flushedSignature : NEVER_FLUSHED),
    };
    heartbeats.set(id, entry);
    return { flush, reason };
  }

  function overlayPrinter(printer) {
    if (!printer || printer.id == null) return printer;
    const hb = heartbeats.get(String(printer.id));
    if (!hb) return printer;
    const next = { ...printer, lastHeartbeat: hb.iso };
    if (hb.hasStatus) next.status = hb.status;
    return next;
  }

  return {
    readSettings,
    writeSettings,
    invalidateSettings,
    readPrinters,
    writePrinters,
    invalidatePrinters,
    markJobs,
    jobsEpoch,
    shouldQueryJobs,
    rememberJobs,
    observeHeartbeat,
    overlayPrinter,
  };
}

const shared = createPollCache();

module.exports = {
  createPollCache,
  SETTINGS_TTL_MS,
  PRINTERS_TTL_MS,
  HEARTBEAT_FLUSH_MS,
  JOBS_SAFETY_MS,
  readSettings: shared.readSettings,
  writeSettings: shared.writeSettings,
  invalidateSettings: shared.invalidateSettings,
  readPrinters: shared.readPrinters,
  writePrinters: shared.writePrinters,
  invalidatePrinters: shared.invalidatePrinters,
  markJobs: shared.markJobs,
  jobsEpoch: shared.jobsEpoch,
  shouldQueryJobs: shared.shouldQueryJobs,
  rememberJobs: shared.rememberJobs,
  observeHeartbeat: shared.observeHeartbeat,
  overlayPrinter: shared.overlayPrinter,
};
