const assert = require('assert');
const crypto = require('crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');
const logic = require('../lib/print-logic');
const files = require('../lib/print-files');
const stripe = require('../lib/print-stripe');

function throws(status, fn) {
  assert.throws(fn, (err) => err.status === status);
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

async function main() {
  assert.deepStrictEqual(logic.parsePageRange('', 3), [1, 2, 3]);
  assert.deepStrictEqual(logic.parsePageRange(' 2 - 3 , 1 ', 4), [1, 2, 3]);
  assert.deepStrictEqual(logic.parsePageRange('1,1,2-3', 5), [1, 2, 3]);
  throws(400, () => logic.parsePageRange('2-1', 4));
  throws(400, () => logic.parsePageRange('9', 2));
  throws(400, () => logic.parsePageRange('a', 2));

  assert.strictEqual(logic.eurosToCents('0,10', 'Prezzo'), 10);
  assert.strictEqual(logic.eurosToCents(10.5, 'Prezzo'), 1050);
  throws(400, () => logic.eurosToCents(-1, 'Prezzo'));
  throws(400, () => logic.eurosToCents('1.005', 'Prezzo'));
  assert.strictEqual(logic.optionalEuros('', 'Prezzo'), null);

  const settings = { bwCents: 10, colorCents: 25, duplexBwCents: 8, duplexColorCents: 20, maxCopies: 20, maxPages: 200 };
  const printer = {
    supportsColor: true,
    supportsDuplex: true,
    formats: ['A4', 'A3'],
    bwCents: null,
    colorCents: null,
    duplexBwCents: null,
    duplexColorCents: null,
    enabled: true,
    visible: true,
    uri: '',
    host: '10.0.0.5',
    port: null,
    queue: '',
    protocol: 'ipp',
  };
  const opt = logic.validateOptions({
    copies: 2, color: false, duplex: true, format: 'A4', pageRange: '1-2', pageCount: 3, printer, settings,
  });
  assert.strictEqual(opt.pages.length, 2);
  assert.strictEqual(opt.unitCents, 8);
  assert.strictEqual(opt.impressions, 4);
  assert.strictEqual(opt.costCents, 32);

  const overridden = { ...printer, bwCents: 3 };
  assert.strictEqual(logic.quoteCost(settings, overridden, { pagesSelected: 1, copies: 1, color: false, duplex: false }).costCents, 3);
  throws(400, () => logic.validateOptions({
    copies: 1, color: true, duplex: false, format: 'A4', pageRange: '', pageCount: 1,
    printer: { ...printer, supportsColor: false }, settings,
  }));

  const draft = logic.validatePrinter({
    name: 'Reception', protocol: 'ipp', host: '', enabled: false, visible: false, formats: ['A4'],
  });
  assert.strictEqual(draft.enabled, false);
  assert.strictEqual(draft.host, '');
  throws(400, () => logic.validatePrinter({
    name: 'Reception', protocol: 'ipp', host: '', enabled: true, visible: true, formats: ['A4'],
  }));
  throws(400, () => logic.validatePrinter({
    name: 'Reception', protocol: 'raw', host: '10.0.0.5', enabled: true, visible: false, isDefault: true, formats: ['A4'],
  }));
  const ready = logic.validatePrinter({
    name: 'Bancone', protocol: 'ipp', host: '10.0.0.8', supportsColor: true, supportsDuplex: true,
    formats: ['A4', 'A3'], enabled: true, visible: true, isDefault: true, agentId: 'studio-1', priceBw: '0,03',
  });
  assert.strictEqual(ready.bw_cents, 3);
  assert.strictEqual(ready.agent_id, 'studio-1');
  assert.strictEqual(logic.buildConnectionUri({ protocol: 'ipp', host: '10.0.0.8', port: null, queue: '', uri: '' }), 'ipp://10.0.0.8:631/ipp/print');
  assert.strictEqual(logic.buildConnectionUri({ protocol: 'raw', host: '10.0.0.8', port: 9101, uri: '' }), 'socket://10.0.0.8:9101');
  assert.strictEqual(logic.buildConnectionUri({ protocol: 'cups', queue: 'Office', uri: '' }), 'cups://Office');
  assert.strictEqual(logic.buildConnectionUri({ protocol: 'ipp', host: '10.0.0.1', uri: 'ipp://custom/print' }), 'ipp://custom/print');
  assert.strictEqual(logic.isOnline(new Date(Date.now() - 10000).toISOString(), Date.now()), true);
  assert.strictEqual(logic.isOnline(new Date(Date.now() - 120000).toISOString(), Date.now()), false);
  assert.strictEqual(logic.memberCanUse({ enabled: true, visible: true, protocol: 'ipp', host: '10.0.0.1', uri: '', queue: '' }), true);
  assert.strictEqual(logic.memberCanUse({ enabled: false, visible: true, protocol: 'ipp', host: '10.0.0.1', uri: '', queue: '' }), false);

  const buf = await pdfBytes(3);
  assert.strictEqual(await files.countPdfPages(buf), 3);
  const sliced = await files.slicePdf(buf, [1, 3]);
  assert.strictEqual(await files.countPdfPages(sliced), 2);
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 91, b: 0 } } }).png().toBuffer();
  const fromImage = await files.normalizeToPdf(png, 'foto.png');
  assert.strictEqual(fromImage.pageCount, 1);
  assert.strictEqual(files.detectKind(fromImage.bytes), 'pdf');
  await assert.rejects(() => files.normalizeToPdf(Buffer.from('non un file vero!!'), 'note.txt'), (err) => err.status === 400);

  const secret = 'whsec_test';
  const raw = Buffer.from('{"id":"evt_1"}');
  const t = Math.floor(Date.now() / 1000);
  const expected = crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(String(t) + '.'), raw])).digest('hex');
  assert.strictEqual(stripe.verifySignature(raw, 't=' + t + ',v1=' + expected, secret), true);
  assert.strictEqual(stripe.verifySignature(raw, 't=' + t + ',v1=' + expected, secret, (t + 1000) * 1000), false);
  assert.strictEqual(stripe.verifySignature(raw, 't=' + t + ',v1=00', secret), false);
  const prevFlag = process.env.PRINT_STRIPE_ENABLED;
  const prevKey = process.env.STRIPE_SECRET_KEY;
  const prevWh = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.PRINT_STRIPE_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.strictEqual(stripe.status().enabled, false);
  process.env.PRINT_STRIPE_ENABLED = '1';
  assert.strictEqual(stripe.status().enabled, false);
  process.env.STRIPE_SECRET_KEY = 'sk_test';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec';
  assert.strictEqual(stripe.status().enabled, true);
  if (prevFlag == null) delete process.env.PRINT_STRIPE_ENABLED; else process.env.PRINT_STRIPE_ENABLED = prevFlag;
  if (prevKey == null) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
  if (prevWh == null) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = prevWh;

  console.log('print unit ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
