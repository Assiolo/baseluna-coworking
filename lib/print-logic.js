const PROTOCOLS = ['ipp', 'raw', 'cups'];
const FORMATS = ['A4', 'A3'];
const STATUSES = ['in coda', 'in stampa', 'invio al cloud', 'inviata al cloud', 'completata', 'errore', 'rimborsata'];
const OPEN_STATUSES = ['in coda', 'in stampa', 'invio al cloud', 'inviata al cloud'];
const QUOTA_STATUSES = ['in coda', 'in stampa', 'invio al cloud', 'inviata al cloud', 'completata'];
const CLOUD_PROVIDERS = {
  epson: { label: 'Epson Connect', duplex: false, maxBytes: 15 * 1024 * 1024 },
  hp: { label: 'HP ePrint', duplex: true, maxBytes: 6 * 1024 * 1024 },
  other: { label: '', duplex: true, maxBytes: 6 * 1024 * 1024 },
};
const ONLINE_MS = 90 * 1000;
const EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

function eurosToCents(value, label) {
  const raw = (typeof value === 'string' ? value.replace(',', '.') : String(value)).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw fail(400, (label || 'Importo') + ' non valido');
  const [whole, frac = ''] = raw.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents) || cents > 10000000) throw fail(400, (label || 'Importo') + ' troppo alto');
  return cents;
}

function optionalEuros(value, label) {
  if (value == null || value === '') return null;
  return eurosToCents(value, label);
}

function formatEuro(cents) {
  const n = (Number(cents) || 0) / 100;
  return n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
}

function slugAgent(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(s)) {
    throw fail(400, 'ID agente non valido: usa lettere, numeri, punto o trattino (max 80)');
  }
  return s;
}

function normalizeHost(host) {
  const s = String(host || '').trim();
  if (!s) return '';
  if (s.length > 200 || /[\s/\\]/.test(s)) throw fail(400, 'Host o IP non valido');
  return s;
}

function isEmailAddress(value) {
  const email = String(value || '').trim();
  return email.length > 3 && email.length <= 200 && EMAIL_RE.test(email) && !/[\r\n\s]/.test(email);
}

function connectionTypeOf(row) {
  const raw = String((row && (row.connectionType || row.connection_type)) || '').trim().toLowerCase();
  if (raw === 'cloud' || raw === 'email') return 'cloud';
  if (raw === 'agent' || raw === 'agente' || raw === 'locale') return 'agent';
  if (row && row.protocol === 'cloud') return 'cloud';
  return 'agent';
}

function isCloud(row) {
  return connectionTypeOf(row) === 'cloud';
}

function cloudProviderOf(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'epson' || raw === 'epson connect') return 'epson';
  if (raw === 'hp' || raw === 'hp eprint' || raw === 'eprint') return 'hp';
  if (raw === 'other' || raw === 'altro') return 'other';
  return '';
}

function cloudMaxBytes(provider) {
  const known = CLOUD_PROVIDERS[provider] || CLOUD_PROVIDERS.other;
  return known.maxBytes;
}

function targetReady(row) {
  if (isCloud(row)) return isEmailAddress(row.cloudEmail || row.cloud_email || '');
  if (row.uri && String(row.uri).trim()) return true;
  if (row.protocol === 'cups' && row.queue && String(row.queue).trim()) return true;
  if ((row.protocol === 'ipp' || row.protocol === 'raw') && row.host && String(row.host).trim()) return true;
  return false;
}

function buildConnectionUri(row) {
  if (row.uri && String(row.uri).trim()) return String(row.uri).trim();
  if (row.protocol === 'cups') return row.queue ? 'cups://' + row.queue : '';
  if (row.protocol === 'raw') {
    if (!row.host) return '';
    return 'socket://' + row.host + ':' + (row.port || 9100);
  }
  if (row.protocol === 'ipp') {
    if (!row.host) return '';
    const queue = (row.queue && String(row.queue).trim()) || 'ipp/print';
    return 'ipp://' + row.host + ':' + (row.port || 631) + '/' + queue.replace(/^\//, '');
  }
  return '';
}

function isOnline(iso, now = Date.now()) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t < ONLINE_MS && now - t > -5000;
}

function parsePageRange(input, pageCount) {
  const total = Number(pageCount);
  if (!Number.isInteger(total) || total < 1) throw fail(400, 'Documento senza pagine');
  const raw = String(input || '').trim();
  if (!raw) return Array.from({ length: total }, (_, i) => i + 1);
  if (!/^[\d\s,\-]+$/.test(raw)) throw fail(400, 'Intervallo pagine non valido. Esempio: 1-3,5');
  const set = new Set();
  for (const part of raw.split(',')) {
    const bit = part.trim();
    if (!bit) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(bit);
    if (!m) throw fail(400, 'Intervallo pagine non valido. Esempio: 1-3,5');
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (a < 1 || b < 1 || a > total || b > total || a > b) {
      throw fail(400, 'L\'intervallo esce dal documento (' + total + (total === 1 ? ' pagina' : ' pagine') + ')');
    }
    for (let i = a; i <= b; i++) set.add(i);
  }
  if (!set.size) throw fail(400, 'Seleziona almeno una pagina');
  return [...set].sort((x, y) => x - y);
}

function effectiveUnitCents(settings, printer, { color, duplex }) {
  const pick = (override, fallback) => (override == null ? fallback : override);
  if (duplex && color) return pick(printer.duplexColorCents, settings.duplexColorCents);
  if (duplex) return pick(printer.duplexBwCents, settings.duplexBwCents);
  if (color) return pick(printer.colorCents, settings.colorCents);
  return pick(printer.bwCents, settings.bwCents);
}

function quoteCost(settings, printer, { pagesSelected, copies, color, duplex }) {
  const unitCents = effectiveUnitCents(settings, printer, { color, duplex });
  const impressions = pagesSelected * copies;
  return { unitCents, impressions, costCents: unitCents * impressions };
}

function asBool(value, label) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw fail(400, label + ' non valido');
}

function validateOptions({ copies, color, duplex, format, pageRange, pageCount, printer, settings }) {
  const nCopies = Number(copies);
  if (!Number.isInteger(nCopies) || nCopies < 1 || nCopies > settings.maxCopies) {
    throw fail(400, 'Numero di copie non valido (1–' + settings.maxCopies + ')');
  }
  let wantColor = asBool(color, 'Colore');
  let wantDuplex = asBool(duplex, 'Fronte/retro');
  let fmt = String(format || 'A4').toUpperCase();
  if (isCloud(printer)) {
    wantColor = !!printer.supportsColor;
    wantDuplex = !!printer.supportsDuplex && printer.cloudProvider !== 'epson';
    fmt = printer.formats[0] || 'A4';
  }
  if (!FORMATS.includes(fmt) || !printer.formats.includes(fmt)) {
    throw fail(400, 'Formato non disponibile su questa stampante');
  }
  if (wantColor && !printer.supportsColor) throw fail(400, 'Questa stampante non stampa a colori');
  if (wantDuplex && !printer.supportsDuplex) throw fail(400, 'Questa stampante non fa fronte/retro');
  const pages = parsePageRange(pageRange, pageCount);
  if (pages.length * nCopies > settings.maxPages) {
    throw fail(400, 'Troppe pagine in un solo lavoro (massimo ' + settings.maxPages + ')');
  }
  const cost = quoteCost(settings, printer, {
    pagesSelected: pages.length,
    copies: nCopies,
    color: wantColor,
    duplex: wantDuplex,
  });
  return {
    copies: nCopies,
    color: wantColor,
    duplex: wantDuplex,
    format: fmt,
    pages,
    pageRange: String(pageRange || '').trim(),
    ...cost,
  };
}

function cleanNotes(value) {
  return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, 500);
}

function cloudFields(input) {
  const provider = cloudProviderOf(input.cloudProvider);
  const email = String(input.cloudEmail || '').trim().toLowerCase();
  let label = String(input.cloudLabel || '').trim();
  if (provider === 'epson') label = CLOUD_PROVIDERS.epson.label;
  else if (provider === 'hp') label = CLOUD_PROVIDERS.hp.label;
  if (label.length > 80) throw fail(400, 'Nome del servizio troppo lungo');
  return { provider, email, label, notes: cleanNotes(input.cloudNotes) };
}

function validatePrinter(input) {
  const name = String((input && input.name) || '').trim();
  if (name.length < 1 || name.length > 80) throw fail(400, 'Nome stampante: da 1 a 80 caratteri');
  const location = String(input.location || '').trim();
  if (location.length > 120) throw fail(400, 'Posizione troppo lunga');
  const connectionType = connectionTypeOf({
    connectionType: input.connectionType != null && String(input.connectionType).trim() !== ''
      ? input.connectionType
      : 'agent',
  });
  if (input.connectionType != null && String(input.connectionType).trim() !== '' && !['agent', 'cloud', 'email', 'agente', 'locale'].includes(String(input.connectionType).trim().toLowerCase())) {
    throw fail(400, 'Tipo di collegamento non valido: scegli agente locale o cloud del produttore');
  }
  if (connectionType === 'cloud') return validateCloudPrinter(input, { name, location });
  const protocol = String(input.protocol || '').toLowerCase();
  if (!PROTOCOLS.includes(protocol)) throw fail(400, 'Protocollo non valido: scegli IPP, raw 9100 o CUPS');
  const host = normalizeHost(input.host);
  let port = input.port;
  if (port === '' || port == null) port = null;
  else {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, 'Porta non valida');
  }
  const uri = String(input.uri || '').trim();
  if (uri.length > 300 || /[\s\u0000]/.test(uri)) throw fail(400, 'URI non valido');
  if (uri && /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^(ipp|ipps|socket|lpd|cups):/i.test(uri)) {
    throw fail(400, 'URI non supportato: usa ipp://, ipps://, socket:// oppure lascia vuoto e indica host o coda');
  }
  const queue = String(input.queue || '').trim();
  if (queue.length > 120 || /[\u0000]/.test(queue) || /\s/.test(queue)) throw fail(400, 'Nome coda non valido');
  const agentId = slugAgent(input.agentId);
  let formats = input.formats;
  if (typeof formats === 'string') formats = formats.split(',');
  if (!Array.isArray(formats) || !formats.length) formats = ['A4'];
  formats = [...new Set(formats.map((f) => String(f).trim().toUpperCase()).filter(Boolean))];
  if (!formats.length || formats.some((f) => !FORMATS.includes(f))) throw fail(400, 'Formati ammessi: A4 e A3');
  const row = {
    name,
    location,
    protocol,
    uri,
    host,
    port,
    queue,
    supports_color: !!input.supportsColor,
    supports_duplex: !!input.supportsDuplex,
    formats: formats.join(','),
    bw_cents: optionalEuros(input.priceBw, 'Prezzo B/N'),
    color_cents: optionalEuros(input.priceColor, 'Prezzo colore'),
    duplex_bw_cents: optionalEuros(input.priceDuplexBw, 'Prezzo fronte/retro B/N'),
    duplex_color_cents: optionalEuros(input.priceDuplexColor, 'Prezzo fronte/retro colore'),
    agent_id: agentId,
    enabled: !!input.enabled,
    visible: !!input.visible,
    is_default: !!input.isDefault,
    connection_type: 'agent',
    cloud_email: '',
    cloud_provider: '',
    cloud_label: '',
    cloud_notes: '',
  };
  if (row.enabled && !targetReady(row)) {
    throw fail(400, 'Per abilitare la stampante indica un IP, un URI o il nome della coda CUPS. Puoi salvarla disabilitata finché la stampante non c\'è.');
  }
  return finishPrinter(row);
}

function validateCloudPrinter(input, { name, location }) {
  const cloud = cloudFields(input);
  if (!cloud.provider) throw fail(400, 'Scegli il servizio: Epson Connect, HP ePrint o altro');
  if (cloud.provider === 'other' && cloud.label.length < 1) throw fail(400, 'Indica il nome del servizio');
  if (cloud.email && !isEmailAddress(cloud.email)) throw fail(400, 'Indirizzo email della stampante non valido');
  if (input.supportsDuplex && cloud.provider === 'epson') {
    throw fail(400, 'Epson Connect Email Print stampa solo fronte: il fronte/retro non si può attivare da qui.');
  }
  const host = normalizeHost(input.host);
  let port = input.port;
  if (port === '' || port == null) port = null;
  else {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(400, 'Porta non valida');
  }
  const uri = String(input.uri || '').trim();
  if (uri.length > 300 || /[\s\u0000]/.test(uri)) throw fail(400, 'URI non valido');
  if (uri && /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^(ipp|ipps|socket|lpd|cups):/i.test(uri)) {
    throw fail(400, 'URI non supportato: usa ipp://, ipps://, socket:// oppure lascia vuoto e indica host o coda');
  }
  const queue = String(input.queue || '').trim();
  if (queue.length > 120 || /[\u0000]/.test(queue) || /\s/.test(queue)) throw fail(400, 'Nome coda non valido');
  const agentId = slugAgent(input.agentId);
  let protocol = String(input.protocol || '').toLowerCase();
  if (!PROTOCOLS.includes(protocol)) protocol = 'ipp';
  let formats = input.formats;
  if (typeof formats === 'string') formats = formats.split(',');
  if (!Array.isArray(formats) || !formats.length) formats = ['A4'];
  formats = [...new Set(formats.map((f) => String(f).trim().toUpperCase()).filter(Boolean))];
  if (!formats.length || formats.some((f) => !FORMATS.includes(f))) throw fail(400, 'Formati ammessi: A4 e A3');
  if (formats.length !== 1) {
    throw fail(400, 'Per la stampa via email scegli un solo formato, A4 oppure A3: la carta la imposta il servizio cloud, non il singolo lavoro.');
  }
  const row = {
    name,
    location,
    protocol,
    uri,
    host,
    port,
    queue,
    supports_color: !!input.supportsColor,
    supports_duplex: !!input.supportsDuplex,
    formats: formats.join(','),
    bw_cents: optionalEuros(input.priceBw, 'Prezzo B/N'),
    color_cents: optionalEuros(input.priceColor, 'Prezzo colore'),
    duplex_bw_cents: optionalEuros(input.priceDuplexBw, 'Prezzo fronte/retro B/N'),
    duplex_color_cents: optionalEuros(input.priceDuplexColor, 'Prezzo fronte/retro colore'),
    agent_id: agentId,
    enabled: !!input.enabled,
    visible: !!input.visible,
    is_default: !!input.isDefault,
    connection_type: 'cloud',
    cloud_email: cloud.email,
    cloud_provider: cloud.provider,
    cloud_label: cloud.label,
    cloud_notes: cloud.notes,
  };
  if (row.enabled && !targetReady(row)) {
    throw fail(400, 'Per abilitare la stampante cloud indica l\'indirizzo email del servizio, per esempio nome@print.epsonconnect.com.');
  }
  return finishPrinter(row);
}

function finishPrinter(row) {
  if (row.visible && !row.enabled) throw fail(400, 'Per mostrarla ai membri devi abilitarla.');
  if (row.is_default && (!row.enabled || !row.visible)) {
    throw fail(400, 'La stampante predefinita deve essere abilitata e visibile ai membri.');
  }
  return row;
}

function safeFilename(raw) {
  let name = String(raw || '');
  try { name = decodeURIComponent(name); } catch { /* keep raw */ }
  name = name.replace(/[/\\]/g, ' ').replace(/[\u0000-\u001f]/g, '').trim();
  if (!name) name = 'documento.pdf';
  if (name.length > 180) name = name.slice(-180);
  return name;
}

function memberCanUse(printer) {
  return !!(printer && printer.enabled && printer.visible && targetReady(printer));
}

module.exports = {
  PROTOCOLS,
  FORMATS,
  STATUSES,
  OPEN_STATUSES,
  QUOTA_STATUSES,
  CLOUD_PROVIDERS,
  ONLINE_MS,
  fail,
  eurosToCents,
  optionalEuros,
  formatEuro,
  slugAgent,
  isEmailAddress,
  connectionTypeOf,
  isCloud,
  cloudProviderOf,
  cloudMaxBytes,
  targetReady,
  buildConnectionUri,
  isOnline,
  parsePageRange,
  effectiveUnitCents,
  quoteCost,
  validateOptions,
  validatePrinter,
  safeFilename,
  memberCanUse,
};
