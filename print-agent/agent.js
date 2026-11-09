const fs = require('fs');
const path = require('path');
const { printJob } = require('./lib/backends');
const { probe } = require('./lib/status');

function loadConfig() {
  const filePath = process.env.PRINT_AGENT_CONFIG || path.join(__dirname, 'config.json');
  let file = {};
  if (fs.existsSync(filePath)) {
    try {
      file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error('config.json non è JSON valido:', err.message);
      process.exit(1);
    }
  }
  const cfg = {
    siteUrl: String(process.env.PRINT_SITE_URL || file.siteUrl || '').trim().replace(/\/$/, ''),
    token: String(process.env.PRINT_AGENT_TOKEN || file.token || '').trim(),
    agentId: String(process.env.PRINT_AGENT_ID || file.agentId || '').trim(),
    pollMs: Number(process.env.PRINT_POLL_MS || file.pollMs || 5000),
    backend: String(process.env.PRINT_BACKEND || file.backend || 'file').trim(),
    outputDir: path.resolve(process.env.PRINT_OUTPUT_DIR || file.outputDir || path.join(__dirname, 'print-out')),
    snmpCommunity: String(process.env.PRINT_SNMP_COMMUNITY || file.snmpCommunity || 'public'),
  };
  if (!cfg.siteUrl || !cfg.token || !cfg.agentId) {
    console.error('Config incompleta. Servono siteUrl, token e agentId.');
    console.error('Mettili in config.json (copia da config.example.json) oppure nelle variabili PRINT_SITE_URL, PRINT_AGENT_TOKEN, PRINT_AGENT_ID.');
    process.exit(1);
  }
  if (!['file', 'system'].includes(cfg.backend)) {
    console.error('backend deve essere "file" (prova su disco) o "system" (IPP/CUPS/raw).');
    process.exit(1);
  }
  if (!Number.isFinite(cfg.pollMs) || cfg.pollMs < 1000) cfg.pollMs = 5000;
  return cfg;
}

async function request(cfg, urlPath, { method, json, accept } = {}) {
  const res = await fetch(cfg.siteUrl + urlPath, {
    method: method || 'GET',
    headers: {
      Authorization: 'Bearer ' + cfg.token,
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(accept ? { accept } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (accept === 'application/pdf') {
    if (!res.ok) {
      const text = await res.text();
      throw new Error('Download ' + res.status + ' ' + text.slice(0, 200));
    }
    return Buffer.from(await res.arrayBuffer());
  }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!res.ok) {
    const err = new Error(body.error || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

async function tick(cfg) {
  const q = encodeURIComponent(cfg.agentId);
  const remote = await request(cfg, '/api/agent/config?agentId=' + q);
  const printers = remote.printers || [];
  if (!printers.length) {
    console.log('Nessuna stampante assegnata all\'agente «' + cfg.agentId + '». Aggiungila in Gestione stampe, con lo stesso ID agente.');
  } else {
    const enabled = printers.filter((p) => p.enabled);
    console.log('Stampanti per ' + cfg.agentId + ': ' + printers.map((p) => p.name + (p.enabled ? '' : ' (disabilitata)')).join(', '));
    if (!enabled.length) console.log('Nessuna è abilitata: i lavori restano in coda finché non la attivi dal sito.');
  }
  const listed = await request(cfg, '/api/agent/jobs?agentId=' + q);
  for (const job of listed.jobs || []) {
    const printer = printers.find((p) => p.id === job.printerId);
    try {
      await request(cfg, '/api/agent/jobs/' + job.id + '/claim', { method: 'POST', json: { agentId: cfg.agentId } });
    } catch (err) {
      if (err.status === 409) continue;
      console.error('Presa in carico non riuscita per ' + job.id + ':', err.message);
      continue;
    }
    try {
      const pdf = await request(cfg, '/api/agent/jobs/' + job.id + '/file?agentId=' + q, { accept: 'application/pdf' });
      const result = await printJob(cfg, printer, job, pdf);
      await request(cfg, '/api/agent/jobs/' + job.id + '/result', {
        method: 'POST',
        json: { agentId: cfg.agentId, status: 'completata', pagesPrinted: result.pagesPrinted },
      });
      console.log('Stampato ' + job.filename + ' → ' + (result.pdfPath || printer && printer.name || job.printerId));
    } catch (err) {
      console.error('Stampa fallita per ' + job.id + ':', err.message);
      try {
        await request(cfg, '/api/agent/jobs/' + job.id + '/result', {
          method: 'POST',
          json: { agentId: cfg.agentId, status: 'errore', error: err.message },
        });
      } catch (reportErr) {
        console.error('Non sono riuscito a segnalare l\'errore:', reportErr.message);
      }
    }
  }
  const reports = [];
  for (const printer of printers) {
    try { reports.push(await probe(cfg, printer)); }
    catch (err) { reports.push({ id: printer.id, state: 'unknown', message: err.message, supplies: [], backend: cfg.backend }); }
  }
  if (printers.length) {
    await request(cfg, '/api/agent/heartbeat', { method: 'POST', json: { agentId: cfg.agentId, printers: reports } });
  }
}

async function main() {
  const cfg = loadConfig();
  const once = process.argv.includes('--once');
  console.log('Agente «' + cfg.agentId + '» → ' + cfg.siteUrl + ' · backend ' + cfg.backend);
  const loop = async () => {
    try { await tick(cfg); }
    catch (err) { console.error('Ciclo agente:', err.message); if (once) process.exitCode = 1; }
  };
  await loop();
  if (once) return;
  setInterval(loop, cfg.pollMs);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { loadConfig, tick };
