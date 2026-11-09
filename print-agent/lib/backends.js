const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9-]/g, '') || 'job';
}

function printFile(cfg, printer, job, buf) {
  const dir = cfg.outputDir;
  fs.mkdirSync(dir, { recursive: true });
  const id = safeId(job.id);
  const pdfPath = path.join(dir, id + '.pdf');
  const metaPath = path.join(dir, id + '.json');
  fs.writeFileSync(pdfPath, buf);
  const meta = {
    jobId: job.id,
    filename: job.filename,
    copies: job.copies,
    color: !!job.color,
    duplex: !!job.duplex,
    format: job.format || 'A4',
    pageRange: job.pageRange || '',
    pagesCharged: job.pagesCharged,
    printer: {
      id: printer && printer.id,
      name: printer && printer.name,
      protocol: printer && printer.protocol,
      uri: printer && printer.connection,
      host: printer && printer.host,
      port: printer && printer.port,
      queue: printer && printer.queue,
    },
    backend: 'file',
    writtenAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return { pagesPrinted: job.pagesCharged, pdfPath };
}

function buildLpArgs(printer, job, file) {
  const args = [];
  if (printer.protocol === 'cups') {
    if (!printer.queue) throw new Error('Coda CUPS mancante per ' + (printer.name || 'la stampante'));
    args.push('-d', printer.queue);
  } else if (printer.protocol === 'ipp') {
    if (printer.uri && /^ipps?:/i.test(printer.uri)) args.push('-h', printer.uri);
    else if (printer.host) args.push('-h', printer.host + ':' + (printer.port || 631));
    else throw new Error('Host IPP mancante per ' + (printer.name || 'la stampante'));
    args.push('-d', printer.queue || 'ipp/print');
  } else {
    throw new Error('Protocollo non gestito da lp: ' + printer.protocol);
  }
  args.push('-n', String(job.copies || 1));
  args.push('-o', 'media=' + (job.format || 'A4'));
  args.push('-o', job.duplex ? 'sides=two-sided-long-edge' : 'sides=one-sided');
  args.push('-o', job.color ? 'print-color-mode=color' : 'print-color-mode=monochrome');
  args.push('-t', String(job.filename || job.id || 'stampa').slice(0, 120));
  args.push('--', file);
  return args;
}

function buildPjl(job, pdf) {
  const header = Buffer.from(
    '\x1B%-12345X@PJL JOB\r\n'
    + '@PJL SET COPIES=' + String(job.copies || 1) + '\r\n'
    + '@PJL SET DUPLEX=' + (job.duplex ? 'ON' : 'OFF') + '\r\n'
    + '@PJL SET RENDERMODE=' + (job.color ? 'COLOR' : 'GRAYSCALE') + '\r\n'
    + '@PJL SET PAPER=' + (job.format || 'A4') + '\r\n'
    + '@PJL ENTER LANGUAGE=PDF\r\n'
  );
  const footer = Buffer.from('\r\n\x1B%-12345X@PJL EOJ\r\n\x1B%-12345X');
  return Buffer.concat([header, pdf, footer]);
}

function sendRaw(printer, job, pdf) {
  const host = printer.host;
  const port = printer.port || 9100;
  if (!host) return Promise.reject(new Error('IP mancante per la stampante raw ' + (printer.name || '')));
  const payload = buildPjl(job, pdf);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port, timeout: 15000 }, () => {
      socket.end(payload);
    });
    socket.setTimeout(20000);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Timeout verso ' + host + ':' + port));
    });
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) resolve({ pagesPrinted: job.pagesCharged });
    });
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function printSystem(cfg, printer, job, buf) {
  if (!printer) throw new Error('Stampante non presente nella configurazione ricevuta dal sito');
  if (printer.protocol === 'raw' || (printer.uri && printer.uri.startsWith('socket://'))) {
    return sendRaw(printer, job, buf);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-print-'));
  const file = path.join(dir, safeId(job.id) + '.pdf');
  try {
    fs.writeFileSync(file, buf);
    const args = buildLpArgs(printer, job, file);
    try {
      await run('lp', args);
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('Comando lp (CUPS) non trovato. Su Windows usa il protocollo raw 9100, oppure installa CUPS.');
      const detail = (err.stderr || err.message || '').toString().trim().slice(0, 300);
      throw new Error('lp ha rifiutato il lavoro' + (detail ? ': ' + detail : ''));
    }
    return { pagesPrinted: job.pagesCharged };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function printJob(cfg, printer, job, buf) {
  if (cfg.backend === 'file') return printFile(cfg, printer, job, buf);
  if (cfg.backend === 'system') return printSystem(cfg, printer, job, buf);
  throw new Error('Backend sconosciuto: ' + cfg.backend + '. Usa "file" o "system".');
}

module.exports = { printJob, printFile, printSystem, buildLpArgs, buildPjl, safeId };
