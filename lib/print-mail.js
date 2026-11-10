const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { fail } = require('./print-logic');

const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function mailbox(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 200 || /[\r\n\u0000]/.test(raw)) return null;
  const angled = /^(.*)<([^<>]+)>\s*$/.exec(raw);
  const email = (angled ? angled[2] : raw).trim();
  if (!EMAIL_RE.test(email) || email.length > 200) return null;
  let name = angled ? angled[1].trim().replace(/^"|"$/g, '').trim() : '';
  if (name && !/^[\x20-\x7E]+$/.test(name)) return null;
  if (/[<>"]/.test(name)) return null;
  return { email, header: name ? name + ' <' + email + '>' : email };
}

function isEmail(value) {
  return !!mailbox(value);
}

function secureMode(port) {
  const raw = String(process.env.SMTP_SECURE || '').trim().toLowerCase();
  if (raw === 'plain' || raw === 'none' || raw === '0') return 'plain';
  if (raw === 'tls' || raw === 'ssl' || raw === 'smtps') return 'tls';
  if (raw === 'starttls') return 'starttls';
  if (Number(port) === 465) return 'tls';
  return 'starttls';
}

function describe() {
  const flag = String(process.env.PRINT_CLOUD_ENABLED || '').trim() === '1';
  const from = mailbox(process.env.SMTP_FROM);
  const host = String(process.env.SMTP_HOST || '').trim();
  const resend = String(process.env.RESEND_API_KEY || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS == null ? '' : String(process.env.SMTP_PASS);
  let port = Number(process.env.SMTP_PORT || 0);
  if (!port) port = 587;
  const portOk = Number.isInteger(port) && port >= 1 && port <= 65535;
  const hostOk = !!host && host.length <= 200 && !/[\s/\\]/.test(host);
  let transport = '';
  let configured = false;
  let problem = 'Manca il mittente: imposta SMTP_HOST, SMTP_PORT e SMTP_FROM (e SMTP_USER con SMTP_PASS se il server li chiede). In alternativa RESEND_API_KEY e SMTP_FROM, senza SMTP_HOST.';
  if (host) {
    if (!hostOk) problem = 'SMTP_HOST non è un nome host valido.';
    else if (!portOk) problem = 'SMTP_PORT non è una porta valida.';
    else if (!from) problem = 'SMTP_HOST è impostato ma SMTP_FROM manca o non è un indirizzo valido.';
    else if (user && !pass) problem = 'SMTP_USER è impostato ma manca SMTP_PASS.';
    else {
      transport = 'smtp';
      configured = true;
      problem = '';
    }
  } else if (resend) {
    if (!from) problem = 'RESEND_API_KEY è impostata ma SMTP_FROM manca o non è un indirizzo valido.';
    else {
      transport = 'resend';
      configured = true;
      problem = '';
    }
  }
  let reason = '';
  if (!flag && !configured) {
    reason = 'La stampa via email è spenta. Per attivarla imposta PRINT_CLOUD_ENABLED=1 e un mittente: SMTP_HOST, SMTP_PORT e SMTP_FROM (più SMTP_USER e SMTP_PASS se il server li chiede), oppure RESEND_API_KEY e SMTP_FROM.';
  } else if (!flag) {
    reason = 'Il mittente è configurato, ma manca PRINT_CLOUD_ENABLED=1. Senza questo flag la stampa via email resta spenta.';
  } else if (!configured) {
    reason = 'PRINT_CLOUD_ENABLED=1 è attivo, ma il mittente non è completo. ' + problem;
  }
  const mode = transport === 'smtp' ? secureMode(port) : '';
  return {
    flag,
    configured,
    enabled: flag && configured,
    transport,
    secure: mode,
    host: transport === 'smtp' ? host : '',
    port: transport === 'smtp' ? port : null,
    user: transport === 'smtp' ? user : '',
    from: from ? from.header : '',
    address: from ? from.email : '',
    reason,
  };
}

function headerFilename(name) {
  let base = String(name || 'documento.pdf').replace(/[^\w.\- ()]/g, '_').replace(/\s+/g, ' ').trim();
  if (!base) base = 'documento.pdf';
  if (base.length > 120) base = base.slice(-120);
  if (!base.toLowerCase().endsWith('.pdf')) base += '.pdf';
  return base;
}

function wrapBase64(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1\r\n');
}

function dotStuff(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  return text.split('\r\n').map((line) => (line.startsWith('.') ? '.' + line : line)).join('\r\n');
}

function buildRawMessage({ from, to, filename, pdf, subject, messageId }) {
  const fromBox = mailbox(from);
  const toBox = mailbox(to);
  if (!fromBox) throw fail(500, 'Mittente email non valido');
  if (!toBox) throw fail(400, 'Indirizzo email della stampante non valido');
  if (!Buffer.isBuffer(pdf) || !pdf.length) throw fail(400, 'PDF mancante');
  const boundary = 'bl-' + crypto.randomBytes(12).toString('hex');
  const file = headerFilename(filename);
  const sub = String(subject || 'Stampa').replace(/[\r\n]+/g, ' ').trim() || 'Stampa';
  const id = messageId || ('<' + crypto.randomBytes(12).toString('hex') + '@baseluna>');
  const date = new Date().toUTCString().replace(/GMT$/, '+0000');
  const headers = [
    'From: ' + fromBox.header,
    'To: ' + toBox.email,
    'Subject: ' + sub,
    'Date: ' + date,
    'Message-ID: ' + id,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="' + boundary + '"',
  ];
  const parts = [
    '--' + boundary,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    '--' + boundary,
    'Content-Type: application/pdf; name="' + file + '"',
    'Content-Disposition: attachment; filename="' + file + '"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(pdf),
    '',
    '--' + boundary + '--',
    '',
  ];
  const raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n');
  return { raw, messageId: id, filename: file, to: toBox.email, from: fromBox.email };
}

function createReader(socket) {
  let buf = '';
  let pending = null;
  let failed = null;
  const pump = () => {
    if (!pending || failed) return;
    let consumed = 0;
    const lines = [];
    while (consumed < buf.length) {
      const idx = buf.indexOf('\r\n', consumed);
      if (idx < 0) break;
      const line = buf.slice(consumed, idx);
      consumed = idx + 2;
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        buf = buf.slice(consumed);
        const done = pending;
        pending = null;
        done.resolve({ code: Number(line.slice(0, 3)), lines });
        return;
      }
    }
  };
  const onData = (chunk) => {
    if (failed) return;
    buf += chunk.toString('latin1');
    pump();
  };
  const onError = (err) => {
    failed = err;
    if (pending) {
      const done = pending;
      pending = null;
      done.reject(err);
    }
  };
  const onClose = () => {
    if (failed) return;
    failed = new Error('connessione SMTP chiusa');
    if (pending) {
      const done = pending;
      pending = null;
      done.reject(failed);
    }
  };
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    readReply() {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        pump();
      });
    },
    detach() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    },
  };
}

function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const failOnce = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', failOnce);
    socket.once('connect', () => {
      socket.off('error', failOnce);
      resolve(socket);
    });
  });
}

function connectTls(host, port, socket) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect(socket ? { socket, servername: host } : { host, port, servername: host });
    const failOnce = (err) => {
      secure.destroy();
      reject(err);
    };
    secure.once('error', failOnce);
    secure.once('secureConnect', () => {
      secure.off('error', failOnce);
      resolve(secure);
    });
  });
}

function writeAll(socket, data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
  return new Promise((resolve, reject) => {
    socket.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

function publicSmtpError(err) {
  const msg = String((err && err.message) || 'errore SMTP').replace(/[\r\n]+/g, ' ').slice(0, 240);
  if (/535|auth|password|credential/i.test(msg)) {
    return 'Il server di posta ha rifiutato il mittente. Controlla SMTP_USER, SMTP_PASS e SMTP_FROM.';
  }
  return 'Invio email non riuscito: ' + msg;
}

async function sendViaSmtp({ host, port, secure, user, pass, from, to, filename, pdf }) {
  const built = buildRawMessage({ from, to, filename, pdf });
  const mode = secure || 'starttls';
  let socket = null;
  let reader = { detach() {} };
  const expect = async (codes) => {
    const ok = Array.isArray(codes) ? codes : [codes];
    const reply = await reader.readReply();
    if (!ok.includes(reply.code)) {
      const err = new Error('SMTP ' + reply.code + ' ' + reply.lines.join(' | '));
      err.smtp = reply;
      throw err;
    }
    return reply;
  };
  const cmd = async (line, codes) => {
    await writeAll(socket, line + '\r\n');
    return expect(codes);
  };
  try {
    socket = mode === 'tls' ? await connectTls(host, port) : await connectPlain(host, port);
    socket.setTimeout(20000, () => socket.destroy(new Error('tempo scaduto')));
    reader = createReader(socket);
    await expect(220);
    let ehlo = await cmd('EHLO baseluna', 250);
    if (mode === 'starttls') {
      if (!ehlo.lines.some((line) => /STARTTLS/i.test(line))) {
        throw new Error('Il server SMTP non offre STARTTLS. Per un relay locale senza cifratura imposta SMTP_SECURE=plain.');
      }
      await cmd('STARTTLS', 220);
      reader.detach();
      socket.setTimeout(0);
      socket = await connectTls(host, port, socket);
      socket.setTimeout(20000, () => socket.destroy(new Error('tempo scaduto')));
      reader = createReader(socket);
      ehlo = await cmd('EHLO baseluna', 250);
    }
    if (user) {
      const token = Buffer.from('\0' + user + '\0' + String(pass || ''), 'utf8').toString('base64');
      await writeAll(socket, 'AUTH PLAIN ' + token + '\r\n');
      const auth = await reader.readReply();
      if (auth.code === 334) {
        await writeAll(socket, token + '\r\n');
        const next = await reader.readReply();
        if (next.code !== 235) throw new Error('SMTP ' + next.code + ' ' + next.lines.join(' | '));
      } else if (auth.code !== 235) {
        throw new Error('SMTP ' + auth.code + ' ' + auth.lines.join(' | '));
      }
    }
    await cmd('MAIL FROM:<' + built.from + '>', 250);
    await cmd('RCPT TO:<' + built.to + '>', [250, 251]);
    await cmd('DATA', 354);
    await writeAll(socket, dotStuff(built.raw) + '\r\n.\r\n');
    const accepted = await expect(250);
    const messageId = (accepted.lines.join(' ') || built.messageId).slice(0, 200);
    try { await cmd('QUIT', [221, 250]); } catch { /* la mail è già accettata */ }
    return { messageId, transport: 'smtp' };
  } catch (err) {
    if (err && err.expose) throw err;
    throw fail(502, publicSmtpError(err));
  } finally {
    reader.detach();
    if (socket) socket.destroy();
  }
}

async function sendViaResend({ apiKey, from, to, filename, pdf, fetchImpl }) {
  const built = buildRawMessage({ from, to, filename, pdf });
  const fetchFn = fetchImpl || fetch;
  let res;
  try {
    res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailbox(from).header,
        to: [built.to],
        subject: 'Stampa',
        text: ' ',
        attachments: [{ filename: built.filename, content: pdf.toString('base64') }],
      }),
    });
  } catch (err) {
    throw fail(502, 'Invio email non riuscito: ' + String(err.message || err).slice(0, 180));
  }
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  if (!res.ok) {
    const detail = (json && (json.message || json.error || json.name)) || text.slice(0, 180);
    throw fail(502, 'Invio email non riuscito: ' + String(detail).replace(/[\r\n]+/g, ' ').slice(0, 180));
  }
  return { messageId: String(json.id || built.messageId).slice(0, 200), transport: 'resend' };
}

async function sendPdf({ to, filename, pdf, fetchImpl }) {
  const cfg = describe();
  if (!cfg.enabled) throw fail(400, cfg.reason || 'Stampa via email non attiva');
  const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf || []);
  if (cfg.transport === 'resend') {
    return sendViaResend({
      apiKey: String(process.env.RESEND_API_KEY || '').trim(),
      from: cfg.from,
      to,
      filename,
      pdf: bytes,
      fetchImpl,
    });
  }
  return sendViaSmtp({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    pass: process.env.SMTP_PASS == null ? '' : String(process.env.SMTP_PASS),
    from: cfg.from,
    to,
    filename,
    pdf: bytes,
  });
}

module.exports = {
  mailbox,
  isEmail,
  describe,
  headerFilename,
  dotStuff,
  buildRawMessage,
  sendViaSmtp,
  sendViaResend,
  sendPdf,
  publicSmtpError,
};
