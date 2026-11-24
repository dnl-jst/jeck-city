# Kachelweise Welt, Baustufe 1: Pipeline und Rohdaten-Spiegel – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Pipeline erzeugt die heutige Welt bytegleich, braucht dafür aber weniger als 4 GB Spitzen-RAM (heute 7,3 GB), und sie liest ihre Rohdaten aus einem festgehaltenen Stand statt von Overpass und den Landesservern.

**Architecture:** Die schweren Daten (Gebäude-Netze, gedrapte Straßenflächen, Bodennetze) entstehen nicht mehr für die ganze Welt, sondern Chunk für Chunk, und werden nach dem Schreiben freigegeben. Geplant wird weiter global, aber auf leichten Daten. Das Gelände bleibt in dieser Baustufe ein Raster im Speicher (152 MB – unkritisch beim heutigen Gebiet), ebenso bleibt die Kollision ein globaler Schritt. Rohdaten werden über `data/raw.lock.json` nach Inhalts-Hash aus `data/raw` oder dem Spiegel `raw/` im Bucket gelesen.

**Tech Stack:** TypeScript, Node 24, Vitest, `@gltf-transform`, `geotiff`, `fast-xml-parser`, `@aws-sdk/client-s3` (vorhanden), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-24-tiled-world-design.md`

## Global Constraints

- **Prüfstein:** Die erzeugte Welt ist Datei für Datei bytegleich mit der Referenzwelt (Task 3). Praktisch: derselbe Welt-Hash (Hash über `index.json`). Jede Aufgabe ab Task 4 endet mit diesem Vergleich.
- **Spitzen-RAM** des ganzen Laufs unter 4 GB (`maximum resident set size`), am Ende von Task 7 gemessen.
- Client, Server und `packages/shared` ändern sich in dieser Baustufe nicht. Das Weltformat ändert sich nicht.
- Ein normaler Pipeline-Lauf macht **keine** Anfrage an Overpass, opengeodata.nrw.de oder download.vrs.de. Er liest `data/raw` und den Spiegel und prüft jede Datei gegen `data/raw.lock.json`.
- Rohdateien im Spiegel: Schlüssel `raw/<hh>/<hash>.<endung>` (`<hash>` = erste 32 Hex-Zeichen SHA-256 des unkomprimierten Inhalts, wie bei `objects/`), `Cache-Control: public, max-age=31536000, immutable`, Brotli, wenn kleiner.
- Zugangsdaten werden nie geloggt und nie committet. Tests erreichen nie das Netz und nie den echten Bucket.
- Reihenfolgen sind Teil der Ausgabe: Gebäude in (Kachel-, dann Dokument-)Reihenfolge, Straßendreiecke in `f.roads`-Reihenfolge, Chunks nach `(iz, ix)`. Wer eine Schleife umbaut, erhält die Reihenfolge.
- Kein voller Pipeline-Lauf in Unit-Tests. Der volle Lauf (≈ 8 min, schreibt nach `--out`) ist ein eigener Prüfschritt.
- Code-Kommentare und Commits englisch; README deutsch.

## Abweichungen von der Spec (in der Spec nachgetragen)

- **Gelände bleibt in Baustufe 1 ein Raster im Speicher.** Die kachelweise Erzeugung des Geländes mit nachladender Quelle (und die absolute Rundung) wird ein eigener Schritt *vor der Gebietserweiterung*. Grund: Beim heutigen Gebiet belegt das Raster 152 MB; der Umbau der Wasser- und Brückenlogik auf Fenster ist der riskanteste Teil und bringt hier keinen messbaren Gewinn. Die 4-GB-Grenze wird ohne ihn erreicht.
- **Der Schritt „alte Pipeline flächenunabhängig machen“ entfällt bis auf die Fahrplan-Stichtage.** Die übrigen Abhängigkeiten vom Ganzen (tiefster Punkt für die Rundung, Reihenfolge der Markierungsarten) bleiben als ausdrückliche globale Vorberechnung erhalten; damit ist Bytegleichheit ohne Änderung der Ergebnisse möglich.

## Review Focus

1. **Eine Rohdatei fehlt, ist beschädigt oder passt nicht zum Hash** (abgebrochener Download, von Hand ersetzte Datei): Erwartung: Abbruch vor jeder Berechnung mit Dateiname und dem Befehl `npm run raw:update`; nie ein stiller Rückfall auf den Originalserver. → Task 2.
2. **Ein Dreieck, das mehrere Chunks überspannt** (kilometergroße Grünfläche, lange Straßengerade): Erwartung: Seine Teile landen genau in den Chunks, in denen sie heute landen, in derselben Reihenfolge; nichts doppelt, nichts verloren. → Task 5.
3. **Gebäude auf einer LoD2-Kachelgrenze** (in zwei Kacheln enthalten): Erwartung: genau einmal, an derselben Stelle der Reihenfolge wie heute. → Task 6.
4. **Der Fahrplan-Feed ist abgelaufen oder der Stichtag liegt außerhalb seiner Gültigkeit**: Erwartung: klare Fehlermeldung beim Aktualisieren, nicht erst beim Bau; ein einmal festgehaltener Stand baut auch Jahre später gleich. → Task 3.
5. **Abgebrochener Lauf** (Strg+C mitten im Schreiben der Chunks): Erwartung: Der Ausgabeordner enthält keine `index.json`, die zu den Dateien passt – der Server startet damit nicht (Prüfung aus Teil 1), und ein neuer Lauf ergibt wieder die Referenz. → Task 4.

---

### Task 1: Vergleichs- und Messwerkzeug

**Files:**
- Create: `packages/pipeline/src/compare/compare.ts`, `packages/pipeline/src/compare-worlds.ts` (CLI), `scripts/pipeline-peak.mjs`
- Modify: `packages/pipeline/src/main.ts` (Option `--out <dir>`), `package.json` (Skripte)
- Test: `packages/pipeline/src/compare/compare.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FileDiff = { name: string; kind: 'missing-a' | 'missing-b' | 'different'; detail?: string };
  /** Compares two world folders by their index.json (name → hash); `detail` explains a difference where it can. */
  export async function compareWorlds(a: string, b: string): Promise<{ same: boolean; worldHashA: string; worldHashB: string; diffs: FileDiff[] }>;
  ```
  `detail` für `terrain.bin`: Anzahl abweichender Höhen und größte Abweichung in cm; für `*.glb`: je Mesh-Name Anzahl Dreiecke und Vertices in A und B; für `manifest.json`: die abweichenden Schlüssel der obersten Ebene.
  - `npm run world:compare -- <dirA> <dirB>` → Exit-Code 0 bei Gleichheit, sonst 1 und die Liste.
  - `npm run pipeline -- --out <dir>` schreibt die Welt nach `<dir>` statt nach `apps/client/public/world` (alle Stellen, die heute `OUT_DIR` benutzen, einschließlich `--transit-only`).
  - `node scripts/pipeline-peak.mjs [--max <MB>] -- <pipeline-Argumente>`: startet den Lauf unter `/usr/bin/time` (`-l` auf macOS, `-v` auf Linux), gibt Laufzeit und Spitzen-RSS in MB aus; mit `--max` Exit-Code 1 bei Überschreitung.

- [ ] **Step 1: Failing tests** (zwei Ordner per `mkdtemp`, Index per `writeWorldIndex`):

```ts
it('two folders with identical files are the same and share the world hash', async () => {});
it('reports a file present on one side only', async () => { /* kind 'missing-a' / 'missing-b' */ });
it('reports a changed file as different', async () => {});
it('explains a terrain.bin difference: one height 3 cm off → "1 heights differ, max 3 cm"', async () => {
  // zwei TerrainGrids über encodeTerrain, eine Höhe um 0.03 verschoben
});
it('explains a manifest.json difference by top-level key', async () => { /* nur "lamps" geändert → detail nennt lamps */ });
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/compare` → FAIL.
- [ ] **Step 3:** Implementieren; `--out` in `main.ts` (ein Parameter statt der Konstante, Standard unverändert).
- [ ] **Step 4:** Tests → PASS; `npm run typecheck`.
- [ ] **Step 5: Ausgangsmessung** (kein Code): `mkdir -p data/reference && cp -c -R apps/client/public/world data/reference/world-0`; `data/reference/` in `.gitignore`. Dann `node scripts/pipeline-peak.mjs -- --out data/reference/run-0` und `npm run world:compare -- data/reference/world-0 data/reference/run-0`. Erwartung: gleich, Welt-Hash `43d9e34a3f1e`, Spitzen-RSS um 7,3 GB. Beide Zahlen in den Bericht. (Belegt, dass der Lauf auf diesem Rechner deterministisch ist, bevor irgendetwas umgebaut wird.)
- [ ] **Step 6:** Commit `feat(pipeline): compare two worlds, measure the pipeline's peak memory, --out`.

---

### Task 2: Rohdatenstand und Lesen aus dem Spiegel

**Files:**
- Create: `packages/pipeline/src/raw/lock.ts`, `packages/pipeline/src/raw/resolve.ts`, `data/raw.lock.json`
- Modify: `packages/pipeline/src/main.ts` (`ensureRaw` und alle `readFile(join(RAW_DIR, …))`), `packages/pipeline/src/fetch.ts` (Kachellisten bleiben; Download-Funktionen werden nur noch von Task 3 benutzt)
- Test: `packages/pipeline/src/raw/lock.test.ts`, `packages/pipeline/src/raw/resolve.test.ts`

**Interfaces:**
- Consumes: `contentHash` (`packages/pipeline/src/worldindex.ts`), `ObjectStore`-unabhängig: das Lesen aus dem Spiegel geht über `fetch` auf die öffentliche Adresse.
- Produces:
  ```ts
  export type RawLock = {
    version: 1;
    /** Public base URL of the mirror, with trailing slash; null: no mirror (local files only). */
    mirror: string | null;
    /** Logical path under data/raw → content hash and size, sorted by path. */
    files: Record<string, { hash: string; bytes: number }>;
    /** Sample days of the timetable as yyyymmdd: a weekday, a Saturday, a Sunday (Task 3). */
    gtfsDays?: [number, number, number];
  };
  export function parseRawLock(json: unknown): RawLock;
  export function rawKey(path: string, hash: string): string;            // 'raw/ab/ab12….gml'
  /** Makes every file of the lock present under `dir` with the right content; never asks an origin server. */
  export async function ensureRawFiles(lock: RawLock, dir: string, o?: { fetchFn?: typeof fetch; log?: (line: string) => void }): Promise<void>;
  ```
  Logische Pfade: `osm.json`, `transit-routes.json`, `lod2/<Kachel>.gml`, `dgm1/<Kachel>.tif`, `gtfs.zip` (ab Task 3).

- [ ] **Step 1: Failing tests**

```ts
it('a present file with the right hash is left alone (no fetch)', async () => {});
it('a missing file is fetched from <mirror><rawKey> and written atomically', async () => { /* erst .part, dann rename */ });
it('a present file with the wrong hash is replaced from the mirror', async () => {});
it('a mirror answer with the wrong content rejects, names the file and "npm run raw:update", leaves no file behind', async () => {});
it('without a mirror a missing file rejects with the same hint', async () => {});
it('a 404 from the mirror rejects with the same hint', async () => {});
it('the pipeline needs exactly the tiles of LOD2_TILES and DGM_TILES: a lock that lacks one rejects before any work', async () => {});
it('parseRawLock rejects a wrong version, a non-hex hash, a mirror without trailing slash', () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/raw` → FAIL.
- [ ] **Step 3:** Implementieren. `ensureRawFiles` prüft vorhandene Dateien per Hash (das kostet bei 1,7 GB einige Sekunden; in Ordnung).
- [ ] **Step 4:** `data/raw.lock.json` aus dem vorhandenen `data/raw` erzeugen (kleines Hilfsskript im Task-Bericht genügt; der dauerhafte Befehl dafür kommt in Task 3), `mirror: null`. In `main.ts` ersetzt `ensureRawFiles` den Aufruf von `ensureRaw`; die Optionen `--skip-fetch` und `--fetch-only` entfallen.
- [ ] **Step 5:** Tests → PASS; `npm run typecheck`; voller Lauf nach `data/reference/run-2` und `world:compare` gegen `world-0` → gleich.
- [ ] **Step 6:** Commit `feat(pipeline): pinned raw data (raw.lock.json), read from the mirror, no live fetch`.

---

### Task 3: Aktualisieren, Fahrplan, Erstbefüllung – die Referenzwelt

**Files:**
- Create: `packages/pipeline/src/raw/update.ts`, `packages/pipeline/src/update-raw.ts` (CLI), `packages/pipeline/src/raw/gtfs-zip.ts`
- Modify: `packages/pipeline/src/gtfs.ts` (Stichtage als Parameter, Zwischenspeicher-Schlüssel), `packages/pipeline/src/main.ts` (`withTimetable`: Fahrplan Pflicht, Entpacken), `package.json` (`raw:update`), `.gitignore`
- Test: `packages/pipeline/src/raw/update.test.ts`, Ergänzung `packages/pipeline/src/gtfs.test.ts` (falls nicht vorhanden: anlegen)

**Interfaces:**
- Consumes: `RawLock`, `rawKey`, `ensureRawFiles` (Task 2); `ObjectStore`, `s3Store` (`packages/pipeline/src/publish/`).
- Produces:
  ```ts
  /** The first Tuesday, Saturday and Sunday on or after `from` that the feed covers, as yyyymmdd. Throws if it covers none. */
  export function gtfsSampleDays(calendar: { start: number; end: number }[], from: Date): [number, number, number];
  /** loadGtfsTrips takes the sample days instead of a date; its cache is keyed by the zip's hash, the lines and the days. */
  export async function updateRaw(o: { dir: string; lockFile: string; what: ('osm' | 'tiles' | 'gtfs')[]; store: ObjectStore | null;
    mirror: string | null; fetchFn?: typeof fetch; now?: Date; log?: (line: string) => void }): Promise<RawLock>;
  ```
  `npm run raw:update -- [osm] [tiles] [gtfs]` (ohne Angabe: alles). Holt von den Originalservern (bestehender Code in `fetch.ts`; neu: `GTFS_URL` als `gtfs.zip`), schreibt nach `data/raw`, lädt – mit `S3_*` in der Umgebung – jede Datei, die im Spiegel fehlt, unter `rawKey` hoch und schreibt `data/raw.lock.json` (sortiert, mit `mirror` und `gtfsDays`). Ohne Zugangsdaten: lokale Dateien und Lock, `mirror` bleibt wie es war, mit Hinweis.
  Der Fahrplan wird beim Bau aus `data/raw/gtfs.zip` nach `data/cache/gtfs/<hash>/` entpackt (nur die sechs Tabellen aus `gtfs.ts`).

- [ ] **Step 1: Failing tests**

```ts
it('gtfsSampleDays: from Wed 2026-11-25 with a feed valid 20261101–20270131 → [20261201, 20261128, 20261129]', () => {});
it('gtfsSampleDays throws when the feed ended before `from`', () => {});
it('updateRaw uploads only files the mirror lacks and writes them under rawKey with br when smaller', async () => {});
it('updateRaw writes a lock that parseRawLock accepts, sorted by path, and a second run changes nothing', async () => {});
it('updateRaw without a store keeps the lock mirror and uploads nothing', async () => {});
it('a failed download of one tile leaves the old lock file untouched', async () => {});
it('loadGtfsTrips gives the same trips for the same days whatever the current date', async () => { /* kleine Fixture-Tabellen */ });
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/raw packages/pipeline/src/gtfs.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. `withTimetable` in `main.ts`: Fehlt `gtfs.zip` im Lock oder `gtfsDays`, bricht der Lauf mit Hinweis auf `npm run raw:update -- gtfs` ab; der Zweig „makeshift headway“ entfällt. Lizenzhinweis: `raw/LICENSE.txt` wird von `updateRaw` mit hochgeladen (Geobasis NRW dl-de/zero-2.0; © OpenStreetMap-Mitwirkende, ODbL; VRS-Fahrplandaten mit Quellenangabe und dem Lizenztext aus dem Feed, soweit vorhanden).
- [ ] **Step 4:** Tests → PASS; `npm run typecheck`; `npm test`.
- [ ] **Step 5 (führt die steuernde Sitzung aus, nicht der Umsetzende):** `npm run raw:update -- gtfs` mit den Zugangsdaten – lädt den Fahrplan, füllt den Spiegel mit dem **vorhandenen** `data/raw` (OSM und Kacheln werden nicht neu geholt), schreibt den Lock mit `mirror`. Prüfen: eine Rohdatei anonym aus dem Spiegel holen, Hash stimmt. Lizenzbedingungen des Feeds lesen; untersagen sie die Weitergabe ausdrücklich, vor dem Hochladen bei Daniel melden.
- [ ] **Step 6: Referenzwelt.** Voller Lauf nach `data/reference/world-1` mit `scripts/pipeline-peak.mjs`. Das ist die Referenz für alle folgenden Aufgaben. `world:compare world-0 world-1` → erwartet werden Unterschiede **nur** in `manifest.json` (Schlüssel `transit`) und in `index.json`; alles andere ist ein Befund. Welt-Hash und Spitzen-RSS in den Bericht und in die Kopfzeile von `data/raw.lock.json` gehört nichts davon – sie stehen im Commit-Text.
- [ ] **Step 7:** Zweiter voller Lauf nach `data/reference/run-3`, `world:compare world-1 run-3` → gleich (Fahrplan ist jetzt datumsfest).
- [ ] **Step 8:** Commit `feat(pipeline): raw:update, mirrored timetable with pinned sample days`.

---

### Task 4: Chunks einzeln bauen und schreiben

**Files:**
- Modify: `packages/pipeline/src/chunks.ts` (`buildChunks`), `packages/pipeline/src/main.ts` (Schleife ab „for (const c of buildChunks(…))“)
- Test: `packages/pipeline/src/chunks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Yields the chunks one at a time, sorted by (iz, ix) as before; nothing of a yielded chunk is kept. */
  export function* chunkGeometries(buildings: BuildingMesh[], streets: StreetMeshes, overrides: Overrides, area: Rect | undefined,
    terrain: TerrainGrid | undefined, extra: Partial<StreetMeshes>): Generator<ChunkGeometry>;
  ```
  `buildChunks` bleibt als dünne Hülle (`[...chunkGeometries(…)]`) für die bestehenden Tests.

- [ ] **Step 1: Failing test**

```ts
it('chunkGeometries yields exactly what buildChunks returned before: same keys in the same order, identical typed arrays', () => {
  // Fixture aus chunks.test.ts (Gebäude + Straßen + Gelände); Vergleich Feld für Feld inkl. ground
});
it('the ground mesh of a chunk is built when the chunk is yielded, not before', () => {
  // groundMesh über vi.spyOn zählen: nach dem ersten next() genau 1 Aufruf
});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/chunks.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren: Die Menge der Chunk-Schlüssel wird wie heute vorab bestimmt (Gebäude, Straßen, Bodenraster), Bodennetz und Gebäude-Batch entstehen erst beim Ausliefern. Die Straßen-Teilnetze je Chunk kommen in dieser Aufgabe weiter aus `splitMesh` (Task 5 ersetzt das). In `main.ts`: bauen → lochen → kodieren → schreiben → loslassen, ein Chunk nach dem anderen.
- [ ] **Step 4:** Tests → PASS. Voller Lauf nach `data/reference/run-4` unter `pipeline-peak.mjs`; `world:compare world-1 run-4` → **gleich**. Spitzen-RSS in den Bericht.
- [ ] **Step 5:** Abbruch prüfen: Lauf nach `data/reference/run-4b` starten und nach den ersten geschriebenen Chunks mit `kill -INT` beenden → `run-4b` enthält keine `index.json`.
- [ ] **Step 6:** Commit `perf(pipeline): build, encode and write one chunk at a time`.

---

### Task 5: Draping pro Chunk

**Files:**
- Create: `packages/pipeline/src/chunkdrape.ts`
- Modify: `packages/pipeline/src/drape.ts` (einzelnes Quelldreieck draperbar machen, ohne Verhalten zu ändern), `packages/pipeline/src/chunks.ts`, `packages/pipeline/src/main.ts` (Abschnitt „drape“ und `flatStreets`/`decks`)
- Test: `packages/pipeline/src/chunkdrape.test.ts`

**Interfaces:**
- Consumes: `drapeMesh`-Interna, `splitMesh`-Regeln (siehe unten), `chunkGeometries` (Task 4).
- Produces:
  ```ts
  /** A flat street mesh prepared for chunk-wise draping: its cropped source triangles, bucketed by the chunks their xz bbox touches. */
  export type FlatSource = { mesh: Mesh; trianglesByChunk: Map<string, Uint32Array>; markOrder?: number[] };
  export function prepareFlat(mesh: Mesh, area: Rect): FlatSource;
  /** The draped part of `src` that belongs to chunk (ix, iz): byte-identical to splitMesh(drapeMesh(cropMesh(mesh, area), terrain), area).get(key). */
  export function drapeChunk(src: FlatSource, terrain: TerrainGrid, ix: number, iz: number, area: Rect): Mesh | undefined;
  ```

**Die Regel, die exakt nachzubauen ist** (aus dem heutigen Code, `drape.ts`, `chunks.ts:87-116`, `main.ts:481-490`):
1. `cropMesh` behält Quelldreiecke, deren Schwerpunkt (Mittel der float32-x/z) in `area` liegt.
2. `drapeMesh` verarbeitet die Quelldreiecke in Index-Reihenfolge; verschweißt wird **nur innerhalb eines Quelldreiecks**; neue Vertices werden in der Reihenfolge ihrer ersten Verwendung nummeriert.
3. Mit `mark` (Markierungen): Dreiecke werden nach Mark-Wert gruppiert, in der Reihenfolge des **ersten Auftretens über das ganze beschnittene Netz**; jede Gruppe wird für sich gedrapt, die Gruppen hintereinandergehängt. `markOrder` hält diese Reihenfolge fest.
4. `splitMesh` läuft über die gedrapten Dreiecke in dieser Reihenfolge, ordnet jedes nach seinem float32-Schwerpunkt einem Chunk zu (nur innerhalb `area`) und nummeriert die Vertices je Chunk in der Reihenfolge der ersten Verwendung.

Für Chunk K heißt das: die Quelldreiecke, deren xz-Bounding-Box K berührt, in globaler Reihenfolge (bei Markierungen: Gruppe für Gruppe nach `markOrder`) **ganz** drapen, die Teile mit Schwerpunkt in K behalten, Vertices in Reihenfolge der ersten Verwendung nummerieren. Quelldreiecke können kilometergroß sein (Grünflächen); deshalb Auswahl über die Bounding-Box, kein fester Rand.

- [ ] **Step 1: Failing tests**

```ts
const reference = (m: Mesh, t: TerrainGrid, area: Rect) => splitMesh(drapeMesh(cropMesh(m, area), t), area);   // splitMesh/cropMesh dafür exportieren

it('equals the reference for every chunk of a ribbon crossing four chunks', () => {
  // gleiche Schlüsselmenge; je Chunk positions/uv/indices mit toEqual auf den Typed Arrays
});
it('a triangle 600 m wide lands in exactly the chunks the reference puts it in, nothing twice', () => {
  // Summe der Dreiecke über alle Chunks === Dreiecke der Referenz
});
it('vertical kerb faces (zero xz area) match the reference', () => {});
it('marked meshes keep the global first-appearance order of mark values', () => {
  // Mark-Werte 3,1,3,2 über zwei Chunks verteilt; ein Chunk sieht nur 2 und 3
});
it('a chunk no draped triangle falls into yields undefined', () => {});
it('triangles whose centroid lies outside the area are dropped as the reference drops them', () => {});
it('property test: 200 random flat meshes on a random terrain match the reference chunk by chunk', () => {
  // fester Seed; Dreiecke von 0,2 m bis 500 m Kantenlänge
});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/chunkdrape.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. In `main.ts` entfallen die global gedrapten `streets[name]` für die neun gedrapten Netze; `chunkGeometries` bekommt je Netzname eine `FlatSource` und ruft `drapeChunk`. Unverändert global bleiben: Wasserfläche, Brückenkörper, Stahl (klein), die Brückendecks (`decks`, nicht gedrapt, weiter per `splitMesh` angehängt) und das Lochen. Die Log-Zeilen „drape <name>: a → b triangles“ nennen weiter dieselben Zahlen (Summe über die Chunks).
- [ ] **Step 4:** Tests → PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 5:** Voller Lauf nach `data/reference/run-5`; `world:compare world-1 run-5` → **gleich**. Spitzen-RSS und Laufzeit in den Bericht (die Laufzeit darf steigen, weil große Dreiecke mehrfach gedrapt werden; über 25 % Mehrzeit ist ein Befund).
- [ ] **Step 6:** Commit `perf(pipeline): drape street meshes per chunk`.

---

### Task 6: Gebäude als leichte Datensätze, Netze pro Chunk

**Files:**
- Create: `packages/pipeline/src/buildingstore.ts`
- Modify: `packages/pipeline/src/main.ts` (LoD2-Schleife, alle Nutzer von `buildings`/`active`), `packages/pipeline/src/chunks.ts` (`chunkGeometries`, `buildCollision`), `packages/pipeline/src/placements.ts` (`shopSign`), `packages/pipeline/src/footprint.ts`
- Test: `packages/pipeline/src/buildingstore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** What every step except chunk batches, collision and shop signs needs of a building. */
  export type BuildingRecord = Pick<BuildingMesh, 'id' | 'centroid' | 'base' | 'buildingSeed' | 'flags'> & {
    footprint: Footprint;            // roof triangles in xz + bbox, as footprintOf(mesh) gives today
    tile: number;                    // index into LOD2_TILES
  };
  export class BuildingStore {
    /** Parses the tiles in order, keeps records, writes each tile's full meshes to `cacheDir`. Same order and de-duplication as today. */
    static async build(o: { tiles: string[]; rawDir: string; cacheDir: string; datum: number; terrain: TerrainGrid; boundary: Pt[] }): Promise<BuildingStore>;
    readonly records: readonly BuildingRecord[];                 // global order
    /** Full mesh of record i; meshes of at most `maxTiles` tiles are held at once (default 4). */
    mesh(i: number): Promise<BuildingMesh>;
    /** Records (with index) whose centroid lies in chunk `key`, in global order. */
    inChunk(key: string): readonly number[];
  }
  ```
  Alle Schritte, die heute `BuildingMesh[]` nur wegen Grundriss, Schwerpunkt, `flags`, `base`, `id` bekommen (Gehwegbreiten, Wasseranteil, Stadtbahn-Umgebung, Startpunkt, Laternen, Bäume, Parken, Bügel, Roller, Läden ohne Schild, Karte), arbeiten auf `BuildingRecord[]`. Volle Netze brauchen nur: die Gebäude-Batches der Chunks, `buildCollision` und `shopSign`.

- [ ] **Step 1: Failing tests** (mit den GML-Fixtures aus `packages/pipeline/fixtures`):

```ts
it('records are in (tile, document) order and a building present in two tiles appears once, in the first', async () => {});
it('record.footprint equals footprintOf(mesh) of the mesh built directly', async () => {});
it('mesh(i) is identical to buildBuildingMesh for that building (all typed arrays)', async () => {});
it('never holds meshes of more than maxTiles tiles', async () => { /* 3 Kacheln, maxTiles 1, Zugriff reihum */ });
it('a second build() over an unchanged cache dir gives the same records and meshes', async () => {});
it('buildings dropped by classifyBuildings are in neither records nor cache', async () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/buildingstore.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Zwischenablage je LoD2-Kachel als Binärdatei unter `data/cache/buildings/` (Schlüssel: Hash der Rohkachel + Hash des Gelände-Rasters T0 – ändert sich eines, wird neu gebaut). Die Gebäude stehen auf dem Gelände **vor** den Einschnitten (`main.ts`, erster `terrain`-Stand); das bleibt so.
- [ ] **Step 4:** `main.ts` und die Nutzer umstellen. `buildCollision` läuft weiter über alle Gebäude in globaler Reihenfolge, holt die Netze aber nacheinander aus dem Speicher. Reihenfolge der Kollisions-Vertices und der `ranges` in den Chunks bleibt (Review Focus 3).
- [ ] **Step 5:** Tests → PASS; `npm test`; `npm run typecheck`. Voller Lauf nach `data/reference/run-6`; `world:compare world-1 run-6` → **gleich**. Spitzen-RSS in den Bericht.
- [ ] **Step 6:** Commit `perf(pipeline): keep light building records, load full meshes per chunk`.

---

### Task 7: Auf 4 GB bringen und festschreiben

**Files:**
- Modify: nach Messung – in Frage kommen `packages/pipeline/src/chunks.ts` (`BatchBuilder`, `SoupBuilder`), `packages/pipeline/src/follow.ts`, `packages/pipeline/src/dgm.ts` (Mosaik und Weichzeichner), `packages/pipeline/src/main.ts` (Lebensdauer von `flatStreets`, `water`, `terrainBin`); `package.json` (`--max-old-space-size`)
- Test: bestehende Tests der berührten Dateien

- [ ] **Step 1: Messen.** Lauf mit `node --heap-prof` oder Protokoll von `process.memoryUsage()` an den Stufengrenzen (einmalig, nicht einchecken): Welche drei Stellen halten am Spitzenpunkt am meisten? Ergebnis in den Bericht.
- [ ] **Step 2: Ist die Spitze schon unter 4 GB?** Dann nur Schritte 4–6. Sonst die größten Posten in dieser Reihenfolge angehen, nach jedem voller Lauf mit `world:compare` gegen `world-1` (**gleich**) und neuer Messung, bis die Grenze unterschritten ist:
  1. Referenzen früh loslassen (Netze, die nach dem Chunk-Schreiben niemand mehr braucht).
  2. DGM-Kacheln nacheinander ins Mosaik lesen statt alle gleichzeitig; Weichzeichner ohne zweite volle Kopie, wo das die Werte nicht ändert.
  3. `number[]`-Sammler durch wachsende Typed Arrays ersetzen.
  4. Zeichenketten-Schlüssel beim Verschweißen durch Zahlen ersetzen – **nur** wenn nötig, und nur mit einem Test, der zeigt, dass dieselben Punkte verschmelzen wie zuvor (Achtung: `-0` und `0` ergeben heute denselben Schlüssel).
- [ ] **Step 3:** Jede dieser Änderungen hat ihren eigenen Commit und im Bericht: Posten, Spitze vorher, Spitze nachher.
- [ ] **Step 4:** `package.json`: `--max-old-space-size` im Skript `pipeline` (und `transit`) von 10240 auf 4096.
- [ ] **Step 5:** Abschlussmessung: `node scripts/pipeline-peak.mjs --max 4096 -- --out data/reference/run-7` → Exit-Code 0; `world:compare world-1 run-7` → **gleich**. Spitzen-RSS und Laufzeit gegen die Ausgangsmessung aus Task 1 in den Bericht.
- [ ] **Step 6:** Commit(s) `perf(pipeline): …`, zuletzt `chore(pipeline): 4 GB memory budget`.

---

### Task 8: CI, README

**Files:**
- Modify: `.github/workflows/docker-image.yml`, `README.md`, `apps/server/Dockerfile` (nur Kommentare, falls sie den alten Ablauf nennen)

- [ ] **Step 1: Workflow.** Die Schritte `month`, „Refresh OSM for a new month“ und das Sichern des Monats-Caches entfallen. Stattdessen: Cache für `data/raw` mit Schlüssel `raw-${{ hashFiles('data/raw.lock.json') }}`; die Pipeline füllt Fehlendes aus dem Spiegel (ohne Zugangsdaten). Der Schritt „Build the world“ läuft über `node scripts/pipeline-peak.mjs --max 4096 --` und scheitert bei Überschreitung. `timeout-minutes` bleibt 90.
- [ ] **Step 2:** YAML parst; die Schrittfolge für beide Varianten (`full`/`server`) von oben nach unten gegenlesen. Ausführen lässt sich der Workflow lokal nicht – im Bericht als „nicht geprüft“ nennen.
- [ ] **Step 3: README.** Abschnitt „Entwickeln“: `npm run pipeline` lädt die Rohdaten aus dem Spiegel (Größe nennen), kein Overpass mehr; neuer Abschnitt „Rohdaten“: `data/raw.lock.json`, `npm run raw:update -- [osm] [tiles] [gtfs]` (braucht `S3_*` zum Spiegeln), Lizenzhinweis im Spiegel, „ein neuer OSM-Stand ist ein Commit“; `npm run world:compare`; Speicherbedarf der Pipeline (4 GB) statt der bisherigen Angabe.
- [ ] **Step 4:** `npm run typecheck && npm test` → grün.
- [ ] **Step 5:** Commit `ci, docs: pinned raw data from the mirror, memory budget for the world build`.

---

## Offen nach diesem Plan (nicht Teil der Umsetzung)

- **Gelände kachelweise erzeugen** (nachladende Quelle, Wasser und Brücken auf Fenstern, absolute Rundung) – eigener Schritt vor der Gebietserweiterung.
- **Baustufe 2** (Kachelformat, Zugriffsschicht, breitere IDs, Client lädt nach Position) und **Baustufe 3** (Server lädt nach Spielern, nur Geändertes bauen) – eigene Pläne.
- Die Referenzordner unter `data/reference/` sind lokal und können nach dem Zusammenführen gelöscht werden.
