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

L’agente in `print-agent/` sta sul PC in LAN, parla solo in HTTPS in uscita e riceve l’elenco stampanti dal sito. Vedi `print-agent/README.md`. Per provare senza hardware: `backend: "file"` (scrive PDF e opzioni in una cartella).

Variabili:

- `PRINT_AGENT_TOKEN` — segreto condiviso con l’agente. Se manca, il sito funziona e l’API agente risponde 503.
- `PRINT_STRIPE_ENABLED=1`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` — ricarica online. Senza chiavi o senza flag il pulsante non compare e il banco (ricarica manuale) resta disponibile. Webhook: `POST /api/print/stripe/webhook`.
- `PUBLIC_BASE_URL` — origine pubblica usata da Stripe per il ritorno (es. `https://….onrender.com`).
- `STRIPE_CURRENCY` — default `eur`.
- `SOFFICE_PATH` — binario LibreOffice, se non è in `/usr/bin/soffice`.

Prezzi iniziali, da cambiare nel pannello: B/N 0,05 €, colore 0,20 €, fronte/retro B/N 0,04 €, fronte/retro colore 0,15 € a facciata. Quota mensile vuota = nessun tetto. Le tabelle (`printers`, `print_jobs`, `credit_ledger`, …) si creano all’avvio come il resto, se mancano.

Lo studio deve ancora decidere: modello e IP della stampante, protocollo, prezzi, eventuale tetto pagine, e su quale PC gira l’agente (`agentId`, es. `studio-1`).
