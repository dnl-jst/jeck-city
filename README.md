# Nippes Nights

Open-world-Spiel in Köln-Nippes: Alle Besucher sind gleichzeitig auf der Neusser Straße, zu Fuß, mit dem Rad oder im Auto.
TypeScript, Three.js, Rapier, Colyseus (Server), Vite.

## Entwickeln

```
npm ci
npm run pipeline     # einmalig: lädt Open Data, erzeugt apps/client/public/world (~350 MB, nicht im Repository)
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
| `PUBLIC_URL` | – | öffentliche Adresse (optional) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Ohne Docker: ein bloßes `npm start` ohne `NODE_ENV=production` startet den Server im Entwicklungsmodus (Teleport, Fliegen, Schreib-Hooks für Tests). In Produktion immer `NODE_ENV=production` setzen; das Docker-Image tut das.

Mindestgröße: 2 vCPU und 2 GB RAM für 60 Spieler. Die Simulation läuft auf einem Kern; Messwerte und Lasttest:
`docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md` (`npm run loadtest`).

Logs enthalten keine Klartext-IP, sondern einen gesalzenen SHA-256-Präfix.

### Reverse Proxy

Den Container-Port nur lokal oder im privaten Netz veröffentlichen (`-p 127.0.0.1:2567:2567`) und TLS in einem Reverse Proxy
beenden. Der Server nimmt die Adresse des Spielers für die Beitrittsgrenze (5 pro Minute und Adresse) aus `X-Forwarded-For`/`X-Real-IP`.
Wäre der Port direkt erreichbar, könnte jeder diesen Header fälschen und die Grenze umgehen.
Beispiel mit Caddy: `deploy/Caddyfile.example`. WebSockets laufen ohne weitere Einstellung durch.

### Aktualisieren

Neues Image bauen (`npm run pipeline` nur, wenn sich die Welt geändert hat), dann den Container ersetzen:

```
docker build -f apps/server/Dockerfile -t nippes-nights .
docker stop nippes && docker rm nippes
docker run -d --name nippes --restart unless-stopped -p 127.0.0.1:2567:2567 -e MAX_PLAYERS=60 nippes-nights
```

Laufende Spieler werden dabei getrennt. Ein offener Client zeigt „Neue Version – bitte Seite neu laden.“, sobald er sich mit
der neuen Version verbinden will.
