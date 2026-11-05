// v20261105a — guida al primo accesso. Flag: localStorage "baseluna-tour-seen:<id utente>"
(function () {
  const KEY = (id) => 'baseluna-tour-seen:' + id;
  const STEPS = [
    { view: 'home', sel: '[data-tour="hero"]', radius: 24, title: 'La tua home', body: 'Ciao. Da qui vedi chi c’è in studio oggi e prenoti la scrivania.' },
    { view: 'home', sel: '[data-tour="today"]', radius: 28, union: true, title: 'Oggi in studio', body: 'Chi è in ufficio, la tua postazione, data e orario. I chip raccontano Wi-Fi e coffee break.' },
    { view: 'home', sel: '[data-tour="bookings"]', radius: 28, title: 'Le mie prenotazioni', body: 'Le prossime date. «Vedi tutte» apre l’elenco completo.' },
    { view: 'home', sel: '[data-tour="desk"]', radius: 28, title: 'La scrivania di oggi', body: 'Il numero grande è la postazione di oggi. «—» se non hai ancora prenotato.' },
    { view: 'home', sel: '[data-tour="month"]', radius: 28, title: 'Riepilogo del mese', body: 'Prenotazioni del mese, quelle confermate e quelle ancora da saldare.' },
    { view: 'home', sel: '[data-tour="profile"]', radius: 999, title: 'Il tuo profilo', body: 'Foto, nome e due righe su di te: così ti riconoscono in studio.' },
    { view: 'home', sel: '[data-tour="nav-prenota"]', radius: 999, title: 'Prenota', body: 'Qui scegli il giorno, la postazione sull’isola e come pagare.' },
    { view: 'prenota', sel: '[data-tour="when"]', radius: 28, title: 'Quando', body: 'Un giorno, con fascia oraria, oppure il pacchetto mensile sulla stessa scrivania.' },
    { view: 'prenota', sel: '#dk .isl-photo-wrap', radius: 16, dock: 'bottom', title: 'Isola A1–B3', body: 'Sei posti, tre contro tre. Verde libera, grigio occupata, arancio quella che scegli.' },
    { view: 'prenota', sel: '[data-tour="pay"]', radius: 28, title: 'Come paghi', body: 'Bonifico, PayPal, contanti o Satispay. L’importo è nel riepilogo in basso.' },
  ];

  const tour = {
    steps: STEPS,
    active: false,
    arm: false,
    step: 0,
    _driving: false,
    _placing: false,
    _skipGuard: 0,
    getView: () => 'home',
    setView: () => {},
    userId: () => null,
    key: KEY,
    bind(hooks) {
      if (hooks.getView) this.getView = hooks.getView;
      if (hooks.setView) this.setView = hooks.setView;
      if (hooks.userId) this.userId = hooks.userId;
    },
    seen() {
      const id = this.userId && this.userId();
      if (!id && id !== 0) return true;
      try { return localStorage.getItem(KEY(id)) === '1'; } catch { return true; }
    },
    mark() {
      const id = this.userId && this.userId();
      if (!id && id !== 0) return;
      try { localStorage.setItem(KEY(id), '1'); } catch { /* private mode */ }
    },
    ensure() {
      if (this.root) return;
      const root = document.createElement('div');
      root.id = 'tour';
      root.className = 'tour-root';
      root.hidden = true;
      const pane = (cls) => {
        const d = document.createElement('div');
        d.className = cls;
        root.appendChild(d);
        return d;
      };
      this.dimT = pane('tour-dim');
      this.dimL = pane('tour-dim');
      this.dimR = pane('tour-dim');
      this.dimB = pane('tour-dim');
      this.hole = pane('tour-hole');
      this.ring = pane('tour-ring');
      const card = document.createElement('div');
      card.className = 'tour-card glass';
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-modal', 'true');
      card.setAttribute('aria-labelledby', 'tourTitle');
      card.innerHTML = '<p class="tour-kicker" id="tourKicker"></p><h3 id="tourTitle"></h3><p class="tour-copy" id="tourCopy"></p><i class="tour-arrow" aria-hidden="true"></i><div class="tour-bar"><button type="button" class="tour-skip" id="tourSkip">Salta</button><button type="button" class="btn sm" id="tourNext">Avanti</button></div>';
      root.appendChild(card);
      document.body.appendChild(root);
      this.root = root;
      this.card = card;
      this.kicker = card.querySelector('#tourKicker');
      this.title = card.querySelector('#tourTitle');
      this.copy = card.querySelector('#tourCopy');
      this.skipBtn = card.querySelector('#tourSkip');
      this.nextBtn = card.querySelector('#tourNext');
      this.skipBtn.addEventListener('click', () => this.finish());
      this.nextBtn.addEventListener('click', () => this.next());
      this._onKey = (e) => {
        if (!this.active || this.root.hidden) return;
        if (e.key === 'Escape') { e.preventDefault(); this.finish(); return; }
        if (e.key !== 'Tab') return;
        const f = [this.skipBtn, this.nextBtn];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        f[(e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i >= f.length - 1 ? 0 : i + 1))].focus();
      };
      this._onScroll = () => { if (this.active && !this._placing) this.position(); };
      window.addEventListener('scroll', this._onScroll, true);
      window.addEventListener('resize', this._onScroll);
    },
    fill(step) {
      const n = this.steps.length;
      this.kicker.textContent = 'Guida · ' + (this.step + 1) + ' di ' + n;
      this.title.textContent = step.title;
      this.copy.textContent = step.body;
      this.nextBtn.textContent = this.step === n - 1 ? 'Fine' : 'Avanti';
    },
    open() {
      if (!this.userId || (this.userId() == null)) return;
      const was = this.active;
      this.active = true;
      this.arm = false;
      this.step = 0;
      this._skipGuard = 0;
      this.ensure();
      document.body.classList.add('tour-on');
      this.root.hidden = false;
      this.fill(this.steps[0]);
      if (!was) document.addEventListener('keydown', this._onKey);
      if (this.getView() !== this.steps[0].view) {
        this._driving = true;
        this.nextBtn.disabled = true;
        this.setView(this.steps[0].view);
      } else this.place();
    },
    finish() {
      this.mark();
      this.hide();
    },
    hide() {
      this.active = false;
      this._driving = false;
      this.arm = false;
      document.body.classList.remove('tour-on');
      const tilt = document.getElementById('tilt');
      if (tilt) tilt.style.transform = '';
      if (this.root) this.root.hidden = true;
      if (this._onKey) document.removeEventListener('keydown', this._onKey);
    },
    onLoggedOut() {
      this.arm = false;
      if (this.active) this.hide();
    },
    afterPaint() {
      if (!document.getElementById('openGuida')) {
        if (this.active) this.hide();
        return;
      }
      if (this.active) {
        const step = this.steps[this.step];
        if (this.getView() !== step.view && !this._driving) {
          this.mark();
          this.hide();
          return;
        }
        this.place();
        return;
      }
      if (this.arm) {
        this.arm = false;
        this.open();
      }
    },
    next() {
      if (this._driving) return;
      this.advance();
    },
    advance() {
      if (this.step >= this.steps.length - 1) return this.finish();
      this.step += 1;
      const step = this.steps[this.step];
      this.fill(step);
      if (this.getView() !== step.view) {
        this._driving = true;
        this.nextBtn.disabled = true;
        this.setView(step.view);
      } else this.place();
    },
    bounds(el, step) {
      if (!step || !step.union) return el.getBoundingClientRect();
      const nodes = [el, ...el.querySelectorAll('.hcard, .chip, .live')];
      let t = Infinity, l = Infinity, r = -Infinity, b = -Infinity;
      nodes.forEach((n) => {
        const x = n.getBoundingClientRect();
        if (x.width < 2 || x.height < 2) return;
        t = Math.min(t, x.top); l = Math.min(l, x.left); r = Math.max(r, x.right); b = Math.max(b, x.bottom);
      });
      if (!Number.isFinite(t)) return el.getBoundingClientRect();
      return { top: t, left: l, right: r, bottom: b, width: r - l, height: b - t };
    },
    place() {
      const step = this.steps[this.step];
      if (!step) return this.finish();
      const el = document.querySelector(step.sel);
      this._driving = false;
      if (!el) {
        this._skipGuard += 1;
        if (this._skipGuard > this.steps.length) return this.finish();
        return this.advance();
      }
      this._skipGuard = 0;
      this._placing = true;
      const preview = el.getBoundingClientRect();
      const nav = document.querySelector('body.app-bg nav');
      if (nav && nav.contains(el)) {
        if (nav.getBoundingClientRect().top < 0) window.scrollTo({ top: 0 });
      } else if (step.dock === 'bottom') {
        const y = window.scrollY + preview.top - Math.max(72, (window.innerHeight - preview.height) / 2);
        window.scrollTo({ top: Math.max(0, y) });
      } else if (preview.top < 72 || preview.top > window.innerHeight * 0.5) {
        window.scrollTo({ top: Math.max(0, window.scrollY + preview.top - 88) });
      }
      this._placing = false;
      this.fill(step);
      this.nextBtn.disabled = false;
      this.position(el, step);
      if (this.nextBtn) this.nextBtn.focus({ preventScroll: true });
      requestAnimationFrame(() => {
        if (!this.active) return;
        const again = document.querySelector(step.sel);
        if (again) this.position(again, step);
      });
    },
    position(el, step) {
      if (!this.active || !el || !this.card) return;
      step = step || this.steps[this.step];
      if (!step) return;
      const raw = this.bounds(el, step);
      const pad = 8;
      let top = raw.top - pad;
      let left = raw.left - pad;
      let right = raw.right + pad;
      let bottom = raw.bottom + pad;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const m = 12;
      const card = this.card;
      const phone = vw < 760;
      const dockBottom = phone || (step && step.dock === 'bottom');
      card.style.width = phone ? (vw - m * 2) + 'px' : 'min(320px, calc(100vw - 24px))';
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const gap = 14;
      let cTop;
      let cLeft;
      let pos;
      if (dockBottom) {
        cTop = Math.max(m, vh - ch - m);
        cLeft = phone ? m : Math.max(m, Math.min(raw.left + raw.width / 2 - cw / 2, vw - cw - m));
        pos = raw.top < cTop - 24 ? 'below' : 'above';
        if (pos === 'below' && bottom > cTop - 8) bottom = cTop - 8;
      } else {
        const roomBelow = vh - raw.bottom;
        const roomAbove = raw.top;
        const roomRight = vw - raw.right;
        const roomLeft = raw.left;
        if (roomBelow >= ch + gap + m) pos = 'below';
        else if (roomAbove >= ch + gap + m) pos = 'above';
        else if (roomRight >= cw + gap + m) pos = 'right';
        else if (roomLeft >= cw + gap + m) pos = 'left';
        else pos = roomBelow >= roomAbove ? 'below' : 'above';
        if (pos === 'below') { cTop = raw.bottom + gap; cLeft = raw.left + raw.width / 2 - cw / 2; }
        else if (pos === 'above') { cTop = raw.top - gap - ch; cLeft = raw.left + raw.width / 2 - cw / 2; }
        else if (pos === 'right') { cLeft = raw.right + gap; cTop = raw.top + Math.min(raw.height / 2, 80) - 24; }
        else { cLeft = raw.left - gap - cw; cTop = raw.top + Math.min(raw.height / 2, 80) - 24; }
        cLeft = Math.max(m, Math.min(cLeft, vw - cw - m));
        cTop = Math.max(m, Math.min(cTop, vh - ch - m));
        if (pos === 'below' && bottom > cTop - 6) bottom = cTop - 6;
        if (pos === 'above' && top < cTop + ch + 6) top = cTop + ch + 6;
        if (pos === 'right' && right > cLeft - 6) right = Math.min(right, cLeft - 6);
        if (pos === 'left' && left < cLeft + cw + 6) left = Math.max(left, cLeft + cw + 6);
      }
      top = Math.max(4, top);
      left = Math.max(4, left);
      right = Math.min(vw - 4, right);
      bottom = Math.min(vh - 4, bottom);
      const w = Math.max(0, right - left);
      const h = Math.max(0, bottom - top);
      const box = (node, r) => {
        node.style.top = r.top + 'px';
        node.style.left = r.left + 'px';
        node.style.width = r.width + 'px';
        node.style.height = r.height + 'px';
      };
      box(this.dimT, { top: 0, left: 0, width: vw, height: Math.max(0, top) });
      box(this.dimL, { top, left: 0, width: Math.max(0, left), height: h });
      box(this.dimR, { top, left: right, width: Math.max(0, vw - right), height: h });
      box(this.dimB, { top: bottom, left: 0, width: vw, height: Math.max(0, vh - bottom) });
      box(this.hole, { top, left, width: w, height: h });
      box(this.ring, { top, left, width: w, height: h });
      this.ring.style.borderRadius = (step.radius || 22) + 'px';
      this.ring.style.visibility = w > 2 && h > 2 ? 'visible' : 'hidden';
      card.style.left = cLeft + 'px';
      card.style.top = cTop + 'px';
      card.classList.remove('is-below', 'is-above', 'is-left', 'is-right');
      card.classList.add('is-' + pos);
      const ax = Math.max(18, Math.min(cw - 30, (raw.left + raw.width / 2) - cLeft - 7));
      const ay = Math.max(18, Math.min(ch - 30, (raw.top + raw.height / 2) - cTop - 7));
      card.style.setProperty('--ax', ax + 'px');
      card.style.setProperty('--ay', ay + 'px');
      card.style.visibility = 'visible';
    },
  };

  window.BaseTour = tour;
})();
