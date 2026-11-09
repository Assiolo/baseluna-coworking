# Agente di stampa Base Luna

Programma da tenere acceso sul PC, sul Mac o sul Raspberry Pi che sta nella stessa rete della stampante dello studio. Il sito è in cloud: questo agente esce solo in HTTPS, scarica i PDF in coda e li consegna alla stampante. Non serve aprire porte sul router.

La stampante **non è ancora installata** e non c’è nessun modello o IP nel codice. Nome, protocollo, indirizzo e capacità si impostano dal pannello **Gestione stampe**. L’agente li riceve a ogni giro. Cambi un IP dal sito e al controllo successivo vale quello nuovo, senza reinstallare.

Finché non c’è una stampante vera, lascia il backend `file`: i lavori finiscono in una cartella, utili per la prova.

## Cosa ti serve

- Node.js 18 o successivo sul computer in studio.
- Sul sito (Render): la variabile `PRINT_AGENT_TOKEN`, una stringa lunga e casuale. Lo stesso valore va qui.
- Nel pannello, una stampante con **ID agente** identico a `agentId` (per esempio `studio-1`).

## 1. Configurazione

```bash
cd print-agent
cp config.example.json config.json
```

`config.json` non va committato.

| Campo | Significato |
| --- | --- |
| `siteUrl` | Indirizzo del sito, senza barra finale. Esempio `https://baseluna.onrender.com`. |
| `token` | Lo stesso valore di `PRINT_AGENT_TOKEN`. |
| `agentId` | Lo stesso ID scritto sulla stampante nel pannello. |
| `pollMs` | Ogni quanti millisecondi controllare la coda. Minimo effettivo 1000, default 5000. |
| `backend` | `file` scrive su disco. `system` usa la stampante vera. |
| `outputDir` | Cartella usata solo dal backend `file`. |
| `snmpCommunity` | Community SNMP, di solito `public`, solo se vuoi il livello toner. |

Le variabili d’ambiente, se presenti, vincono sul file: `PRINT_SITE_URL`, `PRINT_AGENT_TOKEN`, `PRINT_AGENT_ID`, `PRINT_BACKEND`, `PRINT_OUTPUT_DIR`, `PRINT_POLL_MS`, `PRINT_SNMP_COMMUNITY`, `PRINT_AGENT_CONFIG` (percorso del JSON).

## 2. Prova senza stampante

```bash
cd print-agent
npm test
PRINT_SITE_URL=http://127.0.0.1:5173 \
PRINT_AGENT_TOKEN=il-token \
PRINT_AGENT_ID=studio-1 \
PRINT_BACKEND=file \
PRINT_OUTPUT_DIR=./print-out \
node agent.js
```

Dal sito, un membro invia un PDF. Nella cartella `print-out` compaiono `<id>.pdf` e `<id>.json` con copie, colore, fronte/retro, formato e URI ricevuto dal pannello. Il lavoro sul sito passa a **completata** e il credito resta scalato. Se il file non è valido o `lp` fallisce, l’agente segnala l’errore e il sito rimborsa.

`node agent.js --once` fa un solo giro e esce: è il modo usato dal test end-to-end del sito.

## 3. Quando arriva la stampante

1. Nel pannello compila host/IP o URI, protocollo e capacità, poi abilita e rendi visibile.
2. Sul PC metti `"backend": "system"`.
3. Riavvia l’agente. Non serve altro: l’indirizzo lo legge dal sito.

Protocolli, come li applica l’agente:

- **IPP** — comando `lp` verso l’host (porta predefinita 631) con copie, `sides` (fronte o fronte/retro), `print-color-mode` e formato A4/A3. Su Linux e Mac `lp` c’è con CUPS. Il Dockerfile installa `cups-client`.
- **Coda CUPS** — `lp -d nome-coda` sulla coda già definita su quel computer.
- **Raw 9100** — invio TCP del PDF con intestazione PJL (copie, duplex, colore, carta). È il ripiego se non c’è CUPS. Non tutte le stampanti accettano PDF sulla 9100: se la tua vuole PCL, preferisci IPP.

Lo stato (in linea / offline) nel pannello dipende dal heartbeat, ogni giro. Se sul PC ci sono `lpstat` o `snmpget`, l’agente aggiunge un messaggio e, se la stampante risponde, il livello toner. Se non rispondono, la stampa funziona lo stesso e il pannello mostra «stato non disponibile».

Pagine: il sito prepara già il PDF con l’intervallo scelto dal membro. L’agente stampa quel file e applica le copie.

## 4. Linux (systemd)

```bash
sudo useradd --system --create-home --home-dir /opt/baseluna-print-agent baseluna || true
sudo mkdir -p /opt/baseluna-print-agent
sudo cp -a agent.js lib package.json /opt/baseluna-print-agent/
sudo cp print-agent.service /etc/systemd/system/baseluna-print-agent.service
```

Crea `/etc/baseluna-print-agent.env` (permessi `600`):

```
PRINT_SITE_URL=https://TUO-SERVIZIO.onrender.com
PRINT_AGENT_TOKEN=il-token-lungo
PRINT_AGENT_ID=studio-1
PRINT_BACKEND=file
PRINT_OUTPUT_DIR=/var/lib/baseluna-print
```

Poi:

```bash
sudo mkdir -p /var/lib/baseluna-print
sudo chown baseluna:baseluna /var/lib/baseluna-print /opt/baseluna-print-agent
sudo systemctl daemon-reload
sudo systemctl enable --now baseluna-print-agent
sudo journalctl -u baseluna-print-agent -f
```

Per la stampante vera, l’utente `baseluna` deve poter chiamare `lp` (gruppo `lp` dove serve) e `PRINT_BACKEND=system`.

## 5. Docker

Dalla cartella `print-agent`:

```bash
docker build -t baseluna-print-agent .
docker run --name baseluna-print --restart unless-stopped \
  -e PRINT_SITE_URL=https://TUO-SERVIZIO.onrender.com \
  -e PRINT_AGENT_TOKEN=il-token-lungo \
  -e PRINT_AGENT_ID=studio-1 \
  -e PRINT_BACKEND=file \
  -e PRINT_OUTPUT_DIR=/out \
  -v baseluna-print-out:/out \
  baseluna-print-agent
```

Il container deve raggiungere la stampante in LAN. Su Docker Desktop per Mac/Windows la rete della stampante non è sempre visibile: in quel caso tieni l’agente sul computer, senza Docker.

## 6. Mac

CUPS e `lp` ci sono già. Copia la cartella, compila `config.json`, poi `node agent.js`. Per avviarlo al login puoi usare un LaunchAgent, oppure la stessa unità systemd non c’è: va bene anche un terminale lasciato aperto o `launchctl`.

## 7. Windows

Installa Node 18+. Nel prompt, dalla cartella:

```bat
set PRINT_SITE_URL=https://TUO-SERVIZIO.onrender.com
set PRINT_AGENT_TOKEN=il-token-lungo
set PRINT_AGENT_ID=studio-1
set PRINT_BACKEND=file
node agent.js
```

`lp` di solito non c’è. Per una stampante vera scegli nel pannello il protocollo **Raw 9100** e sul PC `PRINT_BACKEND=system`: l’agente parla in TCP e non ha bisogno di CUPS. IPP su Windows richiede un comando `lp` (per esempio da un client CUPS) nel `PATH`.

## Se qualcosa non va

- «Nessuna stampante assegnata»: l’ID agente del pannello e quello del config non coincidono, oppure la stampante non è stata creata.
- Lavori fermi **in coda**: stampante disabilitata, senza IP, o agente spento. Nel pannello resta offline se l’ultimo heartbeat ha più di 90 secondi.
- **in stampa** per troppo tempo: l’agente ha preso il lavoro e si è spento prima di riferire l’esito. Dal pannello puoi rimborsare. Un secondo agente non ristampa un lavoro già preso.
- Credito: si scala all’invio. Errore, annullamento in coda o zero pagine stampate rimborsano da soli. Il saldo non va sotto zero.

La postazione di rilascio (release station, «stampa solo quando sono davanti alla macchina») non è inclusa.
