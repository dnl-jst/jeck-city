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

Fehlt `apps/client/public/world/`, bricht der Build mit einer klaren Meldung ab. `.dockerignore` darf den Ordner nicht ausschließen.

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
| `NN_WEATHER` | `live` | `live`: alle 15 min von Open-Meteo; `off`: kein Abruf, klares Wetter; im Entwicklungsmodus auch ein festes Wetter: `clear`, `cloudy`, `mist`, `fog`, `drizzle`, `rain`, `heavyrain`, `snow` |

Ohne Docker: ein bloßes `npm start` ohne `NODE_ENV=production` startet den Server im Entwicklungsmodus (Teleport, Fliegen, Schreib-Hooks für Tests). In Produktion immer `NODE_ENV=production` setzen; das Docker-Image tut das.

Mindestgröße: 2 dedizierte vCPU mit hohem Einzelkern-Takt und 2 GB RAM für 60 Spieler; mit der großen Welt (≈ 800 MB)
braucht der leere Server schon ≈ 1,1 GB, daher besser 4 GB. Die Simulation läuft auf einem Kern; Messwerte und Lasttest:
`docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md` (`npm run loadtest`).

Logs enthalten keine Klartext-IP, sondern einen gesalzenen SHA-256-Präfix.

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
   nano .env            # DOMAIN=spiel.example.org, IMAGE=ghcr.io/dnl-jst/nippes-nights:latest, MAX_PLAYERS=60
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

Das Volume `caddy_data` enthält die Zertifikate: nicht löschen, sonst holt Caddy neue und läuft bei häufigen Neustarts in
die Rate-Limits von Let's Encrypt. Lokal ausprobieren lässt sich alles mit `DOMAIN=localhost` (Caddy stellt dann ein
eigenes Zertifikat aus, der Browser warnt einmal).

### Aktualisieren

Neues Image bauen (`npm run pipeline` nur, wenn sich die Welt geändert hat), dann den Container ersetzen:

```
docker build -f apps/server/Dockerfile -t nippes-nights .
docker stop nippes && docker rm nippes
docker run -d --name nippes --restart unless-stopped -p 127.0.0.1:2567:2567 -e MAX_PLAYERS=60 nippes-nights
```

Laufende Spieler werden dabei getrennt. Ein offener Client zeigt „Neue Version – bitte Seite neu laden.“, sobald er sich mit
der neuen Version verbinden will.
