(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const euro = (cents) => ((Number(cents) || 0) / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });
  const when = (iso) => iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '';
  let gen = 0;
  let poll = null;
  let upload = null;
  let colorOn = false;
  let duplexOn = false;
  const filters = { userId: '', status: '', printerId: '', from: '', to: '' };
  let editing = null;

  function stop() { if (poll) clearInterval(poll); poll = null; }

  async function apiJson(url, opts) {
    const res = await fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: { 'content-type': 'application/json', ...((opts && opts.headers) || {}) },
      body: opts && opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    if (!res.ok) throw new Error(json.error || 'Errore');
    return json;
  }

  function pill(status) {
    const cls = status === 'completata' ? '' : status === 'in stampa' ? 'warn' : status === 'errore' ? 'bad' : 'off';
    return `<span class="pill ${cls}">${esc(status)}</span>`;
  }

  function quotaLine(q) {
    if (!q || q.limit == null) return 'Nessun tetto di pagine questo mese' + (q ? ' · usate ' + q.used : '');
    return q.used + ' / ' + q.limit + ' pagine questo mese';
  }

  function jobRows(jobs, admin) {
    if (!jobs.length) return `<tr><td colspan="${admin ? 8 : 7}">Nessun lavoro</td></tr>`;
    return jobs.map((j) => `<tr>
      <td>${esc(when(j.createdAt))}</td>
      ${admin ? `<td>${esc(j.userName || '')}<br><small style="color:var(--g)">${esc(j.userEmail || '')}</small></td>` : ''}
      <td>${esc(j.filename)}</td>
      <td>${esc(j.printerName || '—')}</td>
      <td>${j.pagesSelected}×${j.copies}${j.pageRange ? ' · ' + esc(j.pageRange) : ''}<br><small style="color:var(--g)">${j.color ? 'colore' : 'b/n'} · ${j.duplex ? 'fronte/retro' : 'fronte'} · ${esc(j.format)}</small></td>
      <td>${euro(j.actualCostCents != null && j.status === 'completata' ? j.actualCostCents : j.costCents)}${j.unbilledCents ? `<br><small class="err">non addebitate ${euro(j.unbilledCents)}</small>` : ''}</td>
      <td>${pill(j.status)}${j.error ? `<br><small style="color:var(--g)">${esc(j.error)}</small>` : ''}</td>
      <td class="print-actions">${j.status === 'in coda' && !admin ? `<button class="btn sm ghost" data-cancel="${esc(j.id)}">Annulla</button>` : ''}${admin && j.status !== 'rimborsata' ? `<button class="btn sm ghost" data-refund="${esc(j.id)}">Rimborsa</button>` : ''}<a class="btn sm ghost" href="/api/print/jobs/${encodeURIComponent(j.id)}/file" target="_blank" rel="noopener">PDF</a></td>
    </tr>`).join('');
  }

  function ledgerRows(rows) {
    if (!rows.length) return '<tr><td colspan="4">Nessun movimento</td></tr>';
    return rows.map((r) => `<tr><td>${esc(when(r.createdAt))}</td><td>${esc(r.kind)}</td><td>${esc(r.note || '')}</td><td>${r.amountCents > 0 ? '+' : ''}${euro(r.amountCents)}</td></tr>`).join('');
  }

  async function member() {
    const my = ++gen;
    stop();
    const box = $('#m');
    box.innerHTML = '<h1>Stampa</h1><p class="sub">Carico il credito e le stampanti…</p>';
    let flash = '';
    try { flash = sessionStorage.getItem('print-flash') || ''; sessionStorage.removeItem('print-flash'); } catch (e) { /* ignore */ }
    let data;
    try { data = await apiJson('/api/print/me'); } catch (err) {
      box.innerHTML = `<h1>Stampa</h1><p class="err">${esc(err.message)}</p>`;
      return;
    }
    if (my !== gen) return;
    paintMember(data, flash);
    const active = (data.jobs || []).some((j) => j.status === 'in coda' || j.status === 'in stampa');
    if (active || /Pagamento ricevuto/.test(flash)) {
      let n = 0;
      poll = setInterval(async () => {
        if (my !== gen || !$('#print-root')) return stop();
        n++;
        try {
          const fresh = await apiJson('/api/print/me');
          const bal = $('#print-balance');
          if (bal) bal.textContent = euro(fresh.balanceCents);
          const q = $('#print-quota');
          if (q) q.textContent = quotaLine(fresh.quota);
          const body = $('#print-jobs');
          if (body) {
            body.innerHTML = jobRows(fresh.jobs, false);
            bindMemberJobs();
          }
          const led = $('#print-ledger');
          if (led) led.innerHTML = ledgerRows(fresh.ledger);
          if (!(fresh.jobs || []).some((j) => j.status === 'in coda' || j.status === 'in stampa') && n > 2) stop();
        } catch (e) { /* il prossimo giro riprova */ }
      }, 4000);
    }
  }

  function paintMember(data, flash) {
    upload = null;
    colorOn = false;
    duplexOn = false;
    const printers = data.printers || [];
    const stripe = data.stripe && data.stripe.enabled;
    const empty = !printers.length;
    $('#m').innerHTML = `<div id="print-root">
      <h1>Stampa</h1>
      <p class="sub">Carica un documento e stampalo in studio. Il credito si scala all’invio e torna indietro se il lavoro fallisce o lo annulli mentre è in coda.</p>
      ${flash ? `<p class="ok" id="print-flash">${esc(flash)}</p>` : ''}
      <div class="print-grid">
        <section class="glass card">
          <p class="kick">Credito</p>
          <b class="print-euro" id="print-balance">${euro(data.balanceCents)}</b>
          <p class="sub" id="print-quota">${esc(quotaLine(data.quota))}</p>
          ${stripe ? `<div class="print-actions" id="print-topup">${[5, 10, 20, 50].map((n) => `<button class="btn sm" data-euro="${n}">Ricarica ${n} €</button>`).join('')}</div><p class="print-help">Paghi con carta tramite Stripe. Il credito compare dopo la conferma.</p>` : `<p class="print-help">Per aggiungere credito passa in reception: lo staff lo registra dal pannello. La ricarica online non è attiva.</p>`}
        </section>
        <section class="glass card">
          <h2>Movimenti</h2>
          <div class="table-wrap"><table><tr><th>Quando</th><th>Tipo</th><th>Nota</th><th>Importo</th></tr><tbody id="print-ledger">${ledgerRows(data.ledger || [])}</tbody></table></div>
        </section>
      </div>
      ${empty ? `<section class="glass card print-guide"><p class="kick">Stampanti</p><h2 class="print-title">Nessuna stampante disponibile</h2><p>Lo studio non ha ancora attivato una stampante condivisa. Quando sarà pronta potrai scegliere dove stampare da questa pagina. Il credito resta intanto al sicuro.</p></section>` : formHtml(data)}
      <section class="glass card">
        <h2>I tuoi lavori</h2>
        <div class="table-wrap"><table><tr><th>Quando</th><th>File</th><th>Stampante</th><th>Pagine</th><th>Costo</th><th>Stato</th><th></th></tr><tbody id="print-jobs">${jobRows(data.jobs || [], false)}</tbody></table></div>
      </section>
    </div>`;
    bindMember(data);
  }

  function formHtml(data) {
    const opts = data.printers.map((p) => `<option value="${esc(p.id)}"${p.id === data.defaultPrinterId ? ' selected' : ''}>${esc(p.name)}${p.location ? ' · ' + esc(p.location) : ''} · ${p.online ? 'in linea' : 'offline'}</option>`).join('');
    return `<section class="glass card" id="print-form">
      <h2>Nuovo lavoro</h2>
      <label class="print-drop" id="print-drop"><input id="print-file" type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,image/png,image/jpeg,image/webp"><b>Trascina un PDF, un’immagine o un file Office</b><span>Massimo ${Math.round(data.settings.maxUploadBytes / (1024 * 1024))} MB · l’anteprima mostra le pagine</span></label>
      <div class="print-preview" id="print-preview" hidden>
        <iframe id="print-frame" title="Anteprima"></iframe>
        <div><b id="print-file-name"></b><p class="sub" id="print-pages"></p></div>
      </div>
      <div class="print-form">
        <div><label>Stampante</label><select id="print-printer">${opts}</select></div>
        <div><label>Copie</label><input id="print-copies" type="number" min="1" max="${data.settings.maxCopies}" value="1"></div>
        <div class="full"><label>Colore</label><div class="seg" id="print-color"><button type="button" data-color="0" class="on">Bianco e nero</button><button type="button" data-color="1">Colore</button></div></div>
        <div class="full"><label>Lati</label><div class="seg" id="print-duplex"><button type="button" data-duplex="0" class="on">Solo fronte</button><button type="button" data-duplex="1">Fronte/retro</button></div><p class="print-help">Il prezzo fronte/retro è per facciata.</p></div>
        <div><label>Formato</label><select id="print-format"></select></div>
        <div><label>Pagine</label><input id="print-range" placeholder="Tutte, oppure 1-3,5"></div>
      </div>
      <div class="sum"><div><div class="price" id="print-cost">—</div><p class="sub" id="print-cost-note">Scegli il file per vedere il costo.</p></div><button class="btn" id="print-go" disabled>Stampa</button></div>
      <p class="err" id="print-err"></p>
    </section>`;
  }

  function selectedPrinter(data) {
    const id = $('#print-printer') && $('#print-printer').value;
    return (data.printers || []).find((p) => p.id === id) || null;
  }

  function syncCaps(data) {
    const p = selectedPrinter(data);
    if (!p) return;
    const colorBtn = document.querySelector('#print-color [data-color="1"]');
    const dupBtn = document.querySelector('#print-duplex [data-duplex="1"]');
    if (colorBtn) colorBtn.disabled = !p.supportsColor;
    if (dupBtn) dupBtn.disabled = !p.supportsDuplex;
    if (!p.supportsColor && colorOn) setColor(false);
    if (!p.supportsDuplex && duplexOn) setDuplex(false);
    const fmt = $('#print-format');
    if (!fmt) return;
    const prev = fmt.value;
    fmt.innerHTML = p.formats.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    if (p.formats.includes(prev)) fmt.value = prev;
  }

  function setColor(on) {
    colorOn = !!on;
    document.querySelectorAll('#print-color button').forEach((b) => b.classList.toggle('on', (b.dataset.color === '1') === colorOn));
  }
  function setDuplex(on) {
    duplexOn = !!on;
    document.querySelectorAll('#print-duplex button').forEach((b) => b.classList.toggle('on', (b.dataset.duplex === '1') === duplexOn));
  }

  function bindMember(data) {
    document.querySelectorAll('[data-euro]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const r = await apiJson('/api/print/checkout', { method: 'POST', body: { euros: Number(b.dataset.euro) } });
          if (r.url) location.href = r.url;
        } catch (err) {
          b.disabled = false;
          alert(err.message);
        }
      };
    });
    bindMemberJobs();
    if (!$('#print-file')) return;
    syncCaps(data);
    const drop = $('#print-drop');
    const input = $('#print-file');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) sendFile(f, data); });
    input.onchange = () => { if (input.files[0]) sendFile(input.files[0], data); };
    $('#print-printer').onchange = () => { syncCaps(data); refreshQuote(data); };
    $('#print-copies').oninput = () => refreshQuote(data);
    $('#print-range').oninput = () => refreshQuote(data);
    $('#print-format').onchange = () => refreshQuote(data);
    document.querySelectorAll('#print-color button').forEach((b) => { b.onclick = () => { if (b.disabled) return; setColor(b.dataset.color === '1'); refreshQuote(data); }; });
    document.querySelectorAll('#print-duplex button').forEach((b) => { b.onclick = () => { if (b.disabled) return; setDuplex(b.dataset.duplex === '1'); refreshQuote(data); }; });
    $('#print-go').onclick = () => submit(data);
  }

  function bindMemberJobs() {
    document.querySelectorAll('[data-cancel]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Annullare questo lavoro e rimborsare il credito?')) return;
        try { await apiJson('/api/print/jobs/' + b.dataset.cancel + '/cancel', { method: 'POST', body: {} }); member(); }
        catch (err) { alert(err.message); }
      };
    });
  }

  async function sendFile(file, data) {
    const err = $('#print-err');
    err.textContent = 'Carico il file…';
    $('#print-go').disabled = true;
    try {
      const res = await fetch('/api/print/uploads', {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Caricamento non riuscito');
      upload = json;
      $('#print-preview').hidden = false;
      $('#print-frame').src = '/api/print/uploads/' + encodeURIComponent(json.id) + '/file';
      $('#print-file-name').textContent = json.filename;
      $('#print-pages').textContent = json.pageCount + (json.pageCount === 1 ? ' pagina' : ' pagine');
      err.textContent = '';
      refreshQuote(data);
    } catch (e) {
      upload = null;
      err.textContent = e.message;
    }
  }

  let quoteTimer = null;
  function refreshQuote(data) {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => runQuote(data), 180);
  }

  async function runQuote(data) {
    const note = $('#print-cost-note');
    const cost = $('#print-cost');
    const go = $('#print-go');
    if (!upload || !note) return;
    try {
      const q = await apiJson('/api/print/quote', { method: 'POST', body: optionsBody() });
      cost.textContent = euro(q.costCents);
      const sides = q.duplex ? 'fronte/retro' : 'solo fronte';
      const tone = q.color ? 'colore' : 'bianco e nero';
      note.textContent = q.pagesSelected + (q.pagesSelected === 1 ? ' pagina' : ' pagine') + ' × ' + q.copies + (q.copies === 1 ? ' copia' : ' copie') + ' · ' + sides + ' · ' + tone + (q.enough ? ' · credito dopo la stampa ' + euro(q.balanceCents - q.costCents) : ' · credito insufficiente');
      go.disabled = !q.enough;
      $('#print-err').textContent = q.enough ? '' : 'Credito insufficiente per questo lavoro.';
    } catch (err) {
      cost.textContent = '—';
      note.textContent = err.message;
      go.disabled = true;
    }
  }

  function optionsBody() {
    return {
      uploadId: upload && upload.id,
      printerId: $('#print-printer').value,
      copies: Number($('#print-copies').value),
      color: colorOn,
      duplex: duplexOn,
      format: $('#print-format').value,
      pageRange: $('#print-range').value,
    };
  }

  async function submit(data) {
    const go = $('#print-go');
    const err = $('#print-err');
    go.disabled = true;
    err.textContent = 'Invio in coda…';
    try {
      await apiJson('/api/print/jobs', { method: 'POST', body: optionsBody() });
      member();
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
    }
  }

  function guide(printers, flags) {
    const stripe = flags.stripe || {};
    const stripeLine = stripe.enabled
      ? 'Ricarica online attiva.'
      : (stripe.flag && !stripe.keysPresent
        ? 'PRINT_STRIPE_ENABLED è acceso ma mancano le chiavi Stripe: la ricarica online resta spenta e il sito continua a funzionare.'
        : 'Ricarica online spenta. Per attivarla più avanti: PRINT_STRIPE_ENABLED=1, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e PUBLIC_BASE_URL.');
    const tokenLine = flags.tokenConfigured
      ? 'Il server accetta l’agente (PRINT_AGENT_TOKEN impostato).'
      : 'PRINT_AGENT_TOKEN non è impostato sul server: l’agente non può collegarsi. Aggiungi la variabile su Render e nel config del PC in studio.';
    if (!printers.length) {
      return `<section class="glass card print-guide"><p class="kick">Prima di collegare la stampante</p><h2 class="print-title">Nessuna stampante configurata</h2>
        <p>La stampante dello studio non è ancora installata. Puoi preparare listino, code e credito da qui e collegarla quando arriva, senza toccare il codice.</p>
        <ol>
          <li>Decidi i prezzi per pagina nel listino: bianco e nero, colore, fronte/retro.</li>
          <li>Aggiungi una stampante con nome, posizione e protocollo (IPP, porta 9100 o coda CUPS). L’indirizzo IP può restare vuoto finché non lo conosci: lasciala disabilitata.</li>
          <li>Scegli un ID agente, per esempio <b>studio-1</b>. Lo stesso nome va nel config del PC accanto alla stampante.</li>
          <li>Quando la stampante c’è, compila IP o URI, abilitala e rendila visibile. Puoi segnarne una come predefinita.</li>
          <li>Installa la cartella <b>print-agent</b> sul PC in LAN. Parla solo in uscita verso il sito: non serve aprire porte sul router. Le modifiche fatte qui arrivano al giro di polling successivo.</li>
          <li>Ricarica i membri da «Ricarica da banco».</li>
        </ol>
        <p class="print-help">${esc(tokenLine)} ${esc(stripeLine)}</p>
      </section>`;
    }
    return `<section class="glass card print-guide"><p class="kick">Agente in studio</p><h2>Le stampanti si comandano da qui</h2>
      <p>Nome, IP, protocollo, prezzi e ID agente arrivano al PC locale al prossimo controllo. Non serve reinstallare l’agente. Una stampante è «in linea» se l’agente si è fatto sentire negli ultimi 90 secondi.</p>
      <p class="print-help">${esc(tokenLine)} ${esc(stripeLine)}</p>
    </section>`;
  }

  function centsField(cents) { return cents == null ? '' : (cents / 100).toFixed(2); }

  async function admin() {
    const my = ++gen;
    stop();
    const box = $('#m');
    box.innerHTML = '<h1>Gestione stampe</h1><p class="sub">Carico il pannello…</p>';
    let overview;
    let jobs;
    try {
      const qs = new URLSearchParams();
      if (filters.userId) qs.set('userId', filters.userId);
      if (filters.status) qs.set('status', filters.status);
      if (filters.printerId) qs.set('printerId', filters.printerId);
      if (filters.from) qs.set('from', filters.from);
      if (filters.to) qs.set('to', filters.to);
      [overview, jobs] = await Promise.all([
        apiJson('/api/admin/print/overview'),
        apiJson('/api/admin/print/jobs?' + qs.toString()),
      ]);
    } catch (err) {
      box.innerHTML = `<h1>Gestione stampe</h1><p class="err">${esc(err.message)}</p>`;
      return;
    }
    if (my !== gen) return;
    paintAdmin(overview, jobs);
  }

  function paintAdmin(data, jobs) {
    const s = data.settings;
    const maxPages = Math.max(1, ...data.stats.series.map((d) => d.pages));
    const chart = data.stats.series.some((d) => d.pages || d.jobs)
      ? `<div class="print-chart" role="img" aria-label="Pagine stampate negli ultimi 30 giorni">${data.stats.series.map((d) => `<i title="${esc(d.date)}: ${d.pages} pagine, ${euro(d.costCents)}" style="height:${Math.max(3, Math.round(d.pages / maxPages * 100))}%"></i>`).join('')}</div><div class="print-chart-labels"><span>${esc(data.stats.series[0].date.slice(5))}</span><span>oggi</span></div>`
      : '<p class="sub">Nessuna stampa completata negli ultimi 30 giorni.</p>';
    const printerRows = data.printers.map((p) => `<tr>
      <td><b>${esc(p.name)}</b>${p.isDefault ? ' · predefinita' : ''}<br><small style="color:var(--g)">${esc(p.location || 'senza posizione')} · ${esc(p.protocol)} · ${esc(p.connection || 'indirizzo da definire')}</small></td>
      <td>${p.enabled ? 'abilitata' : 'disabilitata'}<br>${p.visible ? 'visibile' : 'nascosta'}</td>
      <td>${p.online ? '<span class="pill">in linea</span>' : '<span class="pill off">offline</span>'}${p.agentId ? `<br><small style="color:var(--g)">${esc(p.agentId)}</small>` : '<br><small class="err">nessun agente</small>'}</td>
      <td>${p.supportsColor ? 'colore' : 'solo b/n'} · ${p.supportsDuplex ? 'fronte/retro' : 'fronte'} · ${esc(p.formats.join(', '))}</td>
      <td><button class="btn sm ghost" data-edit="${esc(p.id)}">Modifica</button> <button class="btn sm ghost" data-del="${esc(p.id)}">Elimina</button></td>
    </tr>`).join('') || '<tr><td colspan="5">Nessuna stampante. Usa il modulo qui sotto.</td></tr>';
    const userOpts = data.accounts.map((a) => `<option value="${a.id}">${esc(a.name)} · ${esc(a.email)} · ${euro(a.balanceCents)}</option>`).join('');
    const printerOpts = `<option value="">Tutte</option>` + data.printers.map((p) => `<option value="${esc(p.id)}"${filters.printerId === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    const statusOpts = ['', 'in coda', 'in stampa', 'completata', 'errore', 'rimborsata'].map((st) => `<option value="${esc(st)}"${filters.status === st ? ' selected' : ''}>${st || 'Tutti gli stati'}</option>`).join('');
    const csv = '/api/admin/print/jobs.csv?' + new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString();
    $('#m').innerHTML = `<div id="print-admin">
      <h1>Gestione stampe</h1>
      <p class="sub">Lavori, credito, listino e stampanti condivise. Nessun modello è impostato finché non lo aggiungi tu.</p>
      <div style="margin:-6px 0 16px"><button class="btn ghost sm" id="back-admin">← Admin prenotazioni</button> <button class="btn ghost sm" id="reload-print">Aggiorna</button></div>
      ${guide(data.printers, data)}
      <div class="print-stats">
        <div class="glass print-stat"><small>Lavori del mese</small><b>${data.stats.month.jobs}</b></div>
        <div class="glass print-stat"><small>Pagine del mese</small><b>${data.stats.month.pages}</b></div>
        <div class="glass print-stat"><small>Incassato nel mese</small><b>${euro(data.stats.month.costCents)}</b></div>
        <div class="glass print-stat"><small>Rimborsi del mese</small><b>${euro(data.stats.month.refundedCents)}</b></div>
      </div>
      <section class="glass card"><h2>Utilizzo · 30 giorni</h2>${chart}
        <div class="table-wrap" style="margin-top:14px"><table><tr><th>Membro</th><th>Lavori</th><th>Pagine</th><th>Spesa</th></tr>
        ${data.stats.byUser.filter((u) => u.jobs || u.pages).map((u) => `<tr><td>${esc(u.name)}</td><td>${u.jobs}</td><td>${u.pages}</td><td>${euro(u.costCents)}</td></tr>`).join('') || '<tr><td colspan="4">Ancora nessun totale</td></tr>'}
        </table></div>
      </section>
      <section class="glass card"><h2>Listino per pagina</h2>
        <p class="print-help">Prezzi in euro, a facciata. Una stampante può sovrascriverli; se il campo è vuoto vale questo listino.</p>
        <div class="print-form">
          <div><label>Bianco e nero (€)</label><input id="pr-bw" type="number" min="0" step="0.01" value="${(s.bwCents / 100).toFixed(2)}"></div>
          <div><label>Colore (€)</label><input id="pr-col" type="number" min="0" step="0.01" value="${(s.colorCents / 100).toFixed(2)}"></div>
          <div><label>Fronte/retro B/N (€)</label><input id="pr-dbw" type="number" min="0" step="0.01" value="${(s.duplexBwCents / 100).toFixed(2)}"></div>
          <div><label>Fronte/retro colore (€)</label><input id="pr-dcol" type="number" min="0" step="0.01" value="${(s.duplexColorCents / 100).toFixed(2)}"></div>
          <div><label>File massimo (MB)</label><input id="pr-mb" type="number" min="1" max="25" step="1" value="${Math.round(s.maxUploadBytes / (1024 * 1024))}"></div>
          <div><label>Copie massime</label><input id="pr-copies" type="number" min="1" max="100" value="${s.maxCopies}"></div>
          <div><label>Pagine massime per lavoro</label><input id="pr-pages" type="number" min="1" max="2000" value="${s.maxPages}"></div>
          <div><label>Quota mensile pagine (vuoto = nessun tetto)</label><input id="pr-quota" type="number" min="0" placeholder="illimitata" value="${s.monthlyPageQuota == null ? '' : s.monthlyPageQuota}"></div>
        </div>
        <button class="btn" id="pr-save">Salva listino</button> <span id="pr-msg" class="sub"></span>
      </section>
      <section class="glass card"><h2>Stampanti condivise</h2>
        <div class="table-wrap"><table><tr><th>Stampante</th><th>Stato</th><th>Agente</th><th>Capacità</th><th></th></tr>${printerRows}</table></div>
        <h2 id="pf-heading" style="margin-top:22px">${editing ? 'Modifica stampante' : 'Nuova stampante'}</h2>
        <div class="print-form" id="pf">
          <div><label>Nome</label><input id="pf-name" maxlength="80" placeholder="es. Reception"></div>
          <div><label>Dove si trova</label><input id="pf-loc" maxlength="120" placeholder="es. Bancone ingresso"></div>
          <div><label>Protocollo</label><select id="pf-proto"><option value="ipp">IPP</option><option value="raw">Raw 9100</option><option value="cups">Coda CUPS</option></select></div>
          <div><label>ID agente</label><input id="pf-agent" placeholder="studio-1" maxlength="80"></div>
          <div><label>Host o IP</label><input id="pf-host" placeholder="lascia vuoto se non c’è ancora"></div>
          <div><label>Porta</label><input id="pf-port" type="number" min="1" max="65535" placeholder="631 o 9100"></div>
          <div class="full"><label>URI (opzionale, ha priorità su host e porta)</label><input id="pf-uri" placeholder="ipp://10.0.0.5/ipp/print"></div>
          <div><label>Coda CUPS</label><input id="pf-queue" placeholder="solo se protocollo CUPS"></div>
          <div class="print-check full" style="display:flex;gap:18px;flex-wrap:wrap">
            <label class="print-check"><input id="pf-color" type="checkbox"> Stampa a colori</label>
            <label class="print-check"><input id="pf-duplex" type="checkbox"> Fronte/retro</label>
            <label class="print-check"><input data-fmt="A4" type="checkbox" checked> A4</label>
            <label class="print-check"><input data-fmt="A3" type="checkbox"> A3</label>
          </div>
          <div><label>Prezzo B/N € (vuoto = listino)</label><input id="pf-bw" type="number" min="0" step="0.01"></div>
          <div><label>Prezzo colore €</label><input id="pf-colp" type="number" min="0" step="0.01"></div>
          <div><label>Fronte/retro B/N €</label><input id="pf-dbw" type="number" min="0" step="0.01"></div>
          <div><label>Fronte/retro colore €</label><input id="pf-dcol" type="number" min="0" step="0.01"></div>
          <div class="print-check full" style="display:flex;gap:18px;flex-wrap:wrap">
            <label class="print-check"><input id="pf-on" type="checkbox"> Abilitata</label>
            <label class="print-check"><input id="pf-vis" type="checkbox"> Visibile ai membri</label>
            <label class="print-check"><input id="pf-def" type="checkbox"> Predefinita</label>
          </div>
        </div>
        <p class="print-help">Puoi salvare la stampante anche senza IP. Diventa selezionabile solo quando è abilitata, visibile e ha un indirizzo o una coda. L’agente con lo stesso ID la riceve da solo.</p>
        <div class="print-actions"><button class="btn" id="pf-save">Aggiungi stampante</button><button class="btn ghost" id="pf-reset" hidden>Annulla modifica</button><span id="pf-err" class="err"></span></div>
      </section>
      <section class="glass card"><h2>Lavori</h2>
        <div class="print-filters">
          <div><label>Utente</label><select id="f-user"><option value="">Tutti</option>${data.accounts.map((a) => `<option value="${a.id}"${String(filters.userId) === String(a.id) ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
          <div><label>Stato</label><select id="f-status">${statusOpts}</select></div>
          <div><label>Stampante</label><select id="f-printer">${printerOpts}</select></div>
          <div><label>Dal</label><input id="f-from" type="date" value="${esc(filters.from)}"></div>
          <div><label>Al</label><input id="f-to" type="date" value="${esc(filters.to)}"></div>
          <div class="print-actions"><button class="btn" id="f-go">Filtra</button><a class="btn ghost" href="${esc(csv)}">Esporta CSV</a></div>
        </div>
        <div class="table-wrap"><table><tr><th>Quando</th><th>Utente</th><th>File</th><th>Stampante</th><th>Pagine</th><th>Costo</th><th>Stato</th><th></th></tr><tbody id="admin-jobs">${jobRows(jobs, true)}</tbody></table></div>
      </section>
      <div class="print-grid">
        <section class="glass card"><h2>Ricarica da banco</h2>
          <label>Membro</label><select id="tu-user">${userOpts}</select>
          <label>Importo (€)</label><input id="tu-euro" type="number" min="0.01" step="0.01" value="10">
          <label>Nota</label><input id="tu-note" placeholder="es. contanti in reception" maxlength="200">
          <button class="btn" id="tu-go">Registra ricarica</button> <span id="tu-msg" class="sub"></span>
        </section>
        <section class="glass card"><h2>Quote pagine</h2>
          <p class="print-help">Il tetto generale è nel listino. Qui puoi dare un tetto diverso, oppure pagine illimitate, a un membro.</p>
          <label>Membro</label><select id="q-user">${userOpts}</select>
          <label>Modalità</label><select id="q-mode"><option value="inherit">Come il listino</option><option value="cap">Tetto personale</option><option value="unlimited">Illimitata</option></select>
          <label>Pagine al mese</label><input id="q-pages" type="number" min="0" value="100">
          <label>Nota</label><input id="q-note" maxlength="200">
          <button class="btn" id="q-go">Salva quota</button>
          <div class="table-wrap" style="margin-top:12px"><table><tr><th>Membro</th><th>Quota</th><th>Nota</th></tr>
          ${data.quotas.map((q) => `<tr><td>${esc(q.name)}</td><td>${q.unlimited ? 'illimitata' : q.monthlyPages}</td><td>${esc(q.note)}</td></tr>`).join('') || '<tr><td colspan="3">Nessuna eccezione</td></tr>'}
          </table></div>
        </section>
      </div>
    </div>`;
    $('#back-admin').onclick = () => { if (window.BaseApp) window.BaseApp.go('admin'); };
    $('#reload-print').onclick = () => admin();
    $('#pr-save').onclick = savePricing;
    $('#pf-save').onclick = savePrinter;
    $('#pf-reset').onclick = () => { editing = null; admin(); };
    $('#f-go').onclick = () => {
      filters.userId = $('#f-user').value;
      filters.status = $('#f-status').value;
      filters.printerId = $('#f-printer').value;
      filters.from = $('#f-from').value;
      filters.to = $('#f-to').value;
      admin();
    };
    $('#tu-go').onclick = async () => {
      const msg = $('#tu-msg');
      msg.textContent = 'Registro…';
      try {
        const r = await apiJson('/api/admin/print/topup', { method: 'POST', body: { userId: Number($('#tu-user').value), euros: $('#tu-euro').value, note: $('#tu-note').value } });
        msg.textContent = 'Fatto · saldo ' + euro(r.balanceCents);
        admin();
      } catch (err) { msg.textContent = err.message; }
    };
    $('#q-go').onclick = async () => {
      try {
        await apiJson('/api/admin/print/users/' + $('#q-user').value + '/quota', { method: 'PUT', body: { mode: $('#q-mode').value, pages: Number($('#q-pages').value), note: $('#q-note').value } });
        admin();
      } catch (err) { alert(err.message); }
    };
    document.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => startEdit(data.printers.find((p) => p.id === b.dataset.edit)); });
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Eliminare questa stampante? I lavori già fatti restano nello storico.')) return;
        try { await apiJson('/api/admin/print/printers/' + b.dataset.del, { method: 'DELETE' }); editing = null; admin(); }
        catch (err) { alert(err.message); }
      };
    });
    document.querySelectorAll('[data-refund]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Rimborsare tutto il credito di questo lavoro?')) return;
        try { await apiJson('/api/admin/print/jobs/' + b.dataset.refund + '/refund', { method: 'POST', body: { note: 'Rimborso da banco' } }); admin(); }
        catch (err) { alert(err.message); }
      };
    });
    if (editing) startEdit(data.printers.find((p) => p.id === editing) || null);
  }

  function startEdit(p) {
    if (!p) { editing = null; return; }
    editing = p.id;
    $('#pf-heading').textContent = 'Modifica stampante';
    $('#pf-save').textContent = 'Salva modifiche';
    $('#pf-reset').hidden = false;
    $('#pf-name').value = p.name;
    $('#pf-loc').value = p.location || '';
    $('#pf-proto').value = p.protocol;
    $('#pf-agent').value = p.agentId || '';
    $('#pf-host').value = p.host || '';
    $('#pf-port').value = p.port == null ? '' : p.port;
    $('#pf-uri').value = p.uri || '';
    $('#pf-queue').value = p.queue || '';
    $('#pf-color').checked = !!p.supportsColor;
    $('#pf-duplex').checked = !!p.supportsDuplex;
    document.querySelectorAll('[data-fmt]').forEach((el) => { el.checked = p.formats.includes(el.dataset.fmt); });
    $('#pf-bw').value = centsField(p.overrides.bwCents);
    $('#pf-colp').value = centsField(p.overrides.colorCents);
    $('#pf-dbw').value = centsField(p.overrides.duplexBwCents);
    $('#pf-dcol').value = centsField(p.overrides.duplexColorCents);
    $('#pf-on').checked = !!p.enabled;
    $('#pf-vis').checked = !!p.visible;
    $('#pf-def').checked = !!p.isDefault;
    $('#pf').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function printerBody() {
    return {
      name: $('#pf-name').value,
      location: $('#pf-loc').value,
      protocol: $('#pf-proto').value,
      agentId: $('#pf-agent').value,
      host: $('#pf-host').value,
      port: $('#pf-port').value,
      uri: $('#pf-uri').value,
      queue: $('#pf-queue').value,
      supportsColor: $('#pf-color').checked,
      supportsDuplex: $('#pf-duplex').checked,
      formats: [...document.querySelectorAll('[data-fmt]')].filter((el) => el.checked).map((el) => el.dataset.fmt),
      priceBw: $('#pf-bw').value,
      priceColor: $('#pf-colp').value,
      priceDuplexBw: $('#pf-dbw').value,
      priceDuplexColor: $('#pf-dcol').value,
      enabled: $('#pf-on').checked,
      visible: $('#pf-vis').checked,
      isDefault: $('#pf-def').checked,
    };
  }

  async function savePrinter() {
    const err = $('#pf-err');
    err.textContent = 'Salvo…';
    try {
      if (editing) await apiJson('/api/admin/print/printers/' + editing, { method: 'PATCH', body: printerBody() });
      else await apiJson('/api/admin/print/printers', { method: 'POST', body: printerBody() });
      editing = null;
      admin();
    } catch (e) { err.textContent = e.message; }
  }

  async function savePricing() {
    const msg = $('#pr-msg');
    msg.textContent = 'Salvo…';
    try {
      await apiJson('/api/admin/print/pricing', {
        method: 'PATCH',
        body: {
          bw: $('#pr-bw').value,
          color: $('#pr-col').value,
          duplexBw: $('#pr-dbw').value,
          duplexColor: $('#pr-dcol').value,
          maxUploadMb: Number($('#pr-mb').value),
          maxCopies: Number($('#pr-copies').value),
          maxPages: Number($('#pr-pages').value),
          monthlyPageQuota: $('#pr-quota').value,
        },
      });
      msg.textContent = 'Listino aggiornato';
    } catch (err) { msg.textContent = err.message; }
  }

  window.PrintUI = { member, admin };
})();
