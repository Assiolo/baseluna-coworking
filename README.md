# Base Luna Coworking
Avvio: `npm install`, poi `DATABASE_URL=postgres://… node server.js` → http://localhost:5173 (`PORT` configurabile). Senza `DATABASE_URL` il processo esce subito: non c'è più il ripiego su JSON.

Dati account su Postgres (Neon, stringa pooled in `DATABASE_URL`, con `sslmode=require`): utenti, sessioni, prenotazioni, pagamenti. Le tabelle si creano all'avvio se mancano. Il primo account registrato diventa admin se non ne esiste già uno.

`data/db.json` non è più nel repository (è in `.gitignore`). Se al primo avvio le tabelle sono vuote e quel file è ancora sul disco, viene importato una sola volta; se c'è già almeno una riga, l'import si salta. La forma del file è in `data/db.example.json` (senza hash veri): non copiarlo su `db.json` se vuoi che la prima registrazione diventi admin. Per ripartire da zero svuota le tabelle Postgres, non un file.

Restano file: `data/floorplan.json`, `data/config.json`, `data/notifications.json`.

Keep-alive (Neon free si spegne dopo ~5 minuti di inattività): `GET /api/health` esegue `SELECT 1` e risponde `{ok:true}` oppure `{ok:false}` con 503. Con `DATABASE_URL` impostata il processo ripete `SELECT 1` ogni 4 minuti finché il servizio è acceso.

Piantina sostituibile: `data/floorplan.json` (zones, desks con x/y/w/h, pricing) + `public/floorplan.js` (contratto `FloorPlan.render(el, plan, state, onPick)`). Il flusso di prenotazione usa solo gli id delle scrivanie.
Pagamenti (demo, nessun gateway): Fatturazione, PayPal, Contanti, Satispay.

## Pagamenti (aggiornamento)
- Step «1 · Quando» ha due card: **Ingresso giornaliero** e **Pacchetto mensile** (€ `pricing.mensile` in floorplan.json).
- Nessuna prenotazione è `confermata` prima del pagamento. Satispay/PayPal → `in attesa di pagamento` + redirect a `/pay/<metodo>?g=<id>`. Fatturazione/Contanti → `da saldare`. L'admin clicca «Pagato ✓» in Admin → «Pagamenti da registrare» e la prenotazione diventa `confermata`.
- **Link di pagamento**: incolla in `data/config.json` i link forniti dallo studio:
  `{ "satispayPaymentUrl": "", "paypalPaymentUrl": "" }`
  Segnaposto opzionali nel link: `{amount}` (euro) o `{amount_cents}`. Senza segnaposto il link si apre così com'è e l'importo è mostrato sulla nostra pagina. Se vuoto: pagina «In attesa del link di pagamento», nessun redirect.
- **Contanti**: ogni prenotazione in contanti scrive una notifica in `data/notifications.json` (utente, email, scrivania, date, importo, `sent:false`) e appare in Admin come «Contanti da riscuotere». L'invio reale (email/messaggio) allo studio lo fa l'agente Grok Bot leggendo questo file: nessun indirizzo email è configurato nel codice.
- **Foto hero**: metti una foto dello studio in `public/` e scrivi in `data/config.json` `"heroImage": "/studio.jpg"` (variabile CSS `--hero`). Vuoto = sfondo gradiente scuro con forme cromate.
