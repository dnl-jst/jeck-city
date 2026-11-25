# Kachelweise Welt, Baustufe 4: Gelände ohne ganzes Raster im Speicher – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Pipeline hält nie mehr das ganze Geländeraster oder ein Raster in dessen Größe im Speicher (Höhen, Wassermaske, Wasserspiegel, Abstandsfeld) – bei bytegleicher Welt.

**Architecture:** Jede der vier Geländefassungen (T0 geglättet, T1 nach Einschnitten, T2 nach Flussbett, T3 nach Rampen) liegt als Datei im Format von `terrain.bin` auf der Platte. Gelesen wird über einen Block-Zwischenspeicher: als kleines `TerrainGrid`-Fenster für dichte Schleifen (Chunk, Gebäudekachel) oder als Punktabfrage für verstreute. Änderungen an einer Fassung entstehen in dünn besetzten, seitenweise angelegten Rastern und werden in einem Durchlauf über die Datei zur nächsten Fassung. Das Wasser (Maske, Spiegel, Abstand) lebt ebenfalls in dünn besetzten Rastern. T0 entsteht bandweise aus den DGM-Kacheln.

**Tech Stack:** TypeScript, Node 24 (`node:fs` mit Positionslesen), Vitest, `geotiff`.

**Spec:** `docs/superpowers/specs/2026-11-24-tiled-world-design.md` (Abschnitte „Gelände in Durchgängen“ und „Stufe 4“)

## Global Constraints

- **Prüfstein:** Die erzeugte Welt ist bytegleich mit `data/reference/world-1` (Welt-Hash `4f2df36c7e41`). Jede Aufgabe ab Task 3 endet mit `node scripts/pipeline-peak.mjs --max 4096 -- --out data/reference/run-<task>` und `npm run world:compare -- data/reference/world-1 data/reference/run-<task>` → gleich.
- **Kein Feld in Rastergröße:** Nach Task 6 legt kein Code der Pipeline mehr ein Array mit `cols × rows` Einträgen an. Geprüft per Suche und durch die Speichermessung.
- **Rundung bleibt, wie sie ist:** Jede Fassung wird wie heute relativ zum tiefsten Punkt *dieser Fassung* auf 1 cm gerundet (`base = floor(min·100)/100`, `cm = round((h − base)·100)`, dekodiert `Float32(base + cm/100)`). Der tiefste Punkt ist eine ausdrückliche globale Vorberechnung über die Datei. Die absolute Rundung aus der Spec kommt mit dem Kachelformat (Stufe 2), nicht hier – sonst ginge der Bytevergleich verloren.
- Die vier Fassungen und wer welche liest, bleiben exakt: Gebäude lesen **T0**; Wasser wird auf **T1** gefunden; Brücken werden auf **T2** geplant; alles Weitere liest **T3**; `terrain.bin` ist T3.
- Am Rand der Welt wird geklemmt wie heute (`heightAt` klemmt auf das Raster; Bodennormalen sind dort einseitig). Ein Fenster darf nie an einer Kante klemmen, die nicht der Weltrand ist.
- `packages/shared`, Client und Server ändern sich nicht. Das Weltformat ändert sich nicht.
- Kein voller Pipeline-Lauf in Unit-Tests. Rohdaten nur aus dem festgehaltenen Stand; kein Netz in Tests.
- Reihenfolgen sind Teil der Ausgabe (siehe die Regeln je Aufgabe). Code-Kommentare und Commits englisch.

## Abweichung von der Spec (in der Spec nachgetragen)

- Die „Rundung ohne Blick auf die ganze Welt“ wird nicht in dieser Stufe umgesetzt (siehe Global Constraints). Der Test „dieselbe Kachel in kleiner und großer Welt“ entfällt damit bis Stufe 2.

## Review Focus

1. **Abfrage außerhalb eines Fensters** (Gebäude ragt über seine Kachel, senkrechte Bordsteinfläche über den Chunk): Erwartung: dieselbe Höhe wie aus dem ganzen Raster – über die Punktabfrage –, nie ein still geklemmter Wert. → Task 1, Task 5.
2. **Wasser, das eine Blockgrenze oder den Weltrand erreicht**: Erwartung: Flutung, Spiegel, Abstandsfeld und Uferkante sind dieselben wie mit vollen Rastern. → Task 3.
3. **Welt ohne Fluss / ohne Einschnitte / ohne Brücken**: Erwartung: Der Lauf funktioniert, und Fassungen ohne Änderung werden wie heute behandelt (ohne Einschnitte bleibt T1 = T0, ohne neues Runden). → Task 4.
4. **DGM-Kacheln in anderer Reihenfolge, fehlende Kachel, Kachel mit NoData**: Erwartung: dieselben Fehlermeldungen wie heute, bevor etwas geschrieben wird; die Reihenfolge der Kacheln ändert das Ergebnis nicht. → Task 2.
5. **Abgebrochener Lauf hinterlässt halbe Geländedateien im Arbeitsordner**: Erwartung: Der nächste Lauf räumt sie weg und baut neu; nie wird eine halbe Datei gelesen. → Task 1, Task 6.

---

### Task 1: Geländedatei mit Block-Zwischenspeicher, dünn besetzte Raster, Höhenabfrage

**Files:**
- Create: `packages/pipeline/src/terrain/file.ts`, `packages/pipeline/src/terrain/sparse.ts`, `packages/pipeline/src/terrain/height.ts`
- Test: `packages/pipeline/src/terrain/file.test.ts`, `sparse.test.ts`, `height.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sparse.ts — pages of 256 × 256 cells, allocated on first write
  export class SparseRaster<A extends Float32Array | Uint8Array> {
    constructor(cols: number, rows: number, make: (n: number) => A, fill: number);
    get(c: number, r: number): number;                 // `fill` where no page exists
    set(c: number, r: number, v: number): void;
    has(c: number, r: number): boolean;                // true once the cell's page exists
    /** Allocated pages in row-major page order: [page column, page row, data]. */
    pages(): Iterable<[number, number, A]>;
    readonly cols: number; readonly rows: number;
  }
  // file.ts — one terrain version on disk, in terrain.bin's layout (NNT1)
  export class TerrainFile {
    static open(path: string, o?: { blocks?: number }): TerrainFile;          // header only; default 64 cached blocks
    readonly x0: number; readonly z0: number; readonly cols: number; readonly rows: number; readonly datum: number;
    readonly base: number; readonly path: string;
    get(c: number, r: number): number;                                         // decoded height, as decodeTerrain gives it
    /** A real TerrainGrid for cells [c0, c1] × [r0, r1] (clipped to the grid), decoded exactly. */
    window(c0: number, r0: number, c1: number, r1: number): TerrainGrid;
    windowAt(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, marginCells: number): TerrainGrid;
    min(): number; max(): number; borderMin(): number;                         // one streaming pass each, cached
    contentHash(): string;                                                     // of the file bytes
    close(): void;
  }
  /** Writes the next version: every cell = edits.get(c, r) where the edits have it (as Float32), else prev's height;
   *  re-quantised with the new global minimum. Two streaming passes, written to `path` atomically. */
  export function commitVersion(prev: TerrainFile, edits: SparseRaster<Float32Array> | null, editedMask: SparseRaster<Uint8Array> | null,
    path: string): TerrainFile;
  /** Streams a full grid to a new file: `rows(r)` gives the Float32 heights of row r (called twice: min pass, write pass). */
  export function writeTerrainFile(path: string, header: { x0: number; z0: number; cols: number; rows: number; datum: number },
    rows: (r: number, out: Float32Array) => void): TerrainFile;
  // height.ts
  export type Heights = TerrainGrid | TerrainSampler;
  export class TerrainSampler { constructor(file: TerrainFile, fast?: TerrainGrid); }   // `fast`: a window tried first
  /** Same value as @nn/shared heightAt on the whole decoded grid — for a grid, a window (inside it) or a sampler. */
  export function heightAt(h: Heights, x: number, z: number): number;
  ```
  Ob eine Zelle geändert ist, sagt `editedMask` (nicht ein Sonderwert in `edits`).

- [ ] **Step 1: Failing tests**

```ts
// file.test.ts
it('a file written by writeTerrainFile is byte-identical to encodeTerrain of the same grid', () => { /* 300×270, zufällige Höhen */ });
it('get, window and windowAt return exactly decodeTerrain(bytes).heights for every cell', () => {});
it('window clips at the grid and keeps x0/z0 integer-aligned', () => {});
it('min, max and borderMin equal the reductions over the decoded grid', () => {});
it('commitVersion without edits is byte-identical to encodeTerrain(decodeTerrain(prev))', () => {});
it('commitVersion with edits equals: decode, assign the edited Float32 values, encodeTerrain — also when an edit lowers the global minimum', () => {});
it('reads work with a cache of 1 block (every access evicts)', () => {});
it('a truncated file or a wrong magic is refused on open with the path in the message', () => {});
it('commitVersion writes atomically: no file at the target path if it throws midway', () => {});
// sparse.test.ts
it('unwritten cells read the fill value; has() is false until the page exists', () => {});
it('cells on page borders and in the last partial page round-trip', () => { /* cols 300, rows 270 */ });
it('pages() lists allocated pages in row-major page order', () => {});
// height.test.ts
it('heightAt(sampler) equals @nn/shared heightAt on the whole grid at 20 000 random points, including outside the grid (clamped)', () => {});
it('heightAt(sampler with a fast window) uses the same value inside and outside the window', () => {});
it('heightAt on a plain TerrainGrid is @nn/shared heightAt', () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/terrain` → FAIL.
- [ ] **Step 3:** Implementieren. Blöcke von 256 × 256 Zellen plus eine gemeinsame Randzeile und -spalte zum Nachbarblock; die Punktabfrage holt den Block als `TerrainGrid` und ruft darauf `heightAt` aus `@nn/shared` – am Weltrand klemmt das wie im ganzen Raster, sonst liegt der Punkt nie auf einer Blockkante, an der geklemmt würde. Der zuletzt benutzte Block wird ohne Tabellenzugriff wiedergefunden.
- [ ] **Step 4:** Tests → PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat(pipeline): terrain versions on disk, sparse rasters, height lookup`.

---

### Task 2: T0 bandweise aus den DGM-Kacheln

**Files:**
- Create: `packages/pipeline/src/terrain/dgmstream.ts`
- Modify: `packages/pipeline/src/dgm.ts` (nur Exporte, falls nötig)
- Test: `packages/pipeline/src/terrain/dgmstream.test.ts`

**Interfaces:**
- Consumes: `writeTerrainFile`, `TerrainFile` (Task 1); `readDgmTile`, `TERRAIN_SIGMA`, `gaussBlur`, `mosaic`, `terrainFromMosaic` (`dgm.ts`, nur noch als Referenz im Test).
- Produces:
  ```ts
  /** T0: the blurred DGM sampled on the world grid, quantised — byte-identical to
   *  encodeTerrain(terrainFromMosaic(gaussBlur(mosaic(tiles), sigma), area)), without ever holding the mosaic. */
  export async function buildT0(o: { tiles: string[]; read: (name: string) => Promise<Mosaic>; area: Rect; sigma: number; path: string;
    maxTiles?: number }): Promise<TerrainFile>;
  ```

**Was exakt nachzubauen ist** (`dgm.ts`): Weichzeichner mit Radius `ceil(3σ)`, erst waagerecht (Summe in float64, Ergebnis in ein Float32-Feld), dann senkrecht über das Zwischenergebnis, an den Kanten **des Mosaiks** geklemmt; danach bilineare Abtastung an ganzzahligen lokalen Koordinaten (jeder Rasterpunkt ist das Mittel aus vier geglätteten Pixeln, in der Arithmetik von `sampleMosaic`); `datum = round(at(0, 0)·10)/10` wird vorab aus dem Band um den Ursprung bestimmt; Höhen = Abtastwert − `datum`. Fehler wie heute: Auflösung ≠ 1 m, NoData in einer Kachel, Lücke im Mosaik, Raster außerhalb des Mosaiks – alle **vor** dem ersten Schreiben.

- [ ] **Step 1: Failing tests** (künstliche Kacheln von 40 × 40 Pixeln):

```ts
it('equals the reference chain byte for byte for a 3 × 3 mosaic and an area well inside it', async () => {});
it('equals the reference when the area touches the mosaic edge (clamped blur)', async () => {});
it('the tile order does not matter', async () => {});
it('never holds more than maxTiles decoded tiles (maxTiles = one tile row + the two neighbouring rows)', async () => {});
it('a missing tile rejects with "mosaic has gaps" before any file is written', async () => {});
it('a tile with NoData rejects before any file is written', async () => {});
it('an area outside the mosaic rejects with the same message as terrainFromMosaic', async () => {});
it('property test: 30 random mosaics (1–4 tiles per side), random sigma in {0.5, 1, 2}, random area', async () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/terrain/dgmstream.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren: Kachelzeile für Kachelzeile von Nord nach Süd; im Speicher die aktuelle Zeile und ihre beiden Nachbarzeilen; ein gleitendes Fenster von `2·r + 1` waagerecht geglätteten Pixelzeilen für den senkrechten Durchgang; Rasterzeilen gehen fortlaufend an `writeTerrainFile` (das zweimal durchläuft: Minimum, dann Schreiben – die Zwischenablage der unquantisierten Zeilen liegt auf der Platte, nicht im Speicher).
- [ ] **Step 4:** Tests → PASS; `npm run typecheck`. Kein voller Lauf in dieser Aufgabe (noch nicht verdrahtet).
- [ ] **Step 5:** Commit `feat(pipeline): build the base terrain band by band from the DGM tiles`.

---

### Task 3: Wasser auf dünn besetzten Rastern

**Files:**
- Modify: `packages/pipeline/src/water.ts`, `packages/pipeline/src/bridges.ts` (`isWater`), `packages/pipeline/src/riverfixture.ts` (nur falls für Tests nötig)
- Test: `packages/pipeline/src/water.test.ts`

**Interfaces:**
- Consumes: `SparseRaster`, `TerrainFile`, `Heights` (Task 1).
- Produces:
  ```ts
  export type Water = { mask: SparseRaster<Uint8Array>; level: SparseRaster<Float32Array>; meanLevel: number;
    /** Number of water points (was: sum over the mask). */ area: number };
  export function findWater(t: TerrainFile, rivers: Pt[][]): Water;
  /** The river bed as edits for commitVersion; returns them and the number of lowered points. */
  export function carveRiverBed(t: TerrainFile, w: Water): { edits: SparseRaster<Float32Array>; edited: SparseRaster<Uint8Array>; lowered: number };
  export function waterSurface(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water): Mesh;
  export function waterOutlines(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water, cell?: number, tolerance?: number): Pt[][];
  export function waterShare(grid: { x0: number; z0: number; cols: number; rows: number }, w: Water, b: BuildingRecord, step?: number): number;
  ```
  Die bisherigen Fassungen auf vollen Rastern bleiben in dieser Aufgabe als `…Dense` im Test erhalten (Kopie in die Testdatei), nur als Referenz.

**Was exakt nachzubauen ist:**
- `findWater`: Saatpunkte je Fluss in 1-m-Schritten in OSM-Reihenfolge; jeder zehnte misst den Spiegel als Median der Höhen in einer 15-m-Scheibe (mindestens 50 Werte); Flutung **der Breite nach in genau dieser Warteschlangen-Reihenfolge** (Nachbarn in der Reihenfolge +x, −x, +z, −z), jeder Punkt erbt den Spiegel seines Vorgängers; danach dreimal Rand erweitern. `meanLevel` = Mittel über die Warteschlange in derselben Summationsreihenfolge.
- `carveRiverBed`: Abstand zum nächsten Nicht-Wasser-Punkt als Fasenabstand (1, √2) in **zwei Rasterdurchläufen** (vorwärts zeilenweise, dann rückwärts), Werte in float32; Tiefe = `min(3, max(0.4, d·0.5))`; abgesenkt wird nur, wo das Bett tiefer liegt als das Gelände. Nicht-Wasser-Zellen haben Abstand 0 und werden übersprungen – deshalb genügt es, die Durchläufe über die Seiten zu führen, die Wasser enthalten, plus je eine Zelle Rand, **in derselben Zeilen- und Spaltenreihenfolge**.
- `waterSurface`: je Rasterzeile ein Rechteck pro Lauf zusammenhängender Zellen mit Spiegel, an Chunk-Kanten geteilt, `y` = Mittel des ganzen Laufs (Summe in Spaltenreihenfolge).
- `waterOutlines`: Maske im 4-m-Raster, Ringe in der bisherigen Reihenfolge verfolgt.

- [ ] **Step 1: Failing tests** – jede Funktion gegen ihre `…Dense`-Referenz auf demselben Gelände:

```ts
it('findWater: mask, level (bit for bit, NaN where none) and meanLevel equal the dense version on the river fixture', () => {});
it('findWater: … on a river that crosses page borders and reaches the grid edge', () => {});
it('findWater: two rivers with different levels meeting — the same points take the same level', () => {});
it('carveRiverBed: the edits equal the heights the dense version changes, and `lowered` equals its count', () => {});
it('carveRiverBed: a lake wider than one page (distance > 256 cells from the shore)', () => {});
it('waterSurface / waterOutlines / waterShare equal the dense versions', () => {});
it('no water: empty rasters, meanLevel -Infinity, area 0, no edits', () => {});
it('property test: 40 random terrains with random river lines, 600 × 520 cells', () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/water.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren. Höhen liest `findWater` über `TerrainFile.get` (Block-Zwischenspeicher).
- [ ] **Step 4:** Tests → PASS; `npm run typecheck` (schlägt an den Aufrufstellen in `main.ts` und `bridges.ts` fehl, bis Task 4 sie umstellt – in dieser Aufgabe bleiben deshalb die alten Funktionen unter ihren Namen bestehen und die neuen heißen vorläufig `findWaterSparse` usw.; Task 4 benennt um und löscht die alten).
- [ ] **Step 5:** Commit `feat(pipeline): water on sparse rasters (flood, river bed, surface, outlines)`.

---

### Task 4: Die vier Fassungen als Dateien – Einschnitte, Flussbett, Rampen

**Files:**
- Create: `packages/pipeline/src/terrain/versions.ts`
- Modify: `packages/pipeline/src/terraincut.ts`, `packages/pipeline/src/main.ts` (Abschnitt von „terrain first“ bis „buildings over the water dropped“), `packages/pipeline/src/bridges.ts` (`planBridges`, `abutment`, `isWater`), `packages/pipeline/src/water.ts` (alte Fassungen löschen, neue umbenennen), `packages/pipeline/src/buildingstore.ts` (Schlüssel: Hash der T0-Datei; Gelände als `Heights`)
- Test: `packages/pipeline/src/terrain/versions.test.ts`, `packages/pipeline/src/terraincut.test.ts`

**Interfaces:**
- Consumes: Task 1–3.
- Produces:
  ```ts
  /** Cut and fill targets on sparse rasters; same per-cell arithmetic and tie rules as the dense functions. */
  export function terrainCutEdits(t: TerrainFile, pending: { edits: SparseRaster<Float32Array>; edited: SparseRaster<Uint8Array> },
    tris: Float32Array): number;                                                  // changes `pending`, returns points lowered
  export function terrainFillEdits(t: TerrainFile, tris: Float32Array, keep: SparseRaster<Uint8Array>):
    { edits: SparseRaster<Float32Array>; edited: SparseRaster<Uint8Array>; raised: number };
  // versions.ts
  export type TerrainVersions = { t0: TerrainFile; t1: TerrainFile; t2: TerrainFile; t3: TerrainFile; water: Water; bridges: BridgePlan };
  ```
  `main.ts` hält ab hier kein `TerrainGrid` der ganzen Welt mehr für die Fassungen T0–T2; **T3 wird in dieser Aufgabe am Ende noch einmal ganz dekodiert** (`decodeTerrain` der T3-Datei) und wie bisher an alle späteren Schritte gegeben – Task 5 und 6 lösen das ab. Arbeitsordner der Fassungen: `data/cache/terrain/` (zu Beginn jedes Laufs geleert).

**Regeln:**
- Einschnitte: je Modell in der bisherigen Reihenfolge; „der nächste Einschnitt gewinnt, bei Gleichstand (≤ 1e-6) der tiefste“ gilt **innerhalb eines Modells**; ein späteres Modell rechnet auf dem Stand nach dem früheren (deshalb `pending`). Ohne Einschnitte ist T1 dieselbe Datei wie T0 (kein neues Runden), wie heute.
- Rampen: „die höchste gewinnt“ über alle Dreiecke; Zellen der Wassermaske bleiben.
- T2 und T3 werden immer neu gerundet, wie heute.
- Gebäude lesen T0 über eine Punktabfrage mit einem Fenster je LoD2-Kachel als schnellem Weg.

- [ ] **Step 1: Failing tests**

```ts
it('terrainCutEdits + commitVersion gives the bytes of: applyTerrainCuts on the decoded grid, then encodeTerrain', () => {});
it('two overlapping models: same result and same counts as two dense calls in that order', () => {});
it('terrainFillEdits + commitVersion equals applyTerrainFills(…, keep) + encodeTerrain, with a keep mask', () => {});
it('cuts reaching over the grid edge and over page borders', () => {});
it('the chain T0 → T1 → T2 → T3 on the river fixture with one cut model and two abutments equals the dense chain at every version (file bytes)', () => {});
it('without cuts T1 is T0 (same file, no second rounding)', () => {});
```

- [ ] **Step 2:** `npx vitest run packages/pipeline/src/terrain/versions.test.ts packages/pipeline/src/terraincut.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren und `main.ts` umstellen: `buildT0` → T0; Gebäude (T0); Einschnitte → T1; `findWater(T1)`; Flussbett → T2; `planBridges(T2)`; Rampen → T3; nasse Gebäude; dann T3 dekodieren (Übergang, siehe oben). Die Log-Zeilen bleiben wortgleich.
- [ ] **Step 4:** Tests → PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 5:** Voller Lauf nach `data/reference/run-4` → `world:compare` gegen `world-1`: **gleich**. Spitzen-RSS und Laufzeit in den Bericht.
- [ ] **Step 6:** Commit `perf(pipeline): terrain versions on disk; cuts, river bed and fills as sparse edits`.

---

### Task 5: Alle Leser von T3 auf Fenster und Punktabfrage

**Files:**
- Modify: `packages/pipeline/src/main.ts`, `chunks.ts` (`chunkGeometries`), `chunkdrape.ts`, `drape.ts`, `ground.ts`, `follow.ts`, `bridges.ts` (`bridgeBodies`, `onBridge`), `transitgen.ts`, `transit.ts`, `spawn.ts` (falls betroffen)
- Test: `packages/pipeline/src/terrain/readers.test.ts`, Ergänzungen in den bestehenden Tests der Dateien

**Interfaces:**
- Consumes: `Heights`, `heightAt` (lokal, `terrain/height.ts`), `TerrainFile.window/windowAt`, `TerrainSampler` (Task 1).
- Produces: Jede der genannten Funktionen nimmt `Heights` (oder eine `TerrainFile`) statt eines `TerrainGrid` der ganzen Welt. In der Pipeline importiert nur noch `terrain/height.ts` die Funktion `heightAt` aus `@nn/shared`.

**Regeln:**
- **Chunk** (Draping und Bodennetz): ein Fenster aus dem Chunk-Quadrat plus 2 Zellen Rand; das Bodennetz braucht für seine Normalen eine Zelle über das Quadrat hinaus und muss am Weltrand einseitig bleiben wie heute; das Draping benutzt das Fenster als schnellen Weg und fällt für Punkte außerhalb auf die Punktabfrage zurück (senkrechte Flächen werden als Ganzes gedrapt und können über das Fenster ragen).
- **Verstreute Abfragen** (Brückenkörper, `onBridge`, Stadtbahn, Startpunkt, Kollision über `followTerrain`): Punktabfrage.
- `farGroundY` aus `TerrainFile.borderMin()`, die Log-Zeile „terrain: …“ aus `min()`/`max()`.
- `terrain.bin` der Welt ist eine Kopie der T3-Datei (bytegleich mit dem bisherigen `encodeTerrain`-Ergebnis).
- `--transit-only` liest `terrain.bin` des Zielordners als `TerrainFile`.

- [ ] **Step 1: Failing tests**

```ts
it('groundMesh on a chunk window (chunk + 2 cells) equals groundMesh on the whole grid, for an inner chunk, an edge chunk and a corner chunk', () => {});
it('drapeChunk with a chunk window + sampler fallback equals drapeChunk on the whole grid — including a vertical face that leaves the window', () => {});
it('followTerrain with a sampler equals followTerrain on the whole grid (frozen digests unchanged)', () => {});
it('heightAt is imported from @nn/shared only in terrain/height.ts', () => { /* liest die Quelldateien der Pipeline */ });
```

- [ ] **Step 2:** → FAIL.
- [ ] **Step 3:** Umstellen; der Übergang aus Task 4 (T3 ganz dekodieren) entfällt.
- [ ] **Step 4:** Tests → PASS; `npm test`; `npm run typecheck`.
- [ ] **Step 5:** Voller Lauf nach `data/reference/run-5` → **gleich**. Spitzen-RSS und Laufzeit in den Bericht; steigt die Laufzeit um mehr als 25 % gegenüber 414 s, ist das ein Befund (Kandidaten: Punktabfrage in `followTerrain`, Fenster je Chunk).
- [ ] **Step 6:** `npm run transit -- --out <Kopie von world-1>` läuft durch (Ergebnis wie bisher nicht bytegleich mit dem vollen Lauf – bekannte Näherung; es genügt, dass es dieselben 23 Dateien sind wie vor dieser Stufe; Kopie danach löschen).
- [ ] **Step 7:** Commit `perf(pipeline): every terrain reader works on a window or a point lookup`.

---

### Task 6: Nachweis, Aufräumen, Doku

**Files:**
- Modify: `packages/pipeline/src/dgm.ts`, `water.ts`, `terraincut.ts` (ungenutzte dichte Fassungen entfernen, sofern nur noch Tests sie brauchen: dorthin verschieben), `README.md`, `docs/superpowers/specs/2026-11-24-tiled-world-design.md`
- Create: `packages/pipeline/src/terrain/nogrid.test.ts`

- [ ] **Step 1: Failing test** `no pipeline source allocates a cols × rows array`: liest alle Nicht-Test-Quelldateien unter `packages/pipeline/src` und schlägt bei den Mustern `new Float32Array(t.cols * t.rows`, `new Uint8Array(n)` mit `n = t.cols * t.rows`, `decodeTerrain(` (außer in Tests und in `terrain/file.ts`) und `.heights.length` an; eine Ausnahmeliste mit Begründung ist erlaubt (Fenster!). Erst FAIL sehen, dann die Reste beseitigen.
- [ ] **Step 2: Messen.** Profil mit `process.memoryUsage()` an den Stufengrenzen (nicht einchecken) und ein voller Lauf unter `pipeline-peak.mjs`: Spitzen-RSS, RSS nach der Geländephase (vorher ≈ 1,7 GB), Laufzeit. Tabelle vorher/nachher in den Bericht.
- [ ] **Step 3:** Voller Lauf nach `data/reference/run-6` → **gleich**.
- [ ] **Step 4:** README („Entwickeln“: Speicherbedarf, Arbeitsordner `data/cache/terrain/`), Spec (Stufe 4 als umgesetzt vermerken, mit den gemessenen Zahlen und dem Hinweis, was weiterhin mit der Fläche wächst: das Planen auf Vektordaten, der globale Kollisionsschritt, die Wasser-Raster entlang des Flusses).
- [ ] **Step 5:** `npm run typecheck && npm test` → grün. Commit `chore(pipeline): no full-size terrain arrays left; docs`.

---

## Offen nach diesem Plan

- Der globale Kollisionsschritt (`followTerrain` über alle Bordsteine, `buildCollision`) und das Planen auf den Vektordaten der ganzen Stadt wachsen weiter mit der Fläche; sie werden mit dem Kachelformat (Stufe 2) pro Chunk.
- Absolute Rundung der Höhen: mit Stufe 2.
