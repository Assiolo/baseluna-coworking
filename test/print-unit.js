const assert = require('assert');
const crypto = require('crypto');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');
const net = require('net');
const logic = require('../lib/print-logic');
const files = require('../lib/print-files');
const stripe = require('../lib/print-stripe');
const mail = require('../lib/print-mail');

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
  assert.strictEqual(ready.connection_type, 'agent');
  assert.strictEqual(ready.cloud_email, '');
  const cloud = logic.validatePrinter({
    name: 'Epson bancone', connectionType: 'cloud', cloudProvider: 'epson',
    cloudEmail: 'Studio@print.epsonconnect.com', cloudNotes: 'carta A4',
    supportsColor: true, supportsDuplex: false, formats: ['A4'],
    enabled: true, visible: true, protocol: 'raw', host: '10.0.0.4', agentId: 'studio-1',
  });
  assert.strictEqual(cloud.connection_type, 'cloud');
  assert.strictEqual(cloud.cloud_email, 'studio@print.epsonconnect.com');
  assert.strictEqual(cloud.cloud_label, 'Epson Connect');
  assert.strictEqual(cloud.protocol, 'raw');
  assert.strictEqual(cloud.host, '10.0.0.4');
  assert.strictEqual(logic.cloudMaxBytes('epson') > logic.cloudMaxBytes('hp'), true);
  throws(400, () => logic.validatePrinter({
    name: 'Epson', connectionType: 'cloud', cloudProvider: 'epson', cloudEmail: 'a@print.epsonconnect.com',
    supportsDuplex: true, formats: ['A4'], enabled: true, visible: true,
  }));
  throws(400, () => logic.validatePrinter({
    name: 'Epson', connectionType: 'cloud', cloudProvider: 'epson', cloudEmail: '',
    formats: ['A4'], enabled: true, visible: true,
  }));
  throws(400, () => logic.validatePrinter({
    name: 'Altro', connectionType: 'cloud', cloudProvider: 'other', cloudLabel: '',
    cloudEmail: 'a@print.example', formats: ['A4'], enabled: false,
  }));
  const forced = logic.validateOptions({
    copies: 2, color: false, duplex: true, format: 'A3', pageRange: '1', pageCount: 2,
    printer: {
      ...printer,
      connectionType: 'cloud',
      cloudProvider: 'epson',
      supportsColor: true,
      supportsDuplex: false,
      formats: ['A4'],
    },
    settings,
  });
  assert.strictEqual(forced.color, true);
  assert.strictEqual(forced.duplex, false);
  assert.strictEqual(forced.format, 'A4');
  assert.strictEqual(forced.copies, 2);
  assert.strictEqual(forced.impressions, 2);
  assert.strictEqual(logic.memberCanUse({
    enabled: true, visible: true, connectionType: 'cloud', cloudEmail: 'a@print.epsonconnect.com', protocol: 'cloud',
  }), true);
  assert.strictEqual(logic.memberCanUse({
    enabled: true, visible: true, connectionType: 'cloud', cloudEmail: '', protocol: 'cloud',
  }), false);
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
  const repeated = await files.repeatPdf(sliced, 3);
  assert.strictEqual(await files.countPdfPages(repeated), 6);
  assert.strictEqual(await files.countPdfPages(await files.repeatPdf(sliced, 1)), 2);
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

  const savedEnv = {};
  for (const key of ['PRINT_CLOUD_ENABLED', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'RESEND_API_KEY']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  try {
    assert.strictEqual(mail.describe().enabled, false);
    assert.match(mail.describe().reason, /PRINT_CLOUD_ENABLED/);
    process.env.PRINT_CLOUD_ENABLED = '1';
    assert.strictEqual(mail.describe().enabled, false);
    assert.match(mail.describe().reason, /mittente/);
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_FROM = 'Base Luna <stampa@studio.test>';
    const ready = mail.describe();
    assert.strictEqual(ready.enabled, true);
    assert.strictEqual(ready.transport, 'smtp');
    assert.strictEqual(ready.address, 'stampa@studio.test');
    assert.strictEqual(ready.secure, 'starttls');
    delete process.env.SMTP_HOST;
    process.env.RESEND_API_KEY = 're_test';
    assert.strictEqual(mail.describe().transport, 'resend');
    process.env.SMTP_HOST = 'smtp.example.test';
    assert.strictEqual(mail.describe().transport, 'smtp');
    const built = mail.buildRawMessage({
      from: 'Base Luna <stampa@studio.test>',
      to: 'printer@print.epsonconnect.com',
      filename: 'relazione.pdf',
      pdf: buf,
    });
    assert.match(built.raw, /Subject: Stampa/);
    assert.match(built.raw, /To: printer@print.epsonconnect.com/);
    assert.strictEqual(built.raw.includes('Bcc:'), false);
    assert.strictEqual(mail.dotStuff('ciao\r\n.punto\r\n'), 'ciao\r\n..punto\r\n');
    const fetched = [];
    const sentResend = await mail.sendViaResend({
      apiKey: 're_test',
      from: 'stampa@studio.test',
      to: 'printer@print.epsonconnect.com',
      filename: 'nota.pdf',
      pdf: buf,
      fetchImpl: async (url, opts) => {
        fetched.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, text: async () => JSON.stringify({ id: 'email_1' }) };
      },
    });
    assert.strictEqual(sentResend.messageId, 'email_1');
    assert.strictEqual(fetched[0].body.attachments.length, 1);
    assert.strictEqual(Buffer.from(fetched[0].body.attachments[0].content, 'base64').slice(0, 5).toString(), '%PDF-');

    const smtp = await new Promise((resolve) => {
      const messages = [];
      const server = net.createServer((socket) => {
        let bufSock = '';
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
              messages.push(data.slice(0, end));
              data = '';
              collecting = false;
              reply('250 queued as test-id');
            }
            return;
          }
          bufSock += text;
          while (!collecting && bufSock.includes('\r\n')) {
            const i = bufSock.indexOf('\r\n');
            const line = bufSock.slice(0, i);
            bufSock = bufSock.slice(i + 2);
            const cmd = line.toUpperCase();
            if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250-test\r\n250 OK\r\n');
            else if (cmd === 'DATA') {
              collecting = true;
              data = bufSock;
              bufSock = '';
              reply('354 send');
            } else if (cmd.startsWith('QUIT')) {
              reply('221 bye');
              socket.end();
            } else reply('250 OK');
          }
        });
      });
      server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port }));
    });
    delete process.env.RESEND_API_KEY;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(smtp.port);
    process.env.SMTP_SECURE = 'plain';
    process.env.SMTP_FROM = 'stampa@studio.test';
    const sent = await mail.sendPdf({ to: 'abc@print.epsonconnect.com', filename: 'foglio.pdf', pdf: sliced });
    assert.match(sent.messageId, /queued/);
    assert.strictEqual(smtp.messages.length, 1);
    const unstuffed = smtp.messages[0].split('\r\n').map((line) => (line.startsWith('.') ? line.slice(1) : line)).join('\r\n');
    const marker = 'Content-Transfer-Encoding: base64\r\n\r\n';
    const at = unstuffed.indexOf(marker);
    assert.ok(at > 0);
    const b64 = unstuffed.slice(at + marker.length).split('\r\n--')[0].replace(/\r\n/g, '');
    const attached = Buffer.from(b64, 'base64');
    assert.strictEqual(attached.slice(0, 5).toString(), '%PDF-');
    assert.strictEqual(await files.countPdfPages(attached), 2);
    await new Promise((resolve) => smtp.server.close(resolve));
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('print unit ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
