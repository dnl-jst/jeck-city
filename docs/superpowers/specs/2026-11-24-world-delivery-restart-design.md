# Welt-Auslieferung über Objektspeicher und Neustart-Countdown – Design

## Absicht

Die Spielwelt soll bald ganz Köln umfassen und später weiter wachsen. Heute steckt die komplette Welt im
Docker-Image (aktuell 1,66 GB, davon 1,43 GB Chunks) und wird vom Spielserver selbst ausgeliefert – auf demselben
Prozess, der die Simulation rechnet. Jede Weltänderung macht ein neues, riesiges Image nötig, und der Browser prüft
jede Weltdatei bei jedem Besuch neu (`Cache-Control: no-cache`).

Dieses Design ist Teil 1 von 2. Es trennt die Auslieferung der Welt vom Spielserver und kündigt Neustarts im Spiel
an. Es arbeitet mit dem **heutigen** Weltformat. Teil 2 (kachelweise Pipeline, neues Weltformat) fügt sich später in
dasselbe Schema ein, ohne die Auslieferung noch einmal umzubauen.

## Ziele

- **Weltdateien liegen in einem öffentlich lesbaren S3-Bucket** (Hetzner Object Storage) und werden von dort direkt
  an den Browser ausgeliefert. Die Adresse ist konfigurierbar, sodass später ein CDN davorgeschaltet werden kann.
- **Dateien werden nie überschrieben.** Jede Datei liegt unter dem Hash ihres Inhalts; pro Weltstand gibt es nur
  einen kleinen Index, der auf die Dateien zeigt. Unveränderte Dateien werden zwischen Weltständen geteilt und
  nicht erneut hochgeladen.
- **Browser-Cache wirkt dauerhaft:** Dateien sind unveränderlich (`immutable`), ein wiederkehrender Spieler lädt
  nach einem Deploy nur, was sich wirklich geändert hat.
- **Das Docker-Image enthält nur noch, was der Server selbst liest** (Manifest, Kollision, Gelände).
- **Rollback** auf einen älteren Weltstand ist das Deployen des älteren Images; dessen Dateien liegen noch im Bucket.
- **Neustart-Countdown:** Wird der Server für ein Deploy beendet, sehen alle Spieler vorher einen Countdown. Nach
  dem Neustart lädt der Client von selbst neu.
- **Entwicklung bleibt wie heute:** Ohne konfigurierten Bucket lädt der Client die Welt wie bisher vom Spielserver
  bzw. von Vite.

## Nicht-Ziele (jetzt)

- Kein neues Weltformat, keine Kacheln, keine Änderung an der Pipeline-Ausgabe (Teil 2).
- Kein Deploy ohne Unterbrechung: Der Server startet weiterhin neu, alle Spieler werden kurz getrennt.
- Kein Erhalt des Spielzustands über den Neustart (umgestellte Autos, liegende Laternen gehen wie heute verloren).
- Kein CDN-Vertrag, keine eigene Domain für den Bucket, keine signierten URLs. Die Daten sind offen.
- Audio, Porträts und der Client-Code bleiben im Image (klein, ändern sich mit dem Code).

## Anti-Ziele

- Ein Spieler darf nie einen neuen Index mit alten Dateien mischen oder umgekehrt.
- Ein neues Image darf nie live gehen, bevor seine Welt vollständig im Bucket liegt.
- Der Server darf beim Start nicht vom Bucket abhängen: Fällt der Bucket aus, läuft der Server trotzdem hoch.

## Ansätze

**Wie liegen die Dateien im Bucket?**

1. *Überschreiben am festen Ort.* Am einfachsten, aber während eines Uploads und zwischen Upload und Neustart sieht
   ein Spieler gemischte Stände; kein Rollback; Cache muss immer neu prüfen.
2. *Ein Ordner pro Version.* Sauber getrennt und mit Rollback, aber jede Version lädt die ganze Welt neu hoch
   (ganz Köln: grob 15 GB) und der Browser-Cache ist nach jedem Deploy wertlos.
3. *Nach Inhalts-Hash, plus Index pro Weltstand.* Dateien sind unveränderlich und werden geteilt; ein Deploy lädt
   nur Geändertes; Rollback inklusive; Cache wirkt dauerhaft. Kostet ein Aufräum-Skript.

**Gewählt: 3.** Daniel hat dem im Gespräch zugestimmt.

**Wie wird der Countdown ausgelöst?**

1. *Durch das Stopp-Signal selbst:* Der Server fängt `SIGTERM` ab, kündigt an, wartet, beendet sich. Braucht keine
   zusätzliche Infrastruktur; `docker compose up -d` löst es von allein aus.
2. *Durch einen Admin-Aufruf vor dem Deploy.* Flexibler (beliebige Texte, Abbrechen), braucht aber einen
   geschützten Endpunkt und einen zweiten Schritt, den man vergessen kann.

**Gewählt: 1.** Daniel hat dem im Gespräch zugestimmt.

## Aufbau im Bucket

```
objects/<hh>/<hash>.<endung>     unveränderliche Weltdateien (hh = die ersten zwei Hex-Zeichen des Hashs)
worlds/<worldHash>.json          Kopie des Index eines Weltstands (Nachweis „veröffentlicht“, Grundlage fürs Aufräumen)
```

- `<hash>`: die ersten 32 Hex-Zeichen des SHA-256 über den **unkomprimierten** Inhalt. Die Endung (`.glb`, `.bin`,
  `.json`) bleibt für den `Content-Type` erhalten.

## Welt-Index und Welt-Hash

Heute ist der Welt-Hash der SHA-256 über `manifest.json` allein (`worldHash()` in
`packages/shared/src/sim/assets.ts`). Das Manifest nennt aber weder `collision.bin` noch `map.json`, und Chunks nur
mit ihrer Größe: Zwei verschiedene Welten können denselben Hash tragen. Für unveränderliche Dateien im Bucket reicht
das nicht. *(Vom Prüfer gefunden; die Lösung ist mein Vorschlag.)*

- Die Pipeline schreibt als letzten Schritt `apps/client/public/world/index.json`:
  ```json
  { "version": 1, "files": { "chunk_0_1.glb": { "hash": "ab12…", "bytes": 2373224 }, … } }
  ```
  Darin steht **jede** andere Datei des Weltordners (auch `manifest.json`, `collision.bin`, `terrain.bin`,
  `transit-collision.bin`, `map.json`), nach Namen sortiert, `bytes` unkomprimiert. `--transit-only` schreibt den
  Index ebenfalls neu. Das ist die einzige Änderung an der Pipeline.
- **Der Welt-Hash ist künftig der Hash über `index.json`** (dieselbe Funktion, andere Eingabe). Er ändert sich damit
  bei jeder Änderung an irgendeiner Weltdatei. Der Beitritts-Abgleich in `apps/server/src/room.ts` bleibt, wie er ist.
- Der Objekt-Schlüssel ergibt sich aus dem Index: `objects/<hash[0..2]>/<hash>.<endung>`.
- `worlds/<worldHash>.json` im Bucket ist eine Kopie von `index.json`. Der Client liest sie nicht; sie zeigt an, dass
  der Weltstand vollständig hochgeladen ist, und sagt dem Aufräumen, welche Objekte gebraucht werden.
- Kopfzeilen jedes Objekts und des Index: `Cache-Control: public, max-age=31536000, immutable`, passender
  `Content-Type`.
- **Kompression:** Objekte werden Brotli-komprimiert gespeichert und mit `Content-Encoding: br` ausgeliefert; ist
  die komprimierte Fassung nicht kleiner, wird die Datei roh gespeichert. Das Veröffentlichen komprimiert selbst
  (Brotli 5, rund 40 MB/s pro Kern) und nur, was im Bucket fehlt; der Kompressions-Cache der Image-Erstellung wird
  dafür nicht gebraucht.
- **CORS:** Der Bucket erlaubt `GET` und `HEAD` von jedem Ursprung (`*`). Die Daten sind offen, und so funktionieren
  auch lokale Tests gegen den echten Bucket.

**Erste Aufgabe, bevor irgendetwas gebaut wird:** mit einer Testdatei prüfen, dass Hetzner Object Storage ein
gespeichertes `Content-Encoding: br` und die CORS-Regel wie erwartet ausliefert. Liefert Hetzner `Content-Encoding`
nicht zuverlässig aus, ist der Ausweichweg: Objekte gzip-komprimiert speichern, ohne `Content-Encoding`, mit Endung
`.gz`, und der Client entpackt mit `DecompressionStream('gzip')`.

**Ergebnis der Prüfung (24.11.2026, Bucket `jeck-city` in `nbg1`, Adresse
`https://jeck-city.nbg1.your-objectstorage.com/`):**

- `Content-Encoding: br`, `Content-Type` und `Cache-Control` werden so ausgeliefert, wie sie beim Hochladen gesetzt
  wurden; ein anonymer Abruf funktioniert, und `fetch` entpackt die Datei korrekt. **Der Ausweichweg über gzip
  entfällt.** Hetzner liefert die Brotli-Fassung unabhängig von `Accept-Encoding` aus – für Browser unkritisch.
- Die Signatur-Region ist `nbg1` (aus der Endpunkt-Adresse), nicht frei wählbar.
- **CORS ist noch offen:** Ohne Regel sendet der Bucket keine `Access-Control-Allow-Origin`-Kopfzeile, und das Setzen
  der Regel wurde mit dem bereitgestellten Schlüssel abgelehnt (`AccessDenied`). Die Regel muss gesetzt sein, bevor
  der Client Dateien aus dem Bucket laden kann.

## Veröffentlichen (`npm run world:publish`)

Ein Skript unter `scripts/`, das `apps/client/public/world/` in den Bucket bringt:

1. `index.json` lesen, jede Datei gegen ihren Hash prüfen und komprimieren (Cache nutzen).
2. Jedes Objekt, das im Bucket noch fehlt, hochladen. Vorhandene werden nicht angefasst.
3. **Zuletzt** `worlds/<worldHash>.json` schreiben. Erst damit gilt der Weltstand als veröffentlicht. Liegt die
   Datei schon dort, wird sie mit demselben Inhalt neu geschrieben (das frischt ihr Datum auf).
4. Ausgabe: Anzahl und Größe der neuen und der bereits vorhandenen Objekte.

Ein abgebrochener Lauf hinterlässt nur Objekte ohne Index; der nächste Lauf setzt dort fort. Das Skript ist
wiederholbar: Ein zweiter Lauf mit derselben Welt lädt nichts hoch.

Zugangsdaten kommen aus der Umgebung: `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`. In GitHub als Secrets hinterlegt; lokal aus der Shell.

**Aufräumen (`npm run world:prune`):** ein **von Hand** gestarteter Befehl, nicht Teil der CI. *(Mein Vorschlag:
Die CI veröffentlicht auch bei manuellen Läufen von Branches; ein automatisches „die jüngsten N behalten“ könnte so
die laufende Welt löschen.)*

- Ohne `--delete` zeigt er nur an, was er löschen würde.
- `--live <URL>` (Pflicht): die `/healthz`-Adresse des laufenden Spiels. Der dort gemeldete Weltstand wird immer
  behalten; ist die Adresse nicht erreichbar, bricht der Befehl ab.
- `--keep <N>` (Standard 5): zusätzlich die N jüngsten Weltstände nach Änderungsdatum ihrer `worlds/…json`.
- Gelöscht werden die übrigen `worlds/…json` und alle Objekte, die kein behaltener Weltstand nennt.
- Nicht ausführen, während ein Veröffentlichen läuft (steht in der Ausgabe und im README).

`/healthz` meldet dafür zusätzlich `worldHash`.

## Client

- Der Client fragt beim Start `GET /config.json` am Spielserver ab: `{ "worldUrl": "https://…/" | null }`
  (`Cache-Control: no-cache`).
- `index.json` lädt er **vom Spielserver** (`/world/index.json`, `no-cache`) und bildet daraus den Welt-Hash. Der
  Server ist damit die einzige Stelle, die bestimmt, welcher Weltstand gilt; der Bucket wird dafür nicht gefragt.
- Ist `worldUrl` gesetzt: jede Weltdatei – auch `manifest.json` – über `<worldUrl>objects/<hh>/<hash>.<endung>`.
  Fehlt ein Name im Index, ist das ein Fehler mit klarer Meldung, kein stiller Rückfall auf den Spielserver.
- Ist `worldUrl` `null`: jede Datei wie heute unter ihrem Namen von `/world/` am Spielserver.
- Die Auflösung „logischer Name → URL“ sitzt an **einer** Stelle (heute sind die `/world/`-Pfade über `boot.ts` und
  `loader.ts` verteilt). `cache: 'no-cache'` entfällt für Dateien aus dem Bucket.
- Die Größenwarnung auf dem Intro-Screen (`apps/client/src/build/download-size.ts`) bleibt unverändert: Sie wird
  beim Bau aus dem lokalen Weltordner gemessen, und der ist in der CI vorhanden.

## Server und Image

- Neue Umgebungsvariable `WORLD_URL` (leer = Welt vom Spielserver). `/config.json` gibt sie aus.
- Mit gesetzter `WORLD_URL` prüft der Server beim Start einmal, ob `worlds/<worldHash>.json` erreichbar ist. Wenn
  nicht: Warnung im Log und `worldPublished: false` in `/healthz` – der Server läuft trotzdem (Anti-Ziel).
- Das Dockerfile bekommt ein Build-Argument `WORLD_FILES`:
  - `full` (Standard): wie heute, die ganze Welt im Image. Lokales Bauen und Betrieb ohne Bucket funktionieren
    weiter wie im README beschrieben.
  - `server`: nur `index.json` und die Dateien, die der Server liest (`loadWorldAssets`: `manifest.json`,
    `collision.bin`, `terrain.bin`, `transit-collision.bin`). Das baut die CI. *(Mein Vorschlag, nicht besprochen.)*
- `/world/index.json` wird in beiden Varianten vom Spielserver ausgeliefert.

## CI (`.github/workflows/docker-image.yml`)

Reihenfolge: Welt bauen → Typprüfung und Tests → **Welt veröffentlichen** → Image mit `WORLD_FILES=server` bauen →
Rauchtest → Image pushen. Schlägt das Veröffentlichen fehl, wird kein Image gepusht. Der Rauchtest
prüft zusätzlich `worldPublished: true`, wenn er mit `WORLD_URL` läuft.

`deploy/.env.example` und `deploy/docker-compose.yml` bekommen `WORLD_URL`.

## Neustart-Countdown

**Ablauf**

1. Der Server bekommt `SIGTERM` (oder `SIGINT`).
2. Er setzt im Raum-Zustand `restartTick` (Server-Tick; 0 = kein Neustart angekündigt) auf den Tick in
   `RESTART_NOTICE_S` Sekunden. *(Ticks statt Uhrzeit: Die Server-Uhr des Clients rechnet in Ticks.)* Der Wert liegt im Zustand, nicht in einer Nachricht, damit auch Spieler ihn sehen,
   die während des Countdowns beitreten.
3. Das Spiel läuft unverändert weiter. Nach Ablauf fährt der Server wie heute geordnet herunter.
4. Ein zweites Signal während des Countdowns beendet sofort.

`RESTART_NOTICE_S`: Standard 60 in Produktion, 0 im Entwicklungsmodus (dort beendet sich der Server wie heute
sofort). Sind keine Spieler verbunden, entfällt das Warten.

Colyseus fängt die Signale heute selbst ab (`gracefullyShutdown` in `apps/server/src/server.ts`); das übernimmt der
Server künftig selbst.

**Anzeige im Client**

Ein Banner oben in der Mitte, über dem Spiel, solange `restartTick` gesetzt ist:

```
┌──────────────────────────────────────────────┐
│  Die Stadt wird aktualisiert – Neustart in 0:42  │
└──────────────────────────────────────────────┘
```

Die Restzeit rechnet der Client aus `restartTick` und seiner Server-Uhr (`apps/client/src/net/clock.ts`). In den
letzten 10 Sekunden wird das Banner hervorgehoben. Als eigenes Bauteil gebaut, wie die Wetteranzeige.

**Nach dem Neustart**

Wird die Verbindung getrennt, **nachdem** ein Neustart angekündigt war, zeigt der Client „Die Stadt wird
aktualisiert …“, fragt `/healthz` im Abstand von 2 s ab und lädt die Seite neu, sobald der Server antwortet – mit
0–5 s zufälliger Verzögerung, damit nicht alle gleichzeitig laden. Antwortet der Server 3 Minuten lang nicht,
erscheint die normale Fehlermeldung mit Knopf zum Neuladen. Trennungen ohne Ankündigung (Absturz, Netz) verhalten
sich wie heute.

**Betrieb**

- `stop_grace_period` in `deploy/docker-compose.yml`: von 10 s auf 90 s (Countdown + Herunterfahren).
- README: `docker stop -t 90` für den Betrieb ohne Compose.
- Das neue Zustandsfeld ändert das Protokoll: `PROTOCOL_VERSION` wird erhöht.

## Tests

- Veröffentlichen gegen einen nachgebildeten S3-Speicher: zweiter Lauf lädt nichts hoch; Index kommt zuletzt;
  abgebrochener Lauf lässt sich fortsetzen.
- Aufräumen: behält den laufenden Weltstand und alles, was ein behaltener Weltstand nennt; löscht ohne `--delete`
  nichts; bricht ab, wenn `--live` nicht antwortet.
- Welt-Hash: ändert sich, wenn sich nur `collision.bin` oder nur ein Chunk bei gleicher Größe ändert.
- Client-Auflösung: mit und ohne `worldUrl`; fehlender Name im Index ergibt einen Fehler.
- Server: `SIGTERM` setzt `restartTick` und beendet erst nach Ablauf; zweites Signal beendet sofort; ohne Spieler
  kein Warten.
- Ein durchgehender Test mit Browser (wie `scripts/mp-check.mjs`): Countdown erscheint, nach Neustart lädt die Seite neu.

## Dem Umsetzenden überlassen

- Die S3-Bibliothek (Vorschlag: `@aws-sdk/client-s3` als Entwicklungs-Abhängigkeit) und der Aufbau der Skripte.
- Parallelität beim Hochladen.
- Aussehen des Banners im Detail (Farben, Schrift), passend zum bestehenden HUD.
- Wo die Namensauflösung im Client sitzt und wie sie in `boot.ts`/`loader.ts` eingehängt wird.

## Einrichtung durch Daniel

- Bucket bei Hetzner Object Storage anlegen, öffentlich lesbar.
- Zugangsschlüssel mit Schreibrecht erzeugen und als GitHub-Secrets hinterlegen (Namen siehe oben).
- `WORLD_URL` in `deploy/.env` auf dem Server setzen.
