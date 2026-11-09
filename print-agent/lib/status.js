const fs = require('fs');
const { execFile } = require('child_process');

function which(name) {
  const paths = (process.env.PATH || '').split(pathSep());
  for (const dir of paths) {
    const full = dir + '/' + name;
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function pathSep() {
  return process.platform === 'win32' ? ';' : ':';
}

function execOut(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeout || 2500 }, (err, stdout) => {
      if (err) resolve('');
      else resolve(String(stdout || '').trim());
    });
  });
}

async function probe(cfg, printer) {
  if (cfg.backend === 'file') {
    return {
      id: printer.id,
      state: 'idle',
      backend: 'file',
      message: 'Backend di prova: scrive su file, nessuna stampante fisica',
      supplies: [],
    };
  }
  const report = { id: printer.id, state: 'unknown', backend: 'system', message: '', supplies: [] };
  if (!printer.host && !(printer.uri && printer.uri.startsWith('ipp'))) {
    report.message = 'Indirizzo non ancora configurato';
    return report;
  }
  if (which('lpstat') && printer.host && printer.protocol !== 'raw') {
    const out = await execOut('lpstat', ['-h', printer.host + ':' + (printer.port || 631), '-p'], 2500);
    if (out) {
      report.message = out.split('\n')[0].slice(0, 180);
      report.state = /idle|inattiva/i.test(out) ? 'idle' : /printing|in stampa/i.test(out) ? 'printing' : 'ready';
    }
  }
  if (which('snmpget') && printer.host) {
    const community = cfg.snmpCommunity || 'public';
    const descr = await execOut('snmpget', ['-v2c', '-c', community, '-t', '1', '-r', '0', '-Ovq', printer.host, '1.3.6.1.2.1.1.1.0'], 2000);
    if (descr) report.message = (report.message ? report.message + ' · ' : '') + descr.slice(0, 160);
    const level = await execOut('snmpget', ['-v2c', '-c', community, '-t', '1', '-r', '0', '-Ovq', printer.host, '1.3.6.1.2.1.43.11.1.1.9.1.1'], 2000);
    const n = Number(String(level).trim());
    if (Number.isFinite(n) && n >= 0 && n <= 100) report.supplies.push({ name: 'Toner', level: Math.round(n) });
  }
  if (!report.message) report.message = 'Stato non disponibile (IPP/SNMP non risponde)';
  return report;
}

module.exports = { probe };
