# Welt-Auslieferung über Objektspeicher und Neustart-Countdown – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weltdateien liegen unter ihrem Inhalts-Hash in einem öffentlichen S3-Bucket und werden von dort geladen; der Server kündigt Neustarts 60 s vorher im Spiel an, und der Client lädt danach von selbst neu.

**Architecture:** Die Pipeline schreibt `index.json` (Name → Inhalts-Hash) in den Weltordner; der Welt-Hash wird über diese Datei gebildet. Ein Publish-Befehl lädt fehlende Objekte in den Bucket. Der Client holt `index.json` und `/config.json` vom Spielserver und löst jeden Weltdatei-Namen über **eine** Klasse (`WorldFiles`) in eine URL auf – Bucket oder wie bisher `/world/`. Der Server fängt `SIGTERM` selbst ab, setzt `restartTick` im Raum-Zustand und beendet sich nach Ablauf.

**Tech Stack:** TypeScript, Node 24, Vitest, Colyseus / @colyseus/schema, `@aws-sdk/client-s3` (nur Entwicklungs-Abhängigkeit des Pipeline-Pakets), Docker, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-24-world-delivery-restart-design.md`

## Global Constraints

- Objekt-Schlüssel: `objects/<hh>/<hash>.<endung>`; `<hash>` = die ersten 32 Hex-Zeichen des SHA-256 über den **unkomprimierten** Inhalt, `<hh>` = dessen erste zwei Zeichen, Endung wie im logischen Namen.
- Objekte werden nie überschrieben. Kopfzeilen: `Cache-Control: public, max-age=31536000, immutable`, passender `Content-Type`, `Content-Encoding: br` (Brotli Qualität 5), außer die komprimierte Fassung ist nicht kleiner.
- `worlds/<worldHash>.json` wird **zuletzt** geschrieben und ist eine Kopie von `index.json`.
- Welt-Hash = `worldHash()` über die Bytes von `index.json` (12 Hex-Zeichen, unverändert).
- Der Server hängt beim Start nicht vom Bucket ab: Die Prüfung blockiert den Start nicht und lässt ihn nie scheitern.
- Ohne `WORLD_URL` verhält sich alles wie heute (Dateien unter ihrem Namen von `/world/`, `cache: 'no-cache'`).
- Signatur-Region des Buckets kommt aus `S3_REGION` (für Hetzner Nürnberg: `nbg1`).
- `RESTART_NOTICE_S`: Standard 60 in Produktion, 0 im Entwicklungsmodus; Bereich 0–600.
- Texte im Spiel deutsch; Stil wie bestehendes HUD (dunkler Grund, Akzent `#f2c46b`, `system-ui`).
- Tests erreichen nie das Netz und nie den echten Bucket.
- Zugangsdaten werden nie geloggt und nie committet (`.env` ist ausgeschlossen).

## Abweichungen von der Spec (in der Spec nachgetragen)

- Der Countdown steht als **`restartTick`** (Server-Tick, 0 = keiner) im Zustand, nicht als Uhrzeit in ms: Die Server-Uhr des Clients (`ServerClock`) rechnet in Ticks.
- Der Publish-Befehl komprimiert selbst und nutzt den Kompressions-Cache nicht: Brotli 5 schafft rund 40 MB/s pro Kern, und komprimiert wird nur, was im Bucket fehlt.

## Review Focus

1. **`index.json` passt nicht zu den Dateien** (Welt von Hand geändert, `--transit-only` vergessen, alter Weltordner ohne Index): Erwartung: Publish bricht mit klarer Meldung ab und lädt nichts hoch; der Server startet ohne `index.json` nicht und nennt `npm run world:index`. → Task 2, Task 3, Task 4.
2. **Bucket nicht erreichbar oder CORS fehlt, während ein Spieler lädt**: Erwartung: Fehlermeldung des Ladebildschirms wie bei jedem fehlgeschlagenen Download, kein stiller Rückfall auf den Spielserver, kein Hängen. → Task 5.
3. **Publish bricht mittendrin ab**: Erwartung: kein `worlds/<hash>.json`; der nächste Lauf lädt nur den Rest. → Task 3.
4. **Spieler tritt während des Countdowns bei oder verliert kurz die Verbindung**: Erwartung: sieht den Countdown mit richtiger Restzeit; ein Verbindungsabbruch **vor** dem Neustart führt nicht zum Neuladen gegen den alten Server. → Task 7, Task 8.
5. **Zweites `SIGTERM`, oder Docker beendet hart vor Ablauf** (`stop_grace_period` zu kurz): Erwartung: zweites Signal beendet sofort und sauber; Compose-Wert und README stimmen mit `RESTART_NOTICE_S` überein. → Task 6, Task 9.

---

### Task 1: Welt-Index im gemeinsamen Paket

**Files:**
- Create: `packages/shared/src/assets/world-index.ts`
- Modify: `packages/shared/src/index.ts` (Export)
- Test: `packages/shared/src/assets/world-index.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WorldIndex = { version: 1; files: Record<string, { hash: string; bytes: number }> };
  export const WORLD_INDEX_FILE = 'index.json';
  export const SERVER_WORLD_FILES = ['index.json', 'manifest.json', 'collision.bin', 'terrain.bin', 'transit-collision.bin'] as const;
  export function parseWorldIndex(json: unknown): WorldIndex;            // wirft bei falscher Form
  export function objectKey(name: string, hash: string): string;         // 'objects/ab/ab12….glb'
  export function worldObjectKey(worldHash: string): string;             // 'worlds/<worldHash>.json'
  export function worldFileUrl(index: WorldIndex, worldUrl: string | null, name: string): string;
  ```

- [ ] **Step 1: Failing tests**

```ts
it('objectKey keeps the extension and fans out by the first two characters', () => {
  expect(objectKey('chunk_0_1.glb', 'ab12cd34ab12cd34ab12cd34ab12cd34')).toBe('objects/ab/ab12cd34ab12cd34ab12cd34ab12cd34.glb');
  expect(objectKey('transit-collision.bin', 'ff00'.repeat(8))).toBe(`objects/ff/${'ff00'.repeat(8)}.bin`);
});
it('worldFileUrl: bucket when worldUrl is set, /world/<name> otherwise', () => {
  const index = { version: 1 as const, files: { 'map.json': { hash: 'ab'.repeat(16), bytes: 3 } } };
  expect(worldFileUrl(index, 'https://b.example/', 'map.json')).toBe(`https://b.example/objects/ab/${'ab'.repeat(16)}.json`);
  expect(worldFileUrl(index, null, 'map.json')).toBe('/world/map.json');
});
it('worldFileUrl throws for a name the index does not have, with or without worldUrl', () => {
  const index = { version: 1 as const, files: {} };
  expect(() => worldFileUrl(index, 'https://b.example/', 'x.glb')).toThrow(/x\.glb/);
  expect(() => worldFileUrl(index, null, 'x.glb')).toThrow(/x\.glb/);
});
it('parseWorldIndex rejects a wrong version, a non-hex or short hash, negative bytes', () => { /* je ein expect(...).toThrow() */ });
it('worldObjectKey', () => expect(worldObjectKey('0123456789ab')).toBe('worlds/0123456789ab.json'));
```

- [ ] **Step 2:** `npx vitest run packages/shared/src/assets/world-index.test.ts` → FAIL (Modul fehlt).
- [ ] **Step 3:** Implementieren. `parseWorldIndex` verlangt `version === 1` und je Datei `hash` = genau 32 Kleinbuchstaben-Hex-Zeichen, `bytes` = nicht negative ganze Zahl. Namen ohne Punkt bekommen keine Endung.
- [ ] **Step 4:** Test erneut → PASS. `npm run typecheck` → ohne Fehler.
- [ ] **Step 5:** Commit `feat(shared): world index (file name → content hash) and object keys`.

---

### Task 2: Pipeline schreibt `index.json`

**Files:**
- Create: `packages/pipeline/src/worldindex.ts`, `packages/pipeline/src/write-index.ts` (CLI)
- Modify: `packages/pipeline/src/main.ts` (Ende von `main()` und von `transitOnly()`), `package.json` (Skript `world:index`), `scripts/dev.mjs` (beobachtet `index.json` statt `manifest.json`)
- Test: `packages/pipeline/src/worldindex.test.ts`

**Interfaces:**
- Consumes: `WorldIndex`, `WORLD_INDEX_FILE` aus Task 1.
- Produces:
  ```ts
  export function contentHash(data: Uint8Array): string;                 // 32 Hex-Zeichen SHA-256 (node:crypto)
  export async function buildWorldIndex(dir: string): Promise<WorldIndex>;
  export async function writeWorldIndex(dir: string): Promise<WorldIndex>; // schreibt <dir>/index.json
  ```
  `npm run world:index` = `tsx packages/pipeline/src/write-index.ts` (Standardordner `apps/client/public/world`, optional ein Pfad als Argument).

- [ ] **Step 1: Failing tests** (mit `mkdtemp`):

```ts
it('lists every file except index.json, sorted by name, with size and hash', async () => {
  // Dateien: b.glb ('bb'), a.bin ('a'), index.json (alt), .DS_Store
  const index = await buildWorldIndex(dir);
  expect(Object.keys(index.files)).toEqual(['a.bin', 'b.glb']);
  expect(index.files['a.bin']).toEqual({ hash: contentHash(Buffer.from('a')), bytes: 1 });
});
it('writeWorldIndex is byte-identical for the same content and changes when one file changes at the same size', async () => { /* 'bb' → 'bc' */ });
it('rejects sub-directories', async () => { await expect(buildWorldIndex(dirWithSubdir)).rejects.toThrow(/flat/); });
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/worldindex.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Ausgelassen werden `index.json` und Namen, die mit `.` beginnen. Ausgabe: `JSON.stringify(index)` mit nach Namen sortierten Schlüsseln, ohne Leerraum.
- [ ] **Step 4:** In `main.ts` `await writeWorldIndex(OUT_DIR)` als **letzte** Schreiboperation von `main()` (nach `manifest.json`) und von `transitOnly()`. Die Größenübersicht am Ende von `main()` bleibt davor oder zählt `index.json` mit – beides ist in Ordnung.
- [ ] **Step 5:** `scripts/dev.mjs`: die Konstante `MANIFEST` zeigt auf `index.json`; Kommentar und Log-Text anpassen.
- [ ] **Step 6:** Test → PASS. `npm run world:index` im Worktree ausführen → `apps/client/public/world/index.json` existiert und nennt 1166 Dateien (Stand der hier erzeugten Welt; die genaue Zahl mit `ls apps/client/public/world | wc -l` minus 1 gegenprüfen).
- [ ] **Step 7:** Commit `feat(pipeline): write index.json with the content hash of every world file`.

---

### Task 3: Veröffentlichen und Aufräumen

**Files:**
- Create: `packages/pipeline/src/publish/store.ts` (Schnittstelle + Speicher im RAM), `packages/pipeline/src/publish/s3.ts`, `packages/pipeline/src/publish/publish.ts`, `packages/pipeline/src/publish/prune.ts`, `packages/pipeline/src/publish-world.ts` (CLI), `packages/pipeline/src/prune-world.ts` (CLI)
- Modify: `packages/pipeline/package.json` (`@aws-sdk/client-s3` als `devDependencies`), `package.json` (Skripte), `package-lock.json`
- Test: `packages/pipeline/src/publish/publish.test.ts`, `packages/pipeline/src/publish/prune.test.ts`

**Interfaces:**
- Consumes: Task 1 (`objectKey`, `worldObjectKey`, `parseWorldIndex`, `worldHash`), Task 2 (`contentHash`).
- Produces:
  ```ts
  export type PutMeta = { contentType: string; contentEncoding?: 'br'; cacheControl: string };
  export interface ObjectStore {
    list(prefix: string): Promise<{ key: string; lastModified: Date }[]>;   // alle Seiten
    get(key: string): Promise<Uint8Array>;                                  // gespeicherte Bytes, wie hochgeladen
    put(key: string, body: Uint8Array, meta: PutMeta): Promise<void>;
    delete(keys: string[]): Promise<void>;
  }
  export function memoryStore(): ObjectStore & { puts: string[]; meta: Map<string, PutMeta> };
  export function s3Store(env: Record<string, string | undefined>): ObjectStore;   // wirft, wenn eine S3_*-Variable fehlt
  export async function publishWorld(dir: string, store: ObjectStore, log?: (line: string) => void):
    Promise<{ worldHash: string; uploaded: number; uploadedBytes: number; present: number }>;
  export async function pruneWorlds(store: ObjectStore, o: { liveHash: string; keep: number; delete: boolean }):
    Promise<{ keptWorlds: string[]; removedWorlds: string[]; removedObjects: string[] }>;
  ```
  Skripte: `"world:publish": "node --env-file-if-exists=.env --import tsx packages/pipeline/src/publish-world.ts"`, `"world:prune": "node --env-file-if-exists=.env --import tsx packages/pipeline/src/prune-world.ts"`.

- [ ] **Step 1: Failing tests Veröffentlichen** (Weltordner per `mkdtemp`, Index per `writeWorldIndex`, `memoryStore()`):

```ts
it('uploads every file under its object key and writes worlds/<hash>.json last', async () => {
  const r = await publishWorld(dir, store);
  expect(store.puts.at(-1)).toBe(worldObjectKey(r.worldHash));
  expect(store.puts).toContain(objectKey('a.bin', index.files['a.bin']!.hash));
  expect(r).toMatchObject({ uploaded: 3, present: 0 });   // a.bin, b.glb, index-Kopie zählt nicht mit
});
it('a second run uploads no object and rewrites only worlds/<hash>.json', async () => { /* puts der 2. Runde === [worldObjectKey] ; present: 2 */ });
it('stores compressible files as br and incompressible ones raw', async () => {
  // a.bin = 10 000 × 'a' → meta.contentEncoding === 'br', brotliDecompress(get) ergibt das Original
  // r.bin = 64 Zufallsbytes → contentEncoding undefined, get === Original
});
it('sets content type by extension and the immutable cache header on every object', async () => {
  // .glb → model/gltf-binary, .bin → application/octet-stream, .json → application/json
  // cacheControl === 'public, max-age=31536000, immutable'
});
it('aborts before any upload when a file does not match index.json', async () => {
  // Datei nach writeWorldIndex ändern → rejects.toThrow(/world:index/); store.puts ist leer
});
it('an interrupted run leaves no worlds/<hash>.json and the next run uploads only the rest', async () => {
  // store.put wirft beim 2. Objekt → rejects; kein worlds/-Schlüssel; nächster Lauf: uploaded === Rest
});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/publish` → FAIL.
- [ ] **Step 3:** `store.ts` und `publish.ts` implementieren. Ablauf: `index.json` lesen und parsen → **alle** Dateien gegen ihren Hash prüfen (erst danach hochladen) → `store.list('objects/')` einmal → fehlende Objekte mit 8 gleichzeitigen Uploads → zuletzt `worlds/<worldHash>.json` (Inhalt = Bytes von `index.json`, wie ein Objekt komprimiert). Brotli: `BROTLI_PARAM_QUALITY` 5 mit `BROTLI_PARAM_SIZE_HINT`.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Failing tests Aufräumen:**

```ts
it('keeps the live world and the newest `keep` worlds with all their objects', async () => { /* 4 Welten, keep 1, live = älteste → 2 behalten */ });
it('removes worlds/…json and objects no kept world names', async () => { /* removedObjects genau die nur von entfernten Welten genannten */ });
it('never removes an object a kept world shares with a removed one', async () => {});
it('deletes nothing unless delete is true, but reports the same lists', async () => {});
it('throws when the live world has no worlds/<hash>.json in the store', async () => { /* rejects.toThrow(/live/) */ });
```

- [ ] **Step 6:** `prune.ts` implementieren (Indizes über `store.get` lesen und bei `br`-Inhalt entpacken; „jüngste“ nach `lastModified` der `worlds/…json`). Tests → PASS.
- [ ] **Step 7:** `s3.ts`: `S3Client` mit `endpoint: S3_ENDPOINT`, `region: S3_REGION`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`; `list` blättert mit `ContinuationToken`; `delete` in Blöcken zu 1000.
- [ ] **Step 8:** CLIs. `publish-world.ts [dir]` gibt Anzahl und Größe neuer und vorhandener Objekte aus. `prune-world.ts --live <healthz-URL> [--keep 5] [--delete]`: holt `worldHash` von `--live` (5 s Zeitlimit; nicht erreichbar oder Feld fehlt → Abbruch mit Exit-Code 1), druckt die Listen und den Hinweis „nicht ausführen, während ein Veröffentlichen läuft“.
- [ ] **Step 9: Probe gegen den echten Bucket** (Zugangsdaten in `.env`, `S3_REGION=nbg1`): `npm run world:publish` → Ausgabe nennt rund 1166 neue Objekte; ein zweiter Lauf nennt 0 neue. `curl -sI https://jeck-city.nbg1.your-objectstorage.com/worlds/<hash>.json` → `200`, `content-encoding: br`. Danach das Testobjekt `_test/br.bin` löschen.
- [ ] **Step 10:** `npm run typecheck` und `npm test` → grün. Commit `feat(pipeline): publish the world to object storage, prune old worlds`.

---

### Task 4: Server – Welt-Hash aus dem Index, `WORLD_URL`, `/config.json`, `/healthz`

**Files:**
- Modify: `apps/server/src/config.ts`, `apps/server/src/server.ts`, `apps/server/src/room.ts` (`health()`), `apps/server/src/bots/loadtest.ts`, `apps/server/src/room.test.ts`, `apps/server/src/config.test.ts`
- Create: `apps/server/src/world-published.ts`
- Test: `apps/server/src/world-published.test.ts`, Ergänzungen in `config.test.ts` und `room.test.ts`

**Interfaces:**
- Consumes: Task 1 (`WORLD_INDEX_FILE`, `worldObjectKey`).
- Produces:
  - `Config.worldUrl: string | null` (aus `WORLD_URL`; immer mit genau einem `/` am Ende; leer → `null`; ohne `http://` oder `https://` → Fehler beim Start) und `Config.restartNoticeS: number` (aus `RESTART_NOTICE_S`, siehe Global Constraints).
  - `GET /config.json` → `{ "worldUrl": string | null }`, `Cache-Control: no-cache`.
  - `GET /healthz` zusätzlich `worldHash: string` und `worldPublished: boolean | null` (`null` ohne `WORLD_URL` oder solange die Prüfung läuft).
  - `export async function checkWorldPublished(worldUrl: string, worldHash: string, fetchFn?: typeof fetch): Promise<boolean>` – `HEAD` auf `<worldUrl>worlds/<hash>.json`, 5 s Zeitlimit, jeder Fehler → `false`.

- [ ] **Step 1: Failing tests**

```ts
// config.test.ts
it('WORLD_URL gets exactly one trailing slash; empty is null; a value without scheme throws', () => {
  expect(loadConfig({ WORLD_URL: 'https://b.example' }).worldUrl).toBe('https://b.example/');
  expect(loadConfig({ WORLD_URL: 'https://b.example//' }).worldUrl).toBe('https://b.example/');
  expect(loadConfig({}).worldUrl).toBeNull();
  expect(() => loadConfig({ WORLD_URL: 'b.example' })).toThrow(/WORLD_URL/);
});
it('RESTART_NOTICE_S: 60 in production, 0 in dev, 0..600 accepted', () => {
  expect(loadConfig({ NODE_ENV: 'production' }).restartNoticeS).toBe(60);
  expect(loadConfig({}).restartNoticeS).toBe(0);
  expect(() => loadConfig({ NODE_ENV: 'production', RESTART_NOTICE_S: '601' })).toThrow();
});
// world-published.test.ts
it('true for 200, false for 404, false when fetch rejects, false after the timeout', async () => {});
it('asks for <worldUrl>worlds/<hash>.json with HEAD', async () => {});
// room.test.ts
it('/config.json answers { worldUrl: null } with no-cache', async () => {});
it('/healthz carries worldHash (the hash of index.json) and worldPublished null', async () => {});
it('a join with the hash of manifest.json is rejected as a version conflict', async () => {});   // alter Hash gilt nicht mehr
```

- [ ] **Step 2:** `npx vitest run apps/server` → die neuen Tests FAIL.
- [ ] **Step 3:** Implementieren. `server.ts` bildet den Hash über `index.json`; fehlt die Datei, wirft der Start: `index.json fehlt in <worldDir>: 'npm run world:index' ausführen`. Die Bucket-Prüfung startet nach `listen`, ohne `await`; bei `false` ein `warn`-Logeintrag. `room.test.ts` und `loadtest.ts` bilden ihren Hash ebenfalls über `index.json`; `haveAssets` in `room.test.ts` verlangt zusätzlich `index.json`.
- [ ] **Step 4:** `npx vitest run apps/server` → PASS. `npm run typecheck` → ohne Fehler.
- [ ] **Step 5:** Commit `feat(server): world hash from index.json, WORLD_URL, /config.json`.

---

### Task 5: Client lädt die Welt über `WorldFiles`

**Files:**
- Create: `apps/client/src/world-files.ts`
- Modify: `apps/client/src/boot.ts` (Zeilen um 174 und 356–385, 399), `apps/client/src/loader.ts` (Konstruktor, `init`, `load`, `loadBikeModels`, `loadCarModels`, `characterModels`, `loadModel`), `apps/client/src/downloads.ts` (`categoryOf`), `apps/client/vite.config.ts` (Proxy für `/config.json`)
- Test: `apps/client/src/world-files.test.ts`, Ergänzung in der bestehenden Testdatei zu `downloads.ts`

**Interfaces:**
- Consumes: Task 1 (`parseWorldIndex`, `worldFileUrl`, `WorldIndex`), Task 4 (`/config.json`, `/world/index.json`).
- Produces:
  ```ts
  export class WorldFiles {
    constructor(index: WorldIndex, worldUrl: string | null);
    url(name: string): string;                       // wirft bei unbekanntem Namen
    fetch(name: string): Promise<Response>;          // fetchOk; ohne worldUrl mit { cache: 'no-cache' }
    nameOf(url: string): string | null;              // logischer Name zu einer von url() gelieferten Adresse
  }
  export async function loadWorldFiles(fetchFn?: typeof fetch): Promise<{ files: WorldFiles; indexBytes: ArrayBuffer }>;
  ```
  `loadWorldFiles` holt `/world/index.json` (`no-cache`) und `/config.json` (`no-cache`). Antwortet `/config.json` nicht mit 200 (Offline-Modus, alter Server), gilt `worldUrl = null`.
  `WorldLoader` bekommt statt `baseUrl: string` ein `files: WorldFiles`.

- [ ] **Step 1: Failing tests**

```ts
it('fetch(name) asks the bucket URL without cache option when worldUrl is set', async () => {});
it('fetch(name) asks /world/<name> with cache: no-cache when worldUrl is null', async () => {});
it('url() throws a message naming the file when the index does not have it', () => { expect(() => files.url('x.glb')).toThrow(/x\.glb/); });
it('nameOf maps a bucket URL back to its logical name and returns null for other URLs', () => {});
it('loadWorldFiles: a 404 for /config.json means worldUrl null; a failing index.json rejects', async () => {});
// downloads
it('categoryOf classifies a bucket URL by its logical name', () => {
  expect(categoryOf('https://b.example/objects/ab/ab….glb', () => 'chunk_0_1.glb')).toBe('city');
  expect(categoryOf('https://b.example/objects/cd/cd….bin', () => 'collision.bin')).toBe('physics');
});
```

- [ ] **Step 2:** `npx vitest run apps/client/src/world-files.test.ts` → FAIL.
- [ ] **Step 3:** `world-files.ts` implementieren; `categoryOf(url, nameOf?)` und `DownloadMeter` um den optionalen Auflöser erweitern (in `boot.ts` mit `files.nameOf` verdrahten).
- [ ] **Step 4:** `boot.ts` und `loader.ts` umstellen: Kein `'/world/'`-Literal mehr außerhalb von `world-files.ts` und `packages/shared` (prüfen mit `grep -rn "'/world/\|\`/world/" apps/client/src` → nur `world-files.ts`). Der Welt-Hash für den Beitritt wird aus `indexBytes` gebildet. `manifest.json`, `collision.bin`, `terrain.bin`, `transit-collision.bin`, `map.json`, Chunks und alle Modelle gehen über `files.fetch(name)`.
- [ ] **Step 5:** `vite.config.ts`: `'/config.json': { target }` in `proxy`.
- [ ] **Step 6:** Tests → PASS. `npm run typecheck` → ohne Fehler.
- [ ] **Step 7: Probe im Browser** (`npm run dev`, ohne `WORLD_URL`): Spiel lädt, Netzwerk-Tab zeigt `/world/index.json` und Dateien unter `/world/`. Dann mit `WORLD_URL=https://jeck-city.nbg1.your-objectstorage.com/ npm run dev`: Weltdateien kommen vom Bucket. **Dieser zweite Teil setzt die CORS-Regel am Bucket voraus**; solange sie fehlt, zeigt der Ladebildschirm den Download-Fehler (Review Focus 2) – das als Ergebnis festhalten, nicht umgehen.
- [ ] **Step 8:** Commit `feat(client): resolve world files through the index, load from WORLD_URL`.

---

### Task 6: Server kündigt den Neustart an

**Files:**
- Create: `apps/server/src/restart.ts`
- Modify: `apps/server/src/state.ts` (`restartTick`), `apps/server/src/room.ts` (`announceRestart`, `playerCount`), `apps/server/src/server.ts` (Signale), `packages/shared/src/net/constants.ts` (`PROTOCOL_VERSION = 4`)
- Test: `apps/server/src/restart.test.ts`, Ergänzung in `room.test.ts`

**Interfaces:**
- Consumes: `Config.restartNoticeS` aus Task 4.
- Produces:
  - `NippesState.restartTick: t.float64()` (Standard 0).
  - `NippesRoom.announceRestart(seconds: number): void` → `state.restartTick = sim.tick + seconds * TICK_HZ`.
  - ```ts
    export type RestartDeps = { noticeS: number; players: () => number; announce: (seconds: number) => void;
      shutdown: () => Promise<void>; sleep?: (ms: number) => Promise<void> };
    /** Liefert den Signal-Handler: erster Aufruf startet den Countdown, zweiter beendet sofort. */
    export function restartOnSignal(deps: RestartDeps): () => Promise<void>;
    ```

- [ ] **Step 1: Failing tests**

```ts
it('announces, waits noticeS, then shuts down once', async () => { /* noticeS 60, sleep als Schein-Uhr → announce(60), shutdown nach 60 s */ });
it('shuts down at once without players', async () => { /* players: () => 0 → kein announce, shutdown sofort */ });
it('shuts down as soon as the last player has left during the countdown', async () => { /* players fällt nach 10 s auf 0 */ });
it('a second signal during the countdown shuts down at once, and shutdown still runs only once', async () => {});
it('noticeS 0 shuts down at once', async () => {});
// room.test.ts
it('announceRestart(60) sets restartTick about 3600 ticks ahead and a joining client sees it', async () => {
  // srv.room.announceRestart(60); neuer Client → state.restartTick − srv.room.sim.tick liegt in 3500..3600
});
```

- [ ] **Step 2:** `npx vitest run apps/server/src/restart.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Der Countdown prüft die Spielerzahl alle 250 ms. In `server.ts`: `gracefullyShutdown: false` an Colyseus; mit `opts.exitOnShutdown` eigene Handler für `SIGTERM` und `SIGINT`, deren `shutdown` das Wetter stoppt, `server.gracefullyShutdown(true)` aufruft und den Prozess beendet. Logeinträge `restart announced` (mit Sekunden und Spielerzahl) und `shutting down`.
- [ ] **Step 4:** `npx vitest run apps/server` → PASS.
- [ ] **Step 5: Probe:** `NODE_ENV=production RESTART_NOTICE_S=5 npm start`, in einem zweiten Terminal `kill -TERM <pid>` → ohne Spieler beendet sich der Prozess sofort; zweimal `kill -TERM` mit verbundenem Spieler beendet sofort.
- [ ] **Step 6:** Commit `feat(server): announce a restart on SIGTERM and shut down after the notice`.

---

### Task 7: Client zeigt den Countdown

**Files:**
- Create: `apps/client/src/restart-banner.ts`
- Modify: `apps/client/src/net/connection.ts` (`NetState.restartTick?: number`), `apps/client/src/boot.ts` (Render-Schleife, neben der Wetteranzeige)
- Test: `apps/client/src/restart-banner.test.ts`

**Interfaces:**
- Consumes: `restartTick` aus Task 6; `Connection.clock.estimate(nowMs)`; `TICK_HZ`.
- Produces:
  ```ts
  /** Sekunden bis zum Neustart, null ohne Ankündigung; nie negativ. */
  export function restartSecondsLeft(restartTick: number | undefined, serverTick: number): number | null;
  export function restartText(secondsLeft: number | null): string | null;
  export class RestartBanner { constructor(root: HTMLElement); set(secondsLeft: number | null): void; }
  ```

- [ ] **Step 1: Failing tests**

```ts
it('no announcement → null', () => { expect(restartSecondsLeft(0, 100)).toBeNull(); expect(restartSecondsLeft(undefined, 100)).toBeNull(); });
it('rounds up and never goes below 0', () => {
  expect(restartSecondsLeft(3600, 0)).toBe(60);
  expect(restartSecondsLeft(3600, 3541)).toBe(1);
  expect(restartSecondsLeft(3600, 4000)).toBe(0);
});
it('text', () => {
  expect(restartText(42)).toBe('Die Stadt wird aktualisiert – Neustart in 0:42');
  expect(restartText(75)).toBe('Die Stadt wird aktualisiert – Neustart in 1:15');
  expect(restartText(0)).toBe('Die Stadt wird aktualisiert – Neustart jetzt');
  expect(restartText(null)).toBeNull();
});
```

- [ ] **Step 2:** `npx vitest run apps/client/src/restart-banner.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Banner: `position: fixed`, oben mittig, `z-index` über dem HUD, dunkler Grund wie `.nn-weather`, Schrift `system-ui`; bei `secondsLeft <= 10` Klasse `nn-restart-soon` (Akzent `#f2c46b`, fett). Eigenes Element und eigenes `<style>` wie `WeatherBadge`; schreibt das DOM nur, wenn sich der Text ändert.
- [ ] **Step 4:** In `boot.ts` in der Render-Schleife setzen, nur im Online-Modus.
- [ ] **Step 5:** Tests → PASS; `npm run typecheck` → ohne Fehler.
- [ ] **Step 6:** Commit `feat(client): restart countdown banner`.

---

### Task 8: Client lädt nach dem angekündigten Neustart neu

**Files:**
- Create: `apps/client/src/restart-reload.ts`, `scripts/restart-check.mjs`
- Modify: `apps/client/src/boot.ts` (`conn.onStatus`, Zeile um 406)
- Test: `apps/client/src/restart-reload.test.ts`

**Interfaces:**
- Consumes: `/healthz` (`ticks`), `restartSecondsLeft` aus Task 7.
- Produces:
  ```ts
  export type ReloadDeps = { lastServerTick: number; fetchHealth: () => Promise<{ ticks: number } | null>;
    reload: () => void; sleep: (ms: number) => Promise<void>; random?: () => number; now?: () => number };
  /** true: neu geladen; false: nach 3 Minuten aufgegeben. */
  export async function reloadWhenRestarted(deps: ReloadDeps): Promise<boolean>;
  export const RESTART_TEXT = 'Die Stadt wird aktualisiert …';
  ```

- [ ] **Step 1: Failing tests** (Schein-Uhr über `sleep`/`now`):

```ts
it('polls every 2 s and reloads once /healthz reports fewer ticks than the old server had', async () => {
  // lastServerTick 50 000; Antworten: null, null, { ticks: 50 400 } (noch der alte), { ticks: 120 } → reload genau einmal
});
it('waits a random 0–5 s before reloading', async () => { /* random: () => 0.5 → 2 500 ms zwischen Erkennen und reload */ });
it('gives up after 180 s without reloading and resolves false', async () => {});
it('a health answer without a numeric ticks field counts as no answer', async () => {});
```

- [ ] **Step 2:** `npx vitest run apps/client/src/restart-reload.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** In `boot.ts`: Merken, ob zuletzt eine Ankündigung sichtbar war (`restartSecondsLeft(...) !== null`) und den letzten geschätzten Server-Tick. Wechselt der Status auf `reconnecting` oder `lost` **und** war ein Neustart angekündigt: `hud.setNetStatus(RESTART_TEXT)` und `reloadWhenRestarted` starten (nur einmal). Liefert es `false`: die bestehende Meldung „Verbindung verloren – bitte Seite neu laden.“ Ohne Ankündigung bleibt das Verhalten unverändert. Kommt die Verbindung von selbst zurück (`online`) und der Neustart steht noch aus, läuft das Abfragen weiter – der Vergleich über `ticks` verhindert ein Neuladen gegen den alten Server.
- [ ] **Step 5:** Tests → PASS; `npm run typecheck` → ohne Fehler.
- [ ] **Step 6: Durchgehender Browser-Test `scripts/restart-check.mjs`** (Playwright, Aufbau wie `scripts/mp-check.mjs`; `"restart-check": "node scripts/restart-check.mjs"` in `package.json`). Er automatisiert genau diesen Ablauf und endet mit Exit-Code 0: Server mit `NODE_ENV=production RESTART_NOTICE_S=20` starten, im Browser beitreten, `kill -TERM <pid>` → Banner zählt von 0:20 herunter, wird bei 0:10 hervorgehoben; nach dem Ende „Die Stadt wird aktualisiert …“; Server neu starten → Seite lädt innerhalb von 2–7 s von selbst neu. Gegenprobe: Server mit `kill -KILL` beenden → kein Banner, bisherige Meldung.
- [ ] **Step 7:** Commit `feat(client): reload by itself after an announced restart`.

---

### Task 9: Image, CI, Deploy, README

**Files:**
- Modify: `apps/server/Dockerfile`, `.github/workflows/docker-image.yml`, `deploy/docker-compose.yml`, `deploy/.env.example`, `README.md`, `package.json` (keine Versionsänderung – siehe `AGENTS.md`, die gehört zum Release)
- Create: `deploy/object-storage-cors.json` (liegt schon im Arbeitsverzeichnis, `AllowedOrigins: ["*"]`); `deploy/object-storage-cors.xml` dazu passend auf `*` stellen oder löschen

**Interfaces:**
- Consumes: `SERVER_WORLD_FILES` (Task 1), `world:publish` (Task 3), `WORLD_URL`/`worldPublished` (Task 4), `RESTART_NOTICE_S` (Task 6).

- [ ] **Step 1: Dockerfile.** `ARG WORLD_FILES=full`. Die Vorab-Prüfung der Weltdateien verlangt zusätzlich `index.json`. Bei `WORLD_FILES=server` werden nach dem Vite-Build und **vor** dem Komprimieren aus `apps/client/dist/world` alle Dateien außer `SERVER_WORLD_FILES` gelöscht; dazu wird `npm run build` in seine zwei Schritte zerlegt (`npm run build -w @nn/client`, dann `node scripts/precompress.mjs`). Ein anderer Wert als `full` oder `server` bricht den Build mit Meldung ab.
- [ ] **Step 2: Prüfen.** `docker build -f apps/server/Dockerfile --build-arg WORLD_FILES=server -t nn:server .` und `docker build -f apps/server/Dockerfile -t nn:full .` → `docker run --rm nn:server ls /app/apps/client/dist/world` zeigt nur die fünf Dateien samt `.br`/`.gz`; `docker images` zeigt `nn:server` deutlich kleiner als `nn:full` (Größen im Commit-Text nennen). `docker run -d -p 127.0.0.1:2567:2567 nn:server`, dann `curl -fsS localhost:2567/healthz` → enthält `"worldHash"`.
- [ ] **Step 3: Workflow.** Reihenfolge: Welt bauen → `typecheck` → `test` → **`npm run world:publish`** (Secrets `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` als `env`) → Image mit `build-args: WORLD_FILES=server` → Rauchtest → Push. Die Schritte `worldhash`, `precompress` (restore), „Compress the world“ und das zugehörige `cache/save` entfallen; stattdessen `mkdir -p .precompress-cache` vor dem Image-Bau (das Dockerfile kopiert den Ordner). Der Rauchtest startet den Container mit `-e WORLD_URL=${{ vars.WORLD_URL }}`, prüft zusätzlich `curl -fsS …/world/index.json`, `curl -fsS …/config.json | grep -q worldUrl` und – nach bis zu 10 s Warten – `"worldPublished":true` in `/healthz`; `docker stop -t 10` bleibt (ohne Spieler entfällt der Countdown).
- [ ] **Step 4: Deploy.** `deploy/docker-compose.yml`: `WORLD_URL: ${WORLD_URL:-}` und `RESTART_NOTICE_S: ${RESTART_NOTICE_S:-60}` unter `environment`, `stop_grace_period: 90s`. `deploy/.env.example`: beide Variablen mit Kommentar (Beispiel `WORLD_URL=https://jeck-city.nbg1.your-objectstorage.com/`).
- [ ] **Step 5: README.** Tabelle der Umgebungsvariablen um `WORLD_URL` und `RESTART_NOTICE_S` ergänzen; neuer Abschnitt „Welt im Objektspeicher“: Bucket öffentlich lesbar, CORS-Regel aus `deploy/object-storage-cors.json` (der Stand: Setzen wurde von Hetzner mit `AccessDenied` abgelehnt – offen), `.env` mit den fünf `S3_*`-Variablen, `npm run world:publish`, `npm run world:prune -- --live https://<domain>/healthz` (erst ohne, dann mit `--delete`; nicht während eines Veröffentlichens), `WORLD_FILES=server|full`. Bei „Aktualisieren“: `docker stop -t 90`, und dass Spieler 60 s vorher einen Countdown sehen. `npm run world:index` für einen Weltordner ohne Index erwähnen.
- [ ] **Step 6:** `npm run typecheck && npm test` → grün. Commit `build: slim server image, publish the world in CI, restart notice in deploy`.

---

## Offen nach diesem Plan (nicht Teil der Umsetzung)

- **CORS am Bucket** muss gesetzt sein, bevor `WORLD_URL` in Produktion gesetzt wird (Task 5 Step 7 zeigt das Ergebnis ohne Regel).
- **GitHub:** fünf Secrets `S3_*` und die Repository-Variable `WORLD_URL` anlegen (Daniel).
- **Release:** Versionsnummer und Tag nach `AGENTS.md`.
