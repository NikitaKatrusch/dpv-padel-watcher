# DPV-Padel Turnier-Watcher

Prüft alle ~5 Minuten den Kalender der Venue (headless Chrome), sucht das
Turnier am 06.11. und meldet sich, sobald sich dessen Status ändert, besonders
wenn „Anmelden“ erscheint.

## Cloud (GitHub Actions, läuft ohne eigenen Rechner)

`.github/workflows/watch.yml` startet den Check per Zeitplan. Der letzte Status
liegt im Actions-Cache. Einrichten:

1. Repo auf GitHub (öffentlich, dann sind die Actions-Minuten unbegrenzt gratis).
2. Secret `NTFY_TOPIC` setzen (Repo → Settings → Secrets and variables → Actions).
   In der App „ntfy“ (iOS/Android) genau dieses Topic abonnieren.
3. Actions-Tab → „DPV Turnier-Watcher“ → „Run workflow“ für einen ersten Lauf.
   Im Log steht die gefundene Turnierkarte; im Artifact `debug` liegen
   Screenshot und Seitendaten.

Meldung kommt per ntfy-Push. Zusätzlich wird der Lauf bei einer Meldung rot,
dann schickt GitHub eine Mail.
Hinweis: GitHub führt Zeitpläne nicht sekundengenau aus; 5–15 Minuten Abstand
sind normal.

## Login

Das Portal zeigt den Kalender nur angemeldeten Nutzern. Der Watcher meldet sich
mit einem eigenen Testkonto an (Secrets `DPV_EMAIL` und `DPV_PASSWORD`, nur
E-Mail/Passwort-Login), speichert die Sitzung im Actions-Cache und meldet sich nur
bei abgelaufener Sitzung neu an. Schlägt der Login fehl, kommt eine Meldung und der
nächste Versuch folgt frühestens nach 1 h (steigend bis 6 h), damit das Konto
nicht gesperrt wird. Die Debug-Ausgabe auf dem Branch `debug-output` ist öffentlich:
E-Mail, Passwort und Tokens werden herausgefiltert, bei angemeldeten Läufen gibt es
kein HTML und nur den Hauptbereich als Bild. Für das Testkonto deshalb keinen
echten Namen verwenden.

## Lokal

    npm install && npm run setup
    NTFY_TOPIC=mein-topic npm start        # Dauerschleife
    node watch.js --once                   # einmal prüfen

Umgebungsvariablen: `INTERVAL_MIN` (5), `TARGET_DATE` (2026-11-06), `WATCH_URL`,
`NTFY_TOPIC`, `FAIL_ON_CHANGE=1`, `CHROME_CHANNEL=chrome`. `--debug` schreibt bei
jedem Check Screenshot und Daten nach `debug/`.
