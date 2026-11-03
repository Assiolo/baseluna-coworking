# Base Luna Coworking
Avvio: `npm install && node server.js` → http://localhost:5173 (PORT configurabile).
Demo: admin@baselunastudio.it / admin123 · demo@baselunastudio.it / demo123
Dati: `data/db.json` (utenti con password bcrypt, sessioni, prenotazioni, pagamenti). Cancellalo per reset.
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
