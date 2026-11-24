# Jeck City

Open-World-Spiel in Köln (Repository-Name noch `nippes-nights`; Nippes, Neustadt-Nord, Altstadt-Nord, Altstadt-Süd, Neustadt-Süd): Alle Besucher sind gleichzeitig in derselben Stadt, zu Fuß, mit dem Rad oder im Auto. Los geht es auf der Domplatte. Vor dem Laden erklärt ein Intro-Screen das Spiel und warnt vor der Download-Größe (beim Build aus der erzeugten Welt gemessen).
TypeScript, Three.js, Rapier, Colyseus (Server), Vite.

## Entwickeln

```
npm ci
npm run pipeline     # einmalig: lädt Open Data, erzeugt apps/client/public/world (~1,3 GB, nicht im Repository)
npm run dev          # Spielserver + Vite
npm test
npm run typecheck
```

## Mehrspieler betreiben

Ein Docker-Image enthält Spielserver und fertigen Client auf einem Port (Standard 2567). Der Server liefert den Client selbst
aus (vorkomprimierte `.br`/`.gz`-Dateien) und bietet `/healthz`.

### Bauen

Die Welt liegt nicht im Repository. Vor dem Bauen im Repository-Wurzelverzeichnis erzeugen:

```
npm ci
npm run pipeline
docker build -f apps/server/Dockerfile -t nippes-nights .
```

Fehlt `apps/client/public/world/` (oder darin `index.json`, `manifest.json`, `collision.bin`, `terrain.bin`), bricht der
Build mit einer klaren Meldung ab. `.dockerignore` darf den Ordner nicht ausschließen.

Das Build-Argument `WORLD_FILES` bestimmt, wie viel Welt ins Image kommt:

- `full` (Standard): die ganze Welt; der Server liefert sie selbst unter `/world/` aus.
- `server`: nur die Dateien, die der Server lädt (`index.json`, `manifest.json`, `collision.bin`, `terrain.bin`,
  `transit-collision.bin`). Die Browser laden die Welt dann aus dem Objektspeicher (`WORLD_URL`, siehe
  „Welt im Objektspeicher“). Deutlich kleineres Image; ohne `WORLD_URL` startet es nicht (der Server meldet, dass
  Weltdateien aus `index.json` fehlen).

```
docker build -f apps/server/Dockerfile --build-arg WORLD_FILES=server -t nippes-nights .
```

Ein anderer Wert bricht den Build ab.

### Starten

```
docker run -d --name nippes --restart unless-stopped -p 127.0.0.1:2567:2567 -e MAX_PLAYERS=60 nippes-nights
curl localhost:2567/healthz
```

Umgebungsvariablen:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | 2567 | Port im Container |
| `MAX_PLAYERS` | 60 | gleichzeitige Spieler; bis 100 möglich, 100 nur auf einem schnelleren Einzelkern |
| `PUBLIC_URL` | – | nur nötig, wenn die Spiel-Verbindung über eine andere Adresse laufen soll als die Seite (z. B. `spiel.example.org`); ohne Angabe nutzt der Client die Adresse der Seite |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `WORLD_URL` | – | öffentliche Adresse der Welt im Objektspeicher (z. B. `https://jeck-city.nbg1.your-objectstorage.com/`); die Browser laden die Welt dann von dort, der Server prüft beim Start im Hintergrund, ob sie dort liegt (`worldPublished` in `/healthz`). Ohne Angabe liefert der Server die Welt selbst aus (Image mit `WORLD_FILES=full`) |
| `RESTART_NOTICE_S` | 60 (Entwicklung: 0) | Sekunden Countdown, den Spieler vor einem Neustart sehen (0–600). Bei `SIGTERM` (`docker stop`) kündigt der Server den Neustart an und beendet sich erst danach; ohne Spieler sofort |
| `NN_WEATHER` | `live` | `live`: alle 15 min von Open-Meteo; `off`: kein Abruf, klares Wetter; im Entwicklungsmodus auch ein festes Wetter: `clear`, `cloudy`, `mist`, `fog`, `drizzle`, `rain`, `heavyrain`, `snow` |

Ohne Docker: ein bloßes `npm start` ohne `NODE_ENV=production` startet den Server im Entwicklungsmodus (Teleport, Fliegen, Schreib-Hooks für Tests). In Produktion immer `NODE_ENV=production` setzen; das Docker-Image tut das.

Mindestgröße: 2 dedizierte vCPU mit hohem Einzelkern-Takt und 2 GB RAM für 60 Spieler; mit der großen Welt (≈ 800 MB)
braucht der leere Server schon ≈ 1,1 GB, daher besser 4 GB. Die Simulation läuft auf einem Kern; Messwerte und Lasttest:
`docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md` (`npm run loadtest`).

Logs enthalten keine Klartext-IP, sondern einen gesalzenen SHA-256-Präfix.

### Welt im Objektspeicher

Die Welt (über 1 GB) muss nicht im Image liegen: Sie liegt in einem S3-kompatiblen Bucket (Hetzner Object Storage),
das Image enthält nur die Server-Dateien (`WORLD_FILES=server`), und mit `WORLD_URL` laden die Browser die Welt direkt
aus dem Bucket. Die GitHub Action tut das nur, wenn die Repository-Variable `WORLD_URL` gesetzt ist: Dann lädt sie die
Welt vor dem Image-Bau in den Bucket und baut das schlanke Image. Ohne die Variable baut sie wie bisher das Image mit
der ganzen Welt (`WORLD_FILES=full`) und veröffentlicht nichts. Die Objekte heißen nach dem Hash ihres Inhalts
(`objects/<hh>/<hash>.<ext>`) und werden nie überschrieben; unveränderte Dateien lädt der Browser also aus seinem Cache,
und ein neues Veröffentlichen lädt nur geänderte Dateien hoch. `worlds/<welt-hash>.json` wird zuletzt geschrieben.

Einrichten:

1. Bucket anlegen und **öffentlich lesbar** machen.
2. CORS-Regel setzen, sonst dürfen Browser die Welt nicht vom Bucket laden (`deploy/object-storage-cors.json`, erlaubt
   `GET`/`HEAD` von jeder Herkunft), z. B. mit der AWS CLI:
   ```
   aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://deploy/object-storage-cors.json --endpoint-url <S3_ENDPOINT>
   ```
   **Stand:** Beim Hetzner-Bucket `jeck-city` wurde das Setzen mit `AccessDenied` abgelehnt (Schlüssel des Projekts) –
   noch offen. Solange die Regel fehlt, können Browser die Welt nicht aus dem Bucket laden: `WORLD_URL` weder in
   Produktion noch als Repository-Variable setzen; die Action baut dann das volle Image.
3. Zugangsdaten zum Veröffentlichen: lokal in `.env` im Repository-Wurzelverzeichnis (nicht im Repository), in der
   GitHub Action als Secrets gleichen Namens; die öffentliche Adresse als Repository-Variable `WORLD_URL`:
   ```
   S3_ENDPOINT=https://nbg1.your-objectstorage.com
   S3_REGION=nbg1
   S3_BUCKET=jeck-city
   S3_ACCESS_KEY_ID=…
   S3_SECRET_ACCESS_KEY=…
   ```

Veröffentlichen (die Action tut das bei gesetzter Repository-Variable `WORLD_URL` vor dem Image-Bau):

```
npm run pipeline         # oder eine vorhandene Welt
npm run world:index      # nur für einen Weltordner ohne index.json (die Pipeline schreibt ihn selbst)
npm run world:publish
```

Alte Welten aufräumen: behält die laufende Welt (aus `/healthz` des Live-Servers) und die letzten fünf. Erst ohne
`--delete` ansehen, was entfernt würde, dann mit `--delete` löschen; nicht während eines Veröffentlichens laufen lassen.

```
npm run world:prune -- --live https://<domain>/healthz
npm run world:prune -- --live https://<domain>/healthz --delete
```

### Reverse Proxy

Den Container-Port nur lokal oder im privaten Netz veröffentlichen (`-p 127.0.0.1:2567:2567`) und TLS in einem Reverse Proxy
beenden. Der Server nimmt die Adresse des Spielers für die Beitrittsgrenze (5 pro Minute und Adresse) aus `X-Forwarded-For`/`X-Real-IP`.
Wäre der Port direkt erreichbar, könnte jeder diesen Header fälschen und die Grenze umgehen.
Beispiel mit Caddy: `deploy/Caddyfile.example`. WebSockets laufen ohne weitere Einstellung durch.

### Mit Docker Compose und Caddy (empfohlen)

`deploy/` enthält eine fertige Kombination aus Spiel-Container und Caddy, der HTTPS-Zertifikate von Let's Encrypt
automatisch holt und erneuert. Der Spiel-Container veröffentlicht keinen Port, nur Caddy erreicht ihn.

Voraussetzungen auf dem Server: Docker mit Compose-Plugin, ein DNS-Eintrag (A/AAAA) der Domain auf den Server, Ports
80 und 443 (TCP, für HTTP/3 auch 443/UDP) offen.

1. `deploy/` auf den Server kopieren (`docker-compose.yml`, `Caddyfile`, `.env.example`), z. B. nach `/opt/nippes`.
2. Einstellungen anlegen und anpassen:
   ```
   cd /opt/nippes
   cp .env.example .env
   nano .env            # DOMAIN=spiel.example.org, IMAGE=ghcr.io/dnl-jst/nippes-nights:latest, MAX_PLAYERS=60,
                        # WORLD_URL (siehe „Welt im Objektspeicher“), RESTART_NOTICE_S=60
   ```
3. Ist das Image privat, einmal bei der GitHub Container Registry anmelden (Token mit `read:packages`):
   ```
   echo <TOKEN> | docker login ghcr.io -u <github-name> --password-stdin
   ```
4. Starten und prüfen:
   ```
   docker compose up -d
   docker compose logs -f caddy      # Zertifikat geholt? ("certificate obtained successfully")
   curl https://spiel.example.org/healthz
   ```

Aktualisieren auf ein neues Image (gebaut von der GitHub Action `.github/workflows/docker-image.yml` bei jedem Push
auf `main`):

```
docker compose pull game && docker compose up -d game
```

Compose gibt dem alten Container 90 s (`stop_grace_period`): Spieler sehen vorher 60 s lang einen Countdown
(`RESTART_NOTICE_S`), und ihre Seite lädt nach dem Neustart von selbst neu.

Das Volume `caddy_data` enthält die Zertifikate: nicht löschen, sonst holt Caddy neue und läuft bei häufigen Neustarts in
die Rate-Limits von Let's Encrypt. Lokal ausprobieren lässt sich alles mit `DOMAIN=localhost` (Caddy stellt dann ein
eigenes Zertifikat aus, der Browser warnt einmal).

### Aktualisieren

Neues Image bauen (`npm run pipeline` nur, wenn sich die Welt geändert hat), dann den Container ersetzen:

```
docker build -f apps/server/Dockerfile -t nippes-nights .
docker stop -t 90 nippes && docker rm nippes
docker run -d --name nippes --restart unless-stopped -p 127.0.0.1:2567:2567 -e MAX_PLAYERS=60 nippes-nights
```

`docker stop` schickt `SIGTERM`: Der Server kündigt den Neustart an, die Spieler sehen 60 s lang (`RESTART_NOTICE_S`)
einen Countdown, danach beendet er sich. `-t 90` lässt ihm dafür Zeit (der Standard von 10 s würde ihn vorher
abbrechen); ohne Spieler beendet er sich sofort. Nach dem Neustart lädt ein offener Client die Seite von selbst neu.
