# Base Luna Coworking
Avvio: `npm install`, poi `DATABASE_URL=postgres://… node server.js` → http://localhost:5173 (`PORT` configurabile). Senza `DATABASE_URL` il processo esce subito: non c'è più il ripiego su JSON.

Dati su Postgres (Neon, stringa pooled in `DATABASE_URL`, con `sslmode=require`): utenti (nome, bio, titolo e foto), sessioni, prenotazioni, pagamenti, prezzi dei pacchetti. Le tabelle si creano all'avvio se mancano. Il primo account registrato diventa admin se non ne esiste già uno.

`data/db.json` non è più nel repository (è in `.gitignore`). Se al primo avvio le tabelle sono vuote e quel file è ancora sul disco, viene importato una sola volta; se c'è già almeno una riga, l'import si salta. La forma del file è in `data/db.example.json` (senza hash veri): non copiarlo su `db.json` se vuoi che la prima registrazione diventi admin. Per ripartire da zero svuota le tabelle Postgres, non un file.

Restano file: geometria di `data/floorplan.json` (immagine, zones, desks), `data/config.json`, `data/notifications.json`. I prezzi dentro `floorplan.json` sono solo il seme: se la tabella `pricing` è vuota vengono copiati una volta all'avvio; un salvataggio admin scrive su Postgres e non riscrive il file. Agli avvii successivi i prezzi già presenti non vengono sovrascritti.

Foto profilo: il caricamento (PNG, JPG o WEBP, max 5 MB) viene ritagliato in un quadrato da massimo 256 px, ricompresso in JPEG e salvato nella tabella `avatars` (`bytes` bytea + `content_type`). `users.avatar` è l'URL pubblico `/api/users/:id/avatar?v=…`. Se al boot un utente ha ancora un percorso `/uploads/avatars/…` e il file è sul disco, i byte vengono importati una volta con la stessa compressione; se il file non c'è più, il campo si svuota.

Keep-alive (Neon free si spegne dopo ~5 minuti di inattività): `GET /api/health` esegue `SELECT 1` e risponde `{ok:true}` oppure `{ok:false}` con 503. Con `DATABASE_URL` impostata il processo ripete `SELECT 1` ogni 4 minuti finché il servizio è acceso.

Piantina sostituibile: `data/floorplan.json` (zones, desks con x/y) + `public/floorplan.js` (contratto `FloorPlan.render(el, plan, state, onPick)`). Il flusso di prenotazione usa solo gli id delle scrivanie. I prezzi mostrati e addebitati arrivano da Postgres.
Pagamenti (demo, nessun gateway): Fatturazione, PayPal, Contanti, Satispay.

## Pagamenti (aggiornamento)
- Step «1 · Quando» ha due card: **Ingresso giornaliero** e **Pacchetto mensile** (€ `pricing.mensile` su Postgres).
- Nessuna prenotazione è `confermata` prima del pagamento. Satispay/PayPal → `in attesa di pagamento` + redirect a `/pay/<metodo>?g=<id>`. Fatturazione/Contanti → `da saldare`. L'admin clicca «Pagato ✓» in Admin → «Pagamenti da registrare» e la prenotazione diventa `confermata`.
- **Link di pagamento**: incolla in `data/config.json` i link forniti dallo studio:
  `{ "satispayPaymentUrl": "", "paypalPaymentUrl": "" }`
  Segnaposto opzionali nel link: `{amount}` (euro) o `{amount_cents}`. Senza segnaposto il link si apre così com'è e l'importo è mostrato sulla nostra pagina. Se vuoto: pagina «In attesa del link di pagamento», nessun redirect.
- **Contanti**: ogni prenotazione in contanti scrive una notifica in `data/notifications.json` (utente, email, scrivania, date, importo, `sent:false`) e appare in Admin come «Contanti da riscuotere». L'invio reale (email/messaggio) allo studio lo fa l'agente Grok Bot leggendo questo file: nessun indirizzo email è configurato nel codice.
- **Foto hero**: metti una foto dello studio in `public/` e scrivi in `data/config.json` `"heroImage": "/studio.jpg"` (variabile CSS `--hero`). Vuoto = sfondo gradiente scuro con forme cromate.

## Stampa (credito)

Ogni membro ha la voce **Stampa**: carica un PDF (o un’immagine; i file Office passano da LibreOffice solo se `soffice` è installato sul server), vede l’anteprima e il costo, e mette il lavoro in coda. Il credito si scala all’invio e viene rimborsato se il lavoro fallisce o viene annullato mentre è in coda. Il saldo non va mai sotto zero.

Le stampanti non sono nel codice. In **Admin → Gestione stampe** si aggiungono una o più code (nome, posizione, IPP / raw 9100 / coda CUPS, IP o URI, colore, fronte/retro, A4/A3, prezzi propri, ID dell’agente che le serve). Si abilitano e si rendono visibili quando l’indirizzo c’è. Senza stampanti il membro vede «Nessuna stampante disponibile».

L’agente in `print-agent/` sta sul PC in LAN, parla solo in HTTPS in uscita e riceve l’elenco stampanti dal sito. Vedi `print-agent/README.md`. Per provare senza hardware: `backend: "file"` (scrive PDF e opzioni in una cartella). Le stampanti «Agente locale» non cambiano: l’agente non vede e non stampa quelle impostate come email del produttore.

### Stampa via email del produttore

Opzionale e spenta di default. In **Gestione stampe**, nel modulo della stampante, il collegamento può essere **Agente locale** (il comportamento di oggi) oppure **Cloud del produttore (email)**. La seconda voce resta grigia, con la spiegazione, finché sul server non ci sono il flag e un mittente. Le stampanti già presenti restano «Agente locale».

Serve per servizi che stampano un PDF ricevuto per email, per esempio Epson Connect Email Print (`nome@print.epsonconnect.com`) o HP ePrint (`nome@hpeprint.com`). Il sito manda lui la mail con il PDF già preparato. Non passa dalla coda dell’agente.

Sul servizio web di Render, per accenderla:

- `PRINT_CLOUD_ENABLED=1`
- mittente SMTP: `SMTP_HOST`, `SMTP_PORT` (se manca, 587), `SMTP_FROM` (indirizzo, oppure `Nome <indirizzo>`). Se il server chiede login: `SMTP_USER` e `SMTP_PASS`. `SMTP_SECURE` vale `starttls` (default sulla 587), `tls` (default sulla 465) o `plain` (solo un relay locale, senza cifratura).
- in alternativa, senza `SMTP_HOST`: `RESEND_API_KEY` e `SMTP_FROM` (dominio verificato su Resend). Se `SMTP_HOST` c’è, si usa SMTP e Resend no.

`SMTP_FROM` è l’indirizzo da aggiungere alla lista dei mittenti autorizzati della stampante. Epson Connect, con la lista attiva, scarta le mail di chi non è in elenco; HP ePrint ha lo stesso tipo di lista. Nel pannello Epson conviene anche spegnere la stampa del corpo del messaggio, altrimenti può uscire un foglio in più oltre al PDF. L’oggetto della mail è «Stampa» (HP ePrint rifiuta l’oggetto vuoto) e il destinatario è solo l’indirizzo della stampante.

Cosa il cloud non comanda, e cosa fa il sito al posto suo:

- Intervallo pagine: il sito ritaglia il PDF prima di allegarlo. Questo funziona.
- Copie: né Epson né HP accettano un comando «copie» nella mail. Il sito ripete le pagine nello stesso PDF, una volta per copia, e manda un solo allegato. Due copie di un foglio sono due pagine una dopo l’altra.
- Colore, fronte/retro e formato: li decide il servizio, non il singolo lavoro. In Gestione stampe si registra com’è impostata la stampante (serve solo per il prezzo e per la scritta che vede il membro). Sulla pagina Stampa quelle scelte sono bloccate, con la spiegazione. Epson Connect Email Print stampa solo fronte: il fronte/retro non si può attivare. HP ePrint di solito esce a colori, una copia, solo fronte; su alcuni modelli il fronte/retro si fissa nell’account HP, non nella mail.
- Dimensione: Epson accetta allegati fino a circa 20 MB, HP una mail sotto circa 10 MB. Il PDF inviato è limitato a circa 15 MB per Epson e circa 6 MB per HP e per gli altri servizi, così dopo la codifica dell’email si resta sotto la soglia. Se le copie lo fanno sforare, il lavoro non parte e il credito non si scala.

Esito. Se il server di posta rifiuta la mail, il lavoro va in **rimborsata** e il credito torna indietro (il saldo non va sotto zero). Se la mail è accettata, lo stato è **inviata al cloud**, non «completata»: il servizio non dice al sito se il foglio è uscito. Il membro e l’admin vedono quella scritta. L’admin può **Segna stampata** (allora conta come completata) oppure **Rimborsa**. Se il processo si interrompe dopo l’addebito e prima della risposta del server, lo stato resta **invio al cloud**: da lì si può reinviare, segnare stampata o rimborsare.

Conferme che non leggiamo. Epson Connect può mandare una mail di notifica al mittente, se nella lista dei mittenti autorizzati spunti l’avviso per `SMTP_FROM`: arriva nella casella di quel mittente, non al sito. HP mostra lo storico nel portale HP Smart / HP Connected. I testi cambiano e non c’è un webhook stabile, quindi non c’è un lettore di risposte. La conferma la dà lo staff dal pannello.

Variabili:

- `PRINT_AGENT_TOKEN` — segreto condiviso con l’agente. Se manca, il sito funziona e l’API agente risponde 503.
- `PRINT_STRIPE_ENABLED=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — ricarica online. Senza chiavi o senza flag il pulsante non compare e il banco (ricarica manuale) resta disponibile. Webhook: `POST /api/print/stripe/webhook`.
- `PUBLIC_BASE_URL` — origine pubblica usata da Stripe per il ritorno (es. `https://….onrender.com`).
- `STRIPE_CURRENCY` — default `eur`.
- `SOFFICE_PATH` — binario LibreOffice, se non è in `/usr/bin/soffice`.

Prezzi iniziali, da cambiare nel pannello: B/N 0,05 €, colore 0,20 €, fronte/retro B/N 0,04 €, fronte/retro colore 0,15 € a facciata. Quota mensile vuota = nessun tetto. Le tabelle (`printers`, `print_jobs`, `credit_ledger`, …) si creano all’avvio come il resto, se mancano.

Lo studio deve ancora decidere: modello e IP della stampante, protocollo, prezzi, eventuale tetto pagine, e su quale PC gira l’agente (`agentId`, es. `studio-1`).
