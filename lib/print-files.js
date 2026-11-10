const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const { fail } = require('./print-logic');

const OFFICE_MIME = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

function detectKind(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return 'ole';
  return null;
}

function sofficeBin() {
  const fromEnv = process.env.SOFFICE_PATH;
  const candidates = [fromEnv, '/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice'].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function execFileAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
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

async function countPdfPages(buf) {
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw fail(400, 'PDF non leggibile. Se è protetto da password, esportane una copia senza password.');
  }
}

async function slicePdf(buf, pageNumbers) {
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const total = src.getPageCount();
  const all = pageNumbers.length === total && pageNumbers.every((n, i) => n === i + 1);
  if (all) return Buffer.from(buf);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  copied.forEach((p) => out.addPage(p));
  return Buffer.from(await out.save());
}

async function repeatPdf(buf, copies) {
  const n = Number(copies);
  if (!Number.isInteger(n) || n < 1) throw fail(400, 'Numero di copie non valido');
  if (n === 1) return Buffer.from(buf);
  const src = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  const indices = src.getPageIndices();
  for (let i = 0; i < n; i++) {
    const copied = await out.copyPages(src, indices);
    copied.forEach((page) => out.addPage(page));
  }
  return Buffer.from(await out.save());
}

async function imageToPdf(buf) {
  let jpeg;
  try {
    jpeg = await sharp(buf, { failOn: 'error', animated: false, limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 2480, height: 3508, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 86 })
      .toBuffer();
  } catch {
    throw fail(400, 'Immagine non valida (PNG, JPG o WEBP)');
  }
  const doc = await PDFDocument.create();
  const img = await doc.embedJpg(jpeg);
  const page = doc.addPage([595.28, 841.89]);
  const scale = Math.min(595.28 / img.width, 841.89 / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2, width: w, height: h });
  return Buffer.from(await doc.save());
}

async function officeToPdf(buf, filename) {
  const bin = sofficeBin();
  if (!bin) {
    throw fail(400, 'Conversione Office non disponibile su questo server. Esporta il file in PDF e ricaricalo.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-office-'));
  const base = 'input';
  const ext = path.extname(filename || '').toLowerCase();
  const allowed = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'];
  const suffix = allowed.includes(ext) ? ext : '.docx';
  const src = path.join(dir, base + suffix);
  try {
    fs.writeFileSync(src, buf);
    await execFileAsync(bin, ['--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, src], {
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const produced = path.join(dir, base + '.pdf');
    if (!fs.existsSync(produced)) throw fail(400, 'Conversione in PDF non riuscita');
    const pdf = fs.readFileSync(produced);
    if (detectKind(pdf) !== 'pdf') throw fail(400, 'Conversione in PDF non riuscita');
    return pdf;
  } catch (err) {
    if (err.expose) throw err;
    throw fail(400, 'Conversione in PDF non riuscita. Esporta il file in PDF e ricaricalo.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function normalizeToPdf(buf, filename) {
  const kind = detectKind(buf);
  if (kind === 'pdf') {
    const pages = await countPdfPages(buf);
    return { bytes: buf, pageCount: pages };
  }
  if (kind === 'png' || kind === 'jpeg' || kind === 'webp') {
    const bytes = await imageToPdf(buf);
    return { bytes, pageCount: 1 };
  }
  if (kind === 'zip' || kind === 'ole') {
    const bytes = await officeToPdf(buf, filename);
    const pageCount = await countPdfPages(bytes);
    return { bytes, pageCount };
  }
  throw fail(400, 'Tipo di file non accettato. Usa PDF, PNG, JPG, WEBP o un documento Office.');
}

module.exports = {
  OFFICE_MIME,
  detectKind,
  sofficeBin,
  countPdfPages,
  slicePdf,
  repeatPdf,
  imageToPdf,
  normalizeToPdf,
};
