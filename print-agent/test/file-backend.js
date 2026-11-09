const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { printFile, buildLpArgs, buildPjl } = require('../lib/backends');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-agent-'));
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const job = {
  id: 'job-123',
  filename: 'relazione.pdf',
  copies: 2,
  color: false,
  duplex: true,
  format: 'A4',
  pageRange: '1-2',
  pagesCharged: 4,
  printerId: 'p1',
};
const printer = {
  id: 'p1',
  name: 'Reception',
  protocol: 'ipp',
  connection: 'ipp://10.0.0.8:631/ipp/print',
  host: '10.0.0.8',
  port: 631,
  queue: '',
};

const written = printFile({ outputDir: dir, backend: 'file' }, printer, job, pdf);
assert.ok(written.pdfPath.endsWith('job-123.pdf'));
assert.strictEqual(fs.readFileSync(written.pdfPath).slice(0, 5).toString(), '%PDF-');
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'job-123.json'), 'utf8'));
assert.strictEqual(meta.copies, 2);
assert.strictEqual(meta.color, false);
assert.strictEqual(meta.duplex, true);
assert.strictEqual(meta.format, 'A4');
assert.strictEqual(meta.printer.uri, 'ipp://10.0.0.8:631/ipp/print');
assert.strictEqual(meta.backend, 'file');
assert.strictEqual(written.pagesPrinted, 4);

const lp = buildLpArgs(printer, job, '/tmp/x.pdf');
assert.ok(lp.includes('-n') && lp[lp.indexOf('-n') + 1] === '2');
assert.ok(lp.includes('sides=two-sided-long-edge'));
assert.ok(lp.includes('print-color-mode=monochrome'));
assert.ok(lp.includes('media=A4'));
assert.ok(lp.includes('-h') && lp[lp.indexOf('-h') + 1] === '10.0.0.8:631');
const withUri = buildLpArgs({ ...printer, uri: 'ipp://10.0.0.8:631/ipp/print' }, job, '/tmp/x.pdf');
assert.strictEqual(withUri[withUri.indexOf('-h') + 1], 'ipp://10.0.0.8:631/ipp/print');

const cups = buildLpArgs({ protocol: 'cups', queue: 'Studio' }, { copies: 1, color: true, duplex: false, format: 'A3', filename: 'a.pdf' }, '/tmp/a.pdf');
assert.strictEqual(cups[0], '-d');
assert.strictEqual(cups[1], 'Studio');
assert.ok(cups.includes('print-color-mode=color'));
assert.ok(cups.includes('sides=one-sided'));
assert.ok(cups.includes('media=A3'));

const pjl = buildPjl({ copies: 3, duplex: true, color: true, format: 'A3' }, Buffer.from('%PDF')).toString('latin1');
assert.ok(pjl.includes('@PJL SET COPIES=3'));
assert.ok(pjl.includes('@PJL SET DUPLEX=ON'));
assert.ok(pjl.includes('@PJL SET RENDERMODE=COLOR'));
assert.ok(pjl.includes('@PJL SET PAPER=A3'));
assert.ok(pjl.includes('%PDF'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('print-agent file backend ok');
