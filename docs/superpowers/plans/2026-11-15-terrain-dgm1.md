# Echtes Gelände (DGM1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Welt steht auf dem echten, leicht geglätteten NRW-Geländemodell: Boden, Straßenraum, Gebäude, Props, Autos und Physik folgen den echten Höhen.

**Architecture:** Ein gemeinsames 1-m-Höhenraster (`TerrainGrid`, `@nn/shared`) ist die einzige Wahrheit. Die Pipeline baut es aus den DGM1-Kacheln, quantisiert es auf 1 cm (Encode→Decode) und benutzt danach nur noch das decodierte Raster: für das `ground`-Mesh je Chunk, zum Drapieren aller Straßen-Meshes (Zerschneiden an Rasterlinien + Zellendiagonale) und für Gebäudehöhen. Sie liefert es als `terrain.bin` aus; der Client baut daraus ein Rapier-Höhenfeld und platziert Props über `heightAt`.

**Tech Stack:** TypeScript, three.js, Rapier 0.21 (`@dimforge/rapier3d-compat`), gltf-transform + meshopt, vitest, neue Abhängigkeit `geotiff@2.1.3` (nur Pipeline).

**Spec:** `docs/superpowers/specs/2026-11-15-terrain-dgm1-design.md`

## Global Constraints

- Datenquelle: `https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/dgm1_32_<E>_<N>_1_nw_2022.tif`, dieselben 12 Kacheln wie `LOD2_TILES` (E 355–357, N 5646–5649), Cache `data/raw/dgm1/`, User-Agent wie bisher `nippes-nights-pipeline/0.1`. Lizenz dl-de/zero-2.0.
- Attribution (exakt): `© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude und Gelände: Geobasis NRW (dl-de/zero-2.0)`
- Raster: Abstand 1 m, deckt `worldRect(boundary)` (Boundary-BBox + 200 m) ab; Glättung Gauß `TERRAIN_SIGMA = 1` (m), höchstens 2.
- Höhen im Spiel: y = NHN − `datum`; `datum` = geglättete Höhe bei (0, 0), auf 0,1 m gerundet.
- Darstellung, Physik-Höhenfeld und `heightAt` triangulieren jede Zelle mit derselben Diagonale (die von Rapier, Task 2 legt sie per Test fest).
- Keine Brücken, keine DB-Gleise, keine Detailstufen für ferne Chunks (Spec, Nicht-Ziele/Claude-Entscheidung).
- Kein Größenbudget (Optik vor Downloadgröße).
- Bestehende Höhenversätze der Straßenflächen bleiben unverändert (`ROAD_Y`, `RANK_STEP`, `CURB_H`, `GREEN_Y`, `SQUARE_Y`, `RAIL_Y`, `BED_Y`); sie gelten künftig **über dem Gelände**.

## Review Focus

1. **Kachelnähte des DGM:** an den 1000-m-Grenzen der Kacheln darf keine Stufe oder Lücke im Raster entstehen (Halbpixel-Versatz, Glättung über die Naht). → Test in Task 3 (`mosaic is continuous across tile seams`).
2. **Risse zwischen drapierten Nachbardreiecken:** zwei Dreiecke mit gemeinsamer Kante müssen nach dem Zerschneiden an der Kante identische Vertices haben (kein Spalt, durch den der Boden blitzt). → Test in Task 4 (`shared edge splits identically`).
3. **Abfragen außerhalb des Rasters** (Grenzwände, ferner Boden, Props am Rand): `heightAt` klemmt auf den Rand statt NaN/Absturz. → Test in Task 1 (`clamps outside the grid`).
4. **Gebäude, dessen LoD2-Sockel höher liegt als das Gelände an einer Wand:** kein Spalt unter der Wand. → Test in Task 6 (`plinth closes the gap to lower terrain`).
5. **Laufen/Fahren auf dem Höhenfeld:** Figur steht auf Schräge ohne Einsinken/Schweben, Auto fährt eine 3-m-Stufe auf 150 m hoch, Bordstein-Trimesh und Höhenfeld zusammen. → Tests in Task 2 (`character stands on sloped heightfield`, `car climbs a gentle ramp`).

---

### Task 1: Geländeraster in `@nn/shared`

**Files:**
- Create: `packages/shared/src/assets/terrain.ts`, `packages/shared/src/assets/terrain.test.ts`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces:**
- Produces:
  ```ts
  /** Heights (local y = NHN − datum) at (x0 + c·1 m, z0 + r·1 m); row-major, index r * cols + c. */
  export type TerrainGrid = { x0: number; z0: number; cols: number; rows: number; datum: number; heights: Float32Array };
  export function heightAt(t: TerrainGrid, x: number, z: number): number; // clamps x/z to the grid
  export function terrainNormal(t: TerrainGrid, x: number, z: number): { x: number; y: number; z: number }; // of the triangle under (x, z), unit, y > 0
  export const TERRAIN_DIAGONAL: 'x0z0-x1z1' | 'x1z0-x0z1';
  export function encodeTerrain(t: TerrainGrid): ArrayBuffer;
  export function decodeTerrain(buf: ArrayBuffer): TerrainGrid;
  ```
- Format `terrain.bin`: `'NNT1'`, uint32 cols, rows, dann float64 x0, z0, datum, base (little-endian), dann `cols·rows` × uint16 = Zentimeter über `base` (`base` = Minimum, auf 1 cm abgerundet). `encodeTerrain` wirft, wenn die Spanne > 655,35 m oder ein Wert nicht endlich ist.
- `heightAt`: in der Zelle linear auf dem Dreieck, das `TERRAIN_DIAGONAL` vorgibt. Startwert `'x0z0-x1z1'`; Task 2 korrigiert die Konstante, falls Rapier anders trianguliert.

- [ ] **Step 1: Tests schreiben** (`terrain.test.ts`):
  - `exact at grid points`: Raster 3×3 mit Höhen `r*10 + c`, `heightAt(t, x0+2, z0+1) === 12`.
  - `linear inside a triangle`: Raster 2×2 Höhen `[0, 1, 1, 0]` (Sattel); `heightAt` am Zellmittelpunkt = 0,5 bzw. passend zur Diagonale (für `'x0z0-x1z1'`: Mittelwert der Diagonal-Ecken (0+0)/2 = 0); Punkt (0,25; 0,75) liegt im Dreieck gegenüber und wird linear aus dessen drei Ecken gerechnet (Test rechnet den Erwartungswert explizit aus).
  - `clamps outside the grid`: `heightAt(t, x0 - 50, z0 - 50)` = Ecke (0,0); `heightAt(t, 1e6, 1e6)` = letzte Ecke; kein NaN.
  - `normal of a plane`: Raster mit `h = 0.1·x` → `terrainNormal` ≈ (−0,0995, 0,995, 0).
  - `round trip to 1 cm`: zufälliges Raster 50×40 (Seed fest, Werte 38–64) → `decodeTerrain(encodeTerrain(t))` gleich bis ≤ 0,005; x0/z0/datum exakt.
  - `rejects too large span`: Spanne 700 m → wirft.
- [ ] **Step 2:** `npx vitest run packages/shared/src/assets/terrain.test.ts` → FAIL (Modul fehlt).
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Tests → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(shared): terrain grid with heightAt and terrain.bin codec`

---

### Task 2: Physik auf dem Höhenfeld

**Files:**
- Modify: `packages/shared/src/physics/world.ts`, `packages/shared/src/physics/vehicle.ts`, `packages/shared/src/assets/terrain.ts` (nur `TERRAIN_DIAGONAL`, falls nötig)
- Test: `packages/shared/src/physics/physics.test.ts`

**Interfaces:**
- Consumes: `TerrainGrid`, `heightAt`, `TERRAIN_DIAGONAL` (Task 1).
- Produces:
  - `createPhysicsWorld(c: CollisionAsset, terrain?: TerrainGrid): Promise<PhysicsWorld>` — mit `terrain`: zusätzlich ein fester Rapier-Höhenfeld-Collider (`ColliderDesc.heightfield`, Höhen in Rapiers Spaltenreihenfolge, `scale` = (cols−1, 1, rows−1), Translation = Rastermitte), Flag `FIX_INTERNAL_EDGES`.
  - Grenzwände (`addBoundaryWalls`): je Segment Unterkante = min. Geländehöhe entlang des Segments (alle 1 m abgetastet) − 1 m, Höhe = `boundaryWallHeight` + Spanne + 1 m. Ohne `terrain` wie bisher.
  - `new Vehicle(pw, pose: { x; z; heading; y?: number })` — `y` = Bodenhöhe unter dem Auto (Standard 0); Chassis startet bei `y + VEHICLE_REST_Y`.

- [ ] **Step 1: Tests schreiben** (in `physics.test.ts`, neues `describe('terrain')`):
  - `heightfield matches heightAt`: Raster 21×21 mit Hügelfunktion (z. B. `3·sin(x/4)·cos(z/5)`), Welt ohne Trimesh-Boden; an 200 festen Pseudo-Zufallspunkten (auch nahe beider möglichen Diagonalen) Strahl von y = 50 nach unten → Treffer-y = `heightAt` ± 1 mm. **Dieser Test legt `TERRAIN_DIAGONAL` fest**: schlägt er mit `'x0z0-x1z1'` fehl und mit `'x1z0-x0z1'` nicht, die Konstante umstellen.
  - `character stands on sloped heightfield`: Raster 200×200 mit `h = 0.05·x` (5 %), Figur bei (50, h+1, 50) abgesetzt, 120 Schritte ohne Eingabe → Füße (Kapselunterkante) innerhalb ±3 cm von `heightAt`, bleibt stehen (Δxz < 5 cm).
  - `car climbs a gentle ramp`: Raster mit 3 m Anstieg über 150 m (glatte Rampe), Auto am Fuß mit Vollgas 15 s → oben angekommen (x über Rampenende), nie > 0,3 m unter `heightAt` (kein Durchfallen).
  - `kerb trimesh on top of heightfield`: Raster flach bei h = 2, Trimesh-Bordstein 0,12 m auf y = 2 (wie miniScene, verschoben) → bestehende Kerb-Klettertests laufen sinngemäß (Figur steigt auf den Bordstein).
  - `boundary walls follow terrain`: Raster mit 10-m-Anstieg, Boundary-Quadrat; Figur läuft am hohen Ende gegen die Wand → wird gestoppt.
- [ ] **Step 2:** `npx vitest run packages/shared/src/physics/physics.test.ts` → neue Tests FAIL.
- [ ] **Step 3:** Implementieren (Spaltenreihenfolge und Zellanzahl vs. Punktanzahl von `heightfield(nrows, ncols, …)` am ersten Test verifizieren).
- [ ] **Step 4:** Alle Physik-Tests → PASS (alte unverändert grün).
- [ ] **Step 5: Commit** `feat(physics): terrain heightfield collider, terrain-following boundary walls`

---

### Task 3: DGM1 laden, zusammensetzen, glätten

**Files:**
- Create: `packages/pipeline/src/dgm.ts`, `packages/pipeline/src/dgm.test.ts`
- Modify: `packages/pipeline/src/fetch.ts` (Download), `packages/pipeline/package.json` (`geotiff: "2.1.3"`)

**Interfaces:**
- Consumes: `TerrainGrid`, `heightAt` (Task 1); `tileNamesForBounds`-Bounds aus `fetch.ts`; `Rect` aus `chunks.ts`.
- Produces:
  ```ts
  // fetch.ts
  export const DGM_TILES: string[]; // 'dgm1_32_<E>_<N>_1_nw_2022.tif', gleiche E/N wie LOD2_TILES
  export async function fetchDgmTiles(dir: string): Promise<string[]>; // wie fetchLod2Tiles, Basis-URL s. Global Constraints
  // dgm.ts
  /** NHN heights, 1 m pixels, row 0 = north; pixel (i, j) centre at (e0 + i + 0.5, n0 − j − 0.5). */
  export type Mosaic = { e0: number; n0: number; width: number; height: number; data: Float32Array };
  export async function readDgmTile(buf: ArrayBuffer): Promise<Mosaic>;   // via geotiff; wirft bei NoData (−9999) oder Auflösung ≠ 1
  export function mosaic(tiles: Mosaic[]): Mosaic;                        // lückenlos, wirft bei Lücken
  export function gaussBlur(m: Mosaic, sigma: number): Mosaic;            // separabel, Rand: Klemmen
  /** Samples `m` bilinearly at integer local x/z covering `rect` (floor/ceil); datum = height at (0,0) rounded to 0.1 m. */
  export function terrainFromMosaic(m: Mosaic, rect: Rect): TerrainGrid;
  export const TERRAIN_SIGMA = 1;
  ```
- Lokal ↔ UTM: x = e − ORIGIN_UTM.e, z = −(n − ORIGIN_UTM.n) (`utmToLocal`).

- [ ] **Step 1: Tests schreiben** (`dgm.test.ts`; GeoTIFF-Fixture wird **nicht** eingecheckt, `readDgmTile` testet ein im Test mit `geotiff`s `writeArrayBuffer` erzeugtes 4×4-TIFF falls verfügbar, sonst nur die übrigen Funktionen):
  - `mosaic is continuous across tile seams`: zwei 10×10-Kacheln nebeneinander mit globaler Rampe `h = 40 + 0.01·e` → Mosaik 20×10; nach `gaussBlur(σ=1)` ist jede Nachbardifferenz entlang e = 0,01 ± 1e-4 (auch an der Naht).
  - `mosaic rejects gaps`: Kacheln mit 1 Pixel Lücke → wirft.
  - `blur keeps planes`: Ebene bleibt Ebene (Innenbereich ± 1e-4).
  - `half-pixel sampling`: Mosaik mit `h = e` → `terrainFromMosaic` an lokalem x liefert `ORIGIN_UTM.e + x` (± 1e-4), d. h. Pixelmitten bei +0,5 korrekt berücksichtigt.
  - `datum`: Mosaik konstant 47,26 → `datum = 47.3`, alle Höhen −0,04.
  - `rect coverage`: `terrainFromMosaic(m, {minX:-10.5, maxX:20.2, minZ:-3, maxZ:4})` → x0 = −11, cols = 32, z0 = −3, rows = 8.
- [ ] **Step 2:** `npx vitest run packages/pipeline/src/dgm.test.ts` → FAIL.
- [ ] **Step 3:** `npm i -w @nn/pipeline geotiff@2.1.3`; implementieren.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Spike gegen echte Daten:** `fetchDgmTiles('data/raw/dgm1')` einmal laufen lassen (über ein kleines `tsx -e`), Mosaik bauen, Raster-Min/Max und `datum` ausgeben. Erwartung: Min ≈ 38–41, Max ≈ 56–65, `datum` ≈ 47–48. Ergebnis in die Commit-Message.
- [ ] **Step 6: Commit** `feat(pipeline): DGM1 tiles → smoothed terrain grid`

---

### Task 4: Drapieren

**Files:**
- Create: `packages/pipeline/src/drape.ts`, `packages/pipeline/src/drape.test.ts`

**Interfaces:**
- Consumes: `TerrainGrid`, `heightAt`, `TERRAIN_DIAGONAL` (Task 1); `Mesh` aus `streets.ts`.
- Produces: `export function drapeMesh(m: Mesh, t: TerrainGrid): Mesh` — Eingabe-y ist der Versatz über Gelände; Ausgabe-y = Versatz + Geländehöhe; uv mitinterpoliert; Wicklung bleibt.

Algorithmus (vom Test nicht eindeutig festgelegt):
- **Liegende Dreiecke** (xz-Fläche ≥ 1e-6 m²): für jede Rasterzelle im xz-Bounding-Box: Dreieck (als Polygon) gegen die 4 Zellränder und dann gegen die Diagonale (beide Halbebenen getrennt) klippen; jedes nichtleere Teilpolygon fächerförmig triangulieren. Attribute (Versatz-y, uv) baryzentrisch aus dem Originaldreieck, dann y += `heightAt`.
- **Senkrechte Dreiecke** (Bordsteinkanten; xz-Fläche < 1e-6): die horizontale Richtung des Dreiecks nehmen, alle Kreuzungen seiner xz-Spur mit Rasterlinien und Diagonalen bestimmen, das Dreieck an diesen Parametern in Streifen zerlegen; jeder neue Vertex y = interpolierter Versatz + `heightAt`.
- Kreuzungspunkte entlang einer Kante werden nur aus den beiden Kantenendpunkten berechnet (in fester Reihenfolge, z. B. Endpunkt mit kleinerem (x, z) zuerst), damit Nachbardreiecke identische Punkte erzeugen.

- [ ] **Step 1: Tests schreiben** (`drape.test.ts`, Raster 20×20 mit `h = 0.3·x + 0.2·z + 0.5·sin(x)·cos(z)`):
  - `flat terrain is identity-like`: konstantes Raster h = 2 → alle Ausgabe-y = Eingabe-y + 2; Gesamtfläche (xz) gleich Eingabe.
  - `every vertex sits on terrain plus offset`: Dreieck über 5×5 Zellen mit Versatz 0,01 → für jeden Vertex |y − 0,01 − heightAt| < 1e-5.
  - `no output triangle spans a terrain triangle`: jeder Ausgabe-Dreiecksschwerpunkt und alle drei Ecken liegen in derselben Zelle und auf derselben Seite der Diagonale (Toleranz 1e-6).
  - `area and winding preserved`: Summe der xz-Flächen = Eingabe ± 1e-6; alle Normalen y > 0 für ein nach oben zeigendes Eingabedreieck.
  - `uv interpolated`: Dreieck mit uv = (x, z) → Ausgabe-uv = (x, z) jedes Vertex ± 1e-6.
  - `shared edge splits identically`: zwei Dreiecke mit gemeinsamer schräger Kante → die Menge der Ausgabe-Vertices auf dieser Kante ist für beide gleich (auf 1e-6).
  - `vertical kerb face follows terrain`: senkrechtes Quad von y 0,01 bis 0,12 entlang x = 0…10 bei z = 3,3 → Unterkante jedes Vertex = 0,01 + heightAt, Oberkante 0,12 + heightAt; Teilung an jeder Rasterlinie und Diagonalkreuzung.
- [ ] **Step 2:** `npx vitest run packages/pipeline/src/drape.test.ts` → FAIL.
- [ ] **Step 3:** `drapeMesh` implementieren.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): drape street meshes onto the terrain grid`

---

### Task 5: Boden-Mesh, Gleisbett in der Pipeline, Chunks und Kollision

**Files:**
- Create: `packages/pipeline/src/ground.ts`, `packages/pipeline/src/ground.test.ts`
- Move: `apps/client/src/trackbed.ts` → `packages/pipeline/src/trackbed.ts`, `apps/client/src/trackbed.test.ts` → `packages/pipeline/src/trackbed.test.ts` (Inhalt unverändert)
- Modify: `packages/pipeline/src/chunks.ts`, `packages/pipeline/src/chunks.test.ts`, `packages/shared/src/assets/manifest.ts` (nur Doku-Kommentar zum Chunk-Layout), `apps/client/src/loader.ts` (eigenes Gleisbett entfernen), `apps/client/src/materials/street.ts` (Import von `trackbed.ts` anpassen, falls vorhanden)

**Interfaces:**
- Consumes: `TerrainGrid`, `TERRAIN_DIAGONAL` (Task 1); `drapeMesh` (Task 4); `trackBed(positions, uv, index)` (verschoben).
- Produces:
  - `export type GroundMesh = Mesh & { normals: Float32Array }`
  - `export function groundMesh(t: TerrainGrid, ix: number, iz: number): GroundMesh | null` — Rasterpunkte im Chunkquadrat [ix·200, ix·200+200] × [iz·200, iz·200+200] ∩ Raster (Randzeile/-spalte doppelt mit Nachbarchunk, keine Lücke), Zellen mit `TERRAIN_DIAGONAL`, Wicklung nach oben, uv = Welt-x/z, Normalen per zentraler Differenz.
  - `STREET_MESHES` bekommt `'trackbed'` (zwischen `'road'` und `'tram'`); `StreetMeshes` entsprechend.
  - `ChunkGeometry` bekommt `ground?: GroundMesh`.
  - `buildChunks(buildings, streets, overrides, area, terrain?: TerrainGrid)`: mit `terrain` existiert für **jedes** Chunkquadrat, das `area` schneidet, ein Chunk mit `ground` (auch ohne Gebäude/Straßen).
  - `encodeChunkGlb`: Mesh `ground` mit POSITION, NORMAL, TEXCOORD_0.
  - `buildCollision({ …, terrain?: TerrainGrid })`: mit `terrain` **kein** Boden-Rechteck mehr (der Höhenfeld-Collider ersetzt es).
- Gleisbett: Pipeline ruft `trackBed` auf das **flache** `tram`-Mesh auf (Ausgabe-y = `BED_Y`), setzt das Ergebnis als `streets.trackbed`; danach werden alle Straßen-Meshes einschließlich `trackbed` drapiert (Task 8). Client lädt das GLB-Mesh `trackbed` wie die anderen Straßen-Meshes (Material `street.trackbed` existiert schon).

- [ ] **Step 1: Tests schreiben:**
  - `ground.test.ts`: `ground covers its chunk without gaps` (Raster x/z −250…450 → `groundMesh(t, 0, 0)` hat 201×201 Vertices, xz-Fläche 40 000 m²); `ground clipped to the grid` (Chunk am Rasterrand → nur der überlappende Teil); `ground normals point up and match slope` (Ebene `h = 0.1·x` → alle Normalen ≈ (−0,0995, 0,995, 0)); `ground triangles use TERRAIN_DIAGONAL` (jedes Dreieck enthält beide Diagonal-Ecken seiner Zelle); `outside → null`.
  - `chunks.test.ts`: `terrain creates ground-only chunks` (Raster über 2×2 Chunks, keine Gebäude → 4 Chunks mit `ground`); `glb carries ground with normals` (decodieren, Mesh `ground` hat NORMAL); `collision without ground rectangle when terrain is given`; bestehende Tests unverändert grün.
  - `trackbed.test.ts` läuft am neuen Ort.
- [ ] **Step 2:** `npx vitest run packages/pipeline` → neue Tests FAIL.
- [ ] **Step 3:** Implementieren; Client-Loader: `trackBedMesh` und dessen Aufruf entfernen, `trackbed` bekommt `renderOrder` aus `STREET_RENDER_ORDER` (existiert); `ground` bekommt `renderOrder −1` und **kein** `castShadow` (Claude-Entscheidung, Schattenpass sparen).
- [ ] **Step 4:** `npm test` und `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): per-chunk ground mesh, track bed baked in the pipeline`

---

### Task 6: Gebäude und Ersatzmodelle auf echter Höhe

**Files:**
- Modify: `packages/pipeline/src/buildings.ts`, `packages/pipeline/src/buildings.test.ts`, `packages/pipeline/src/fixture.ts` (`boxBuilding` bekommt `base: 0`), `packages/pipeline/src/models.ts`, `packages/pipeline/src/models.test.ts`

**Interfaces:**
- Consumes: `TerrainGrid`, `heightAt` (Task 1).
- Produces:
  - `BuildingMesh.base: number` — lokale y-Höhe des LoD2-Sockels (minZ − datum; ohne Terrain 0).
  - `buildBuildingMesh(b: CityBuilding, ground?: { datum: number; terrain: TerrainGrid }): BuildingMesh | null` — ohne `ground` exakt wie heute (y = z − minZ). Mit `ground`: y = z − datum; Fassaden-v bleibt z − minZ.
  - **Sockel:** `gmin` = Minimum von `heightAt` über alle Wand-Unterkanten-Vertices und die Grundflächen-Ecken. Ist `gmin < base + 0.3`, bekommt jede Wand-Unterkante (Kante eines Wanddreiecks, deren beide Endpunkte ≤ 0,05 m über der tiefsten Höhe dieser Wand liegen) ein Quad nach unten bis y = `gmin − 0.3`: `kind` 0, Normale der Wand, Fassaden-u wie die Kante, Fassaden-v = y − base (negativ).
  - `prepareModel(glb: Uint8Array, lift = 0)` — verschiebt alle Szenen-Wurzelknoten und die Kollisionsdreiecke um `lift` in y.

- [ ] **Step 1: Tests schreiben** (`buildings.test.ts` mit vorhandener `gable-house.gml`-Fixture):
  - `absolute height with terrain`: konstantes Raster bei Geländehöhe = LoD2-minZ − datum → Wand-Unterkante y = minZ − datum (± 1e-4), `base` = minZ − datum, Fassaden-v an der Unterkante = 0.
  - `no plinth on level ground`: Raster = base + 0,5 überall → keine Vertices mit v < 0.
  - `plinth closes the gap to lower terrain`: Raster fällt unter dem Gebäude von base auf base − 1,5 → es gibt Wand-Vertices mit y = base − 1,8 (± 1e-4); jede Wand-Unterkante hat ein Sockel-Quad (Anzahl Sockel-Dreiecke = 2 × Anzahl Unterkanten); Sockel-Normalen = Wandnormalen.
  - `without terrain unchanged`: Ausgabe identisch zur bisherigen (Snapshot der Positionen gegen eine vorher erzeugte Kopie im Test).
  - `models.test.ts`: `lift moves render and collision` (`prepareModel(glb, 2.5)` → Bounding-Box-Min-y und Kollisions-Min-y je +2,5).
- [ ] **Step 2:** `npx vitest run packages/pipeline/src/buildings.test.ts packages/pipeline/src/models.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): buildings and override models at their real height, plinths on slopes`

---

### Task 7: Mehr Grün aus OSM

**Files:**
- Modify: `packages/pipeline/src/osm.ts` (`GREEN`), `packages/pipeline/src/osm.test.ts`

**Interfaces:**
- Produces: `GREEN(t)` zusätzlich wahr für `landuse` ∈ {`railway`, `meadow`, `forest`, `allotments`, `flowerbed`, `brownfield`} (aus den tatsächlich vorhandenen Tags im Spielgebiet gewählt: `railway` 10, `allotments` 13, `flowerbed` 11, `forest` 6, `meadow` 1, `brownfield` 1).

- [ ] **Step 1: Test** `osm.test.ts`: `railway and embankment land is green` — Fläche mit `landuse=railway` bzw. `landuse=allotments` landet in `greens`; `landuse=residential` nicht.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(pipeline): railway land, allotments and meadows as green areas`

---

### Task 8: Pipeline verdrahten, Manifest v2

**Files:**
- Modify: `packages/pipeline/src/main.ts`, `packages/shared/src/assets/manifest.ts`, `packages/shared/src/assets/manifest.test.ts`, `apps/client/src/loader.test.ts` (Manifest-Fixture auf v2)

**Interfaces:**
- Consumes: alles aus Task 1–7.
- Produces (Manifest, `version: 2`; `parseManifest` akzeptiert nur 2):
  - `terrain: { file: 'terrain.bin'; bytes: number }`
  - `datum: number`
  - `farGroundY: number` — minimale Höhe entlang des Rasterrands − 0,5.
  - `shops[].sign.y` — Brettmitte: `base` des Gebäudes (`buildingId`) + `SIGN_Y` (3,52; Konstante aus `apps/client/src/props.ts` nach `@nn/shared` verschieben, Client importiert sie von dort).
  - `spawn.y` = `heightAt(spawn) + SIDEWALK_Y`.
  - Chunk-Layout-Kommentar in `manifest.ts`: `ground` und `trackbed` ergänzen.
- Ablauf in `main.ts`: `ensureRaw` lädt auch `DGM_TILES`; Mosaik → `gaussBlur(TERRAIN_SIGMA)` → `terrainFromMosaic(worldRect)` → `decodeTerrain(encodeTerrain(…))` (ab hier nur das decodierte Raster) → `buildBuildingMesh(b, { datum, terrain })` → `buildStreetGeometry` + `trackBed` → jedes Straßen-Mesh `drapeMesh` → `buildChunks(…, terrain)` → `prepareModel(glb, min(base der ersetzten Gebäude))` (bei mehreren Gebäuden je Modell: niedrigster Sockel) → `buildCollision({ …, terrain })` → `terrain.bin` schreiben. Log-Zeile: `terrain: <cols>×<rows>, datum <d> m, <min>–<max> m NHN, σ <s> m`.
- Attribution exakt wie in Global Constraints.

- [ ] **Step 1: Tests:** `manifest.test.ts`: v2 mit allen neuen Feldern wird gelesen; `sign.y` Pflicht, wenn `sign` vorhanden; v1 wird abgelehnt.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test`, `npm run typecheck` → PASS.
- [ ] **Step 5:** `npm run pipeline -- --skip-fetch` (nach einmaligem Laden der DGM-Kacheln ohne `--skip-fetch`) → läuft durch; Log zeigt Terrain-Zeile mit plausiblen Werten (≈ 38–65 m NHN), `terrain.bin` existiert, Chunk-Anzahl ≥ bisher 174.
- [ ] **Step 6: Commit** (inkl. neu erzeugter `apps/client/public/world/*`, wie bisher üblich) `feat(pipeline): terrain in the world build, manifest v2`

---

### Task 9: Client auf dem Gelände

**Files:**
- Modify: `apps/client/src/main.ts`, `apps/client/src/game.ts`, `apps/client/src/props.ts`, `apps/client/src/car.ts`, `apps/client/src/loader.ts`, `apps/client/src/materials/street.ts`, `apps/client/src/materials/facade.ts`
- Test: `apps/client/src/props.test.ts` (neu, falls nicht vorhanden), `apps/client/src/car.test.ts`

**Interfaces:**
- Consumes: Manifest v2 (Task 8), `decodeTerrain`, `heightAt`, `terrainNormal` (Task 1), `createPhysicsWorld(c, terrain)`, `Vehicle` mit `y` (Task 2).
- Produces:
  - `main.ts`: lädt `terrain.bin` parallel zu `collision.bin`; `createPhysicsWorld(collision, terrain)`; ferne Bodenebene bei `y = manifest.farGroundY`.
  - `new Props(scene, manifest, terrain: TerrainGrid)`: Laternen, Bäume (inkl. Halo-Punkte: `LAMP_LIGHT_Y` + Geländehöhe), Haltestellen auf `heightAt`; Ladenschilder auf `sign.y`.
  - `new ParkedCars(scene, pw, parked, terrain: TerrainGrid)`: Pose y = `heightAt + VEHICLE_REST_Y`, Rotation = Heading um die Geländenormale geneigt (`terrainNormal`); `Vehicle` wird mit `y` erzeugt.
  - `Game` reicht `terrain` durch (Konstruktor-Option `terrain`).
  - Boden-Material (`street.ground`): nutzt Mesh-Normalen (kein `flatShading` für `ground`) und mischt nach Neigung zu Gras: Grasanteil `1 − smoothstep(cos 25°, cos 15°, normal.y)` (Welt-Normale), Gras = Farbe/Muster von `green`. Startwerte 15°/25°, per Screenshot abstimmen.
  - Fassade: Fassaden-v < 0 → schlichter Sockel (dunkler Putz/Stein, z. B. Palettenfarbe × 0,55, keine Fenster, keine Ladenzone, kein Licht nachts); `wallEaves` ignoriert v < 0.
- [ ] **Step 1: Tests:**
  - `props.test.ts`: `lamps and trees sit on terrain` (Raster `h = 0.1·x`, Lampe bei x = 20 → Instanzmatrix-y = 2,0); `sign uses sign.y`.
  - `car.test.ts`: `parked car rests on terrain and follows its slope` (Raster `h = 0.1·x` → Pose-y = 0,1·x + `VEHICLE_REST_Y`, Neigung um z-Achse ≈ atan(0,1) ± 0,01 rad bei Heading 0).
  - `facade.test.ts`: `wallEaves ignores plinth vertices` (Wand mit v ∈ [−1,5; 12] → Traufhöhe 12).
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** `npm test`, `npm run typecheck`, `npm run build` → PASS.
- [ ] **Step 5: Commit** `feat(client): props, parked cars, physics and shading on the terrain`

---

### Task 10: Abnahme, Feinabstimmung, Doku

**Files:**
- Modify: `docs/superpowers/specs/2026-11-15-nippes-nights-design.md` (Zeile „Gelände: Flach angenommen …“ → „Echtes Gelände aus NRW DGM1, siehe `2026-11-15-terrain-dgm1-design.md`“), ggf. `packages/pipeline/src/dgm.ts` (`TERRAIN_SIGMA`), `apps/client/src/materials/street.ts` (Neigungsschwellen)
- Screenshots nach `shots/terrain/`

- [ ] **Step 1:** `npm run screenshot` (Parameter wie in `scripts/screenshot.mjs`, `?cam=`/Zeit-Override) an: Spawn; Geländestufe ≈ 300–500 m östlich vom Spawn (Blick quer zur Stufe); Bahndamm im Westen (höchste Rasterwerte, aus Task-3-Spike); Kempener Straße (-629, -636) (bekannte Schwäche); Bahnflächen (`landuse=railway`, Betriebsbahnhof) — wirkt das Grün plausibel?; Gebäude am Hang mit sichtbarem Sockel; je Tag (12:00) und Nacht (23:00). Prüfen: kein Schweben/Flackern von Straße, Gehweg, Gleisbett; keine Spalte unter Wänden; keine Rasterstufen im Boden.
- [ ] **Step 2:** σ und Neigungsschwellen nach Screenshots festlegen (σ ≤ 2), Pipeline neu laufen lassen, Screenshots wiederholen.
- [ ] **Step 3:** `npm run drive-check` und `npm run accept` → PASS; Fahrt über die Geländestufe ohne Hängenbleiben/Durchfallen.
- [ ] **Step 4:** Bildrate im echten Browser (nicht headless) an Spawn und Geländestufe notieren (`window.__nnInfo()` für Dreiecke); bricht sie spürbar ein → Folgeschritt „Detailstufen“ in `docs/superpowers/notes/` festhalten, **nicht** in diesem Plan bauen.
- [ ] **Step 5:** `npm test`, `npm run typecheck` → PASS.
- [ ] **Step 6: Commit** `docs: terrain acceptance, spec points to DGM1 design`
