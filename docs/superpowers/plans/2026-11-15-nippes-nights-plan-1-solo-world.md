# Nippes Nights – Plan 1: Allein durch Nippes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein im Browser spielbares 3D-Nippes (LoD2-Gebäude + OSM-Straßenraum), in dem man auf der Neusser Straße startet, zu Fuß geht, in geparkte Autos steigt und fährt, mit Tag/Nacht nach echter Uhrzeit.

**Architecture:** npm-Workspaces-Monorepo. `packages/pipeline` (Node, offline) lädt NRW-LoD2-CityGML und OSM einmalig und schreibt kompakte Spiel-Assets nach `apps/client/public/world/`. `packages/shared` enthält Koordinaten, Sonnenstand, Asset-Formate und die Rapier-Physik (Figur, Auto) – so geschnitten, dass der Server aus Plan 2 sie unverändert nutzt. `apps/client` (Vite + Three.js) lädt Assets in Chunks, rendert prozedurale Fassaden und steuert Figur/Auto.

**Tech Stack:** TypeScript (strict), Node 24, npm workspaces, Vite, Vitest, three, @dimforge/rapier3d-compat, proj4, earcut, fast-xml-parser, @gltf-transform/core + extensions (meshopt), suncalc. Versionen beim Installieren auf aktuellen Stable-Stand, exakt gepinnt in `package.json`.

**Spec:** `docs/superpowers/specs/2026-11-15-nippes-nights-design.md`

**Scope:** Dieser Plan deckt Datenaufbereitung + Einzelspieler-Welt ab. Mehrspieler (Namenseingabe, Colyseus-Server, server-autoritative Kollisionen, Lasttest) folgt als Plan 2 und baut auf `packages/shared` auf.

## Global Constraints

- Nur offene Daten: NRW LoD2 (dl-de/zero-2.0) + OpenStreetMap (ODbL). Keine handmodellierten Landmarken, keine Fotos, keine Google-/kommerziellen 3D-Tiles.
- Im Spiel sichtbar: „© OpenStreetMap-Mitwirkende (ODbL) · 3D-Gebäude: Geobasis NRW (dl-de/zero-2.0)“.
- Keine GTA-Namen, -Figuren, -Logos, -Musik, -Optik oder -HUD-Anmutung.
- Ladennamen: erfunden, gern Anspielung auf echte Läden der Neusser Straße; keine echten Logos, nichts mit echten Marken Verwechselbares.
- Tag/Nacht folgt 1:1 der lokalen Browser-Uhrzeit; Sonnenstand für Köln-Nippes berechnet; beide Lichtstimmungen Pflicht. Entwickler-Override per URL `?time=HH:MM`.
- Leistung: ≥ 50 fps auf dem Mac des Nutzers in Chrome, bei Tag und Nacht; Ladezeit < 10 s; Nachtlicht über Emissive-Materialien + max. 8 echte Punktlichter nahe der Kamera.
- Spielbereich: OSM-Relation 2613766 (Stadtteil Nippes, admin_level 10). Gebäude bis 150 m außerhalb als Kulisse ohne Ladenlokale.
- Start: Neusser Straße, Höhe Wilhelmplatz (OSM-Weg 59506057, Zentrum 50.9630937 N, 6.9521820 E).
- Koordinaten: lokaler Ursprung `ORIGIN_UTM = { e: 356198, n: 5647717 }` (EPSG:25832, ≈ Wilhelmplatz). Welt: `x = e - 356198` (Ost), `y` = Höhe, `z = -(n - 5647717)` (Süd positiv, Three.js-üblich).
- Gelände flach: jedes Gebäude wird so verschoben, dass sein niedrigster GroundSurface-Punkt auf `y = 0` liegt.
- Physik mit Rapier, fester Schritt 1/60 s; Code in `packages/shared`, frei von Three.js und DOM (läuft in Node).
- Overpass-Anfragen mit generischem User-Agent `nippes-nights-pipeline/0.1`, keine persönlichen Daten.
- Rohdaten (`data/raw/`) nicht ins Repo; erzeugte Assets in `apps/client/public/world/` werden eingecheckt.

## Review Focus

1. **Kaputte LoD2-Polygone** (doppelte Schlusspunkte, kollineare Punkte, Ringe < 3 Punkte, nicht-planare Flächen): Pipeline überspringt/repariert sie, statt abzustürzen oder Zacken zu erzeugen → Test in Task 4.
2. **Zeitzone/Sommerzeit:** „lokale Zeit“ heißt Uhrzeit-an-der-Wand des Besuchers, angewandt auf Köln. Ein Besucher in New York um 21:00 sieht Nacht in Nippes; die DST-Umstellungsnacht wirft nicht → Tests in Task 9.
3. **Spawn/Grenzen:** Figur spawnt nie in einem Gebäude oder Auto, fällt an Chunk-Grenzen nicht durch den Boden und kann den Spielbereich nicht verlassen → Tests in Task 7 und Task 10.
4. **Große Frame-Sprünge** (Tab im Hintergrund, Pointer-Lock verloren): Physik bekommt höchstens 5 Schritte pro Frame, kein Durchtunneln von Wänden → Test in Task 10.
5. **Laden schlägt fehl** (kein WebGL, Asset 404, langsame Leitung): Ladebildschirm zeigt Fortschritt und eine verständliche Fehlermeldung statt einer leeren Seite → Test in Task 12.

---

## File Structure

```
package.json                     workspaces, scripts: test, build, pipeline, dev
tsconfig.base.json
.gitignore                       node_modules, data/raw, dist
packages/shared/src/
  geo.ts                         ORIGIN_UTM, utmToLocal, wgs84ToLocal, localToWgs84
  sun.ts                         sunState(now, override?)
  assets/manifest.ts             WorldManifest-Typen + parseManifest
  assets/collision.ts            CollisionAsset encode/decode (binär)
  physics/world.ts               createPhysicsWorld(collision)
  physics/character.ts           Character (Rapier KinematicCharacterController)
  physics/vehicle.ts             Vehicle (Rapier DynamicRayCastVehicleController)
  physics/step.ts                FixedStepper
  physics/tuning.ts              alle Zahlen für Laufen/Fahren
packages/pipeline/src/
  fetch.ts                       Kachel-Download + Overpass mit Cache
  citygml.ts                     parseCityGml
  triangulate.ts                 triangulatePolygon3d
  buildings.ts                   buildBuildingMeshes
  osm.ts                         parseOsm → OsmFeatures
  streets.ts                     Straßen-/Gehweg-/Gleis-/Bordstein-Geometrie
  roadgraph.ts                   buildRoadGraph
  parking.ts                     parkedCarSpots
  shops.ts                       Ladenlokale + Namenszuordnung
  chunks.ts                      Chunking + glTF-Export
  spawn.ts                       findSpawn
  main.ts                        CLI: npm run pipeline
packages/pipeline/fixtures/      kleine GML/OSM-JSON-Testdateien
data/shop-names.json             kuratierte Anspielungs-Namen (eingecheckt)
apps/client/
  index.html
  src/main.ts                    Boot, Ladebildschirm, Game-Loop
  src/loader.ts                  Manifest + Chunk-Streaming
  src/materials/facade.ts        prozedurales Fassaden-Material
  src/materials/street.ts        Straßen/Gehweg/Gleis-Materialien
  src/lighting.ts                Sonne, Himmel, Laternen-Pool
  src/props.ts                   Bäume, Laternen, Haltestellen, Schilder (instanziert)
  src/player.ts                  Figur-Modell + Animation
  src/car.ts                     Auto-Modell
  src/camera.ts                  Third-Person-Kamera
  src/input.ts                   Tastatur/Maus/Pointer-Lock
  src/hud.ts                     Lade-/Fehleranzeige, Steuerhinweis, Attribution
```

---

### Task 1: Monorepo-Gerüst

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `packages/shared/package.json`, `packages/pipeline/package.json`, `apps/client/package.json`, `apps/client/index.html`, `apps/client/src/main.ts`, `apps/client/vite.config.ts`
- Test: `packages/shared/src/smoke.test.ts`

**Interfaces:**
- Produces: Root-Scripts `npm test` (Vitest über alle Workspaces), `npm run dev` (Vite-Client), `npm run build`, `npm run pipeline` (tsx `packages/pipeline/src/main.ts`). Paketnamen `@nn/shared`, `@nn/pipeline`, `@nn/client`.

- [ ] **Step 1:** `git init`, Spec und dieser Plan sind bereits unter `docs/`.
- [ ] **Step 2:** Workspaces, TS-Configs (strict, ES2022, moduleResolution bundler), Vitest anlegen. Smoke-Test `expect(1 + 1).toBe(2)` in `packages/shared/src/smoke.test.ts`.
- [ ] **Step 3:** Client: `index.html` mit `<canvas id="game">`, `main.ts` rendert eine leere Three.js-Szene mit grauem Boden.
- [ ] **Step 4:** Run `npm test` → PASS. Run `npm run build` → baut ohne Fehler.
- [ ] **Step 5:** Commit `chore: monorepo scaffold`.

### Task 2: Koordinaten

**Files:**
- Create: `packages/shared/src/geo.ts`
- Test: `packages/shared/src/geo.test.ts`

**Interfaces:**
- Produces: `ORIGIN_UTM: { e: number; n: number }`, `utmToLocal(e: number, n: number): { x: number; z: number }`, `wgs84ToLocal(lat: number, lon: number): { x: number; z: number }`, `localToWgs84(x: number, z: number): { lat: number; lon: number }`. UTM-Definition `+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs`.

- [ ] **Step 1: Failing tests**

```ts
test('origin maps to 0,0', () => expect(utmToLocal(356198, 5647717)).toEqual({ x: 0, z: -0 }));
test('north is negative z, east positive x', () => {
  expect(utmToLocal(356208, 5647727)).toEqual({ x: 10, z: -10 });
});
test('Wilhelmplatz centre is near origin', () => {
  const p = wgs84ToLocal(50.9630937, 6.952182);
  expect(Math.hypot(p.x, p.z)).toBeLessThan(2);
});
test('round trip', () => {
  const p = localToWgs84(...Object.values(wgs84ToLocal(50.97, 6.95)) as [number, number]);
  expect(p.lat).toBeCloseTo(50.97, 6); expect(p.lon).toBeCloseTo(6.95, 6);
});
```

- [ ] **Step 2:** Run `npx vitest run packages/shared/src/geo.test.ts` → FAIL.
- [ ] **Step 3:** Implement with proj4.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): local coordinate system`.

### Task 3: Daten holen

**Files:**
- Create: `packages/pipeline/src/fetch.ts`
- Test: `packages/pipeline/src/fetch.test.ts`

**Interfaces:**
- Produces: `LOD2_TILES: string[]` (12 Namen), `tileNamesForBounds(minE, minN, maxE, maxN): string[]`, `fetchLod2Tiles(dir: string): Promise<string[]>` (Pfade), `fetchOsm(dir: string): Promise<string>` (Pfad zu `osm.json`). Basis-URL `https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/`, Namensschema `LoD2_32_{E-km}_{N-km}_1_NW.gml`.

- [ ] **Step 1: Failing test**

```ts
test('tiles cover Nippes plus 150 m backdrop', () => {
  const t = tileNamesForBounds(355389 - 150, 5646699 - 150, 357399 + 150, 5648852 + 150);
  expect(t).toHaveLength(12);
  expect(t).toContain('LoD2_32_355_5646_1_NW.gml');
  expect(t).toContain('LoD2_32_357_5649_1_NW.gml');
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Downloads nach `data/raw/lod2/`, überspringen wenn vorhanden. Overpass (`https://overpass-api.de/api/interpreter`, UA aus Global Constraints, bei 429/504 bis 3× mit 30 s Pause): Relation 2613766 mit Geometrie, plus im Bounding-Box-Bereich (Grenze + 150 m): `highway`, `railway=tram`, `public_transport`/`railway=tram_stop`, `leisure`, `landuse`, `natural=tree|tree_row`, `highway=street_lamp`, `shop`, `amenity`, `parking:*`-getaggte Wege, `out geom`.
- [ ] **Step 4:** Run test → PASS. Run `npm run pipeline -- --fetch-only` → 12 GML-Dateien + `osm.json` in `data/raw/`.
- [ ] **Step 5:** Commit `feat(pipeline): fetch LoD2 tiles and OSM`.

### Task 4: CityGML lesen und triangulieren

**Files:**
- Create: `packages/pipeline/src/citygml.ts`, `packages/pipeline/src/triangulate.ts`, `packages/pipeline/fixtures/gable-house.gml`, `packages/pipeline/fixtures/broken.gml`
- Test: `packages/pipeline/src/citygml.test.ts`, `packages/pipeline/src/triangulate.test.ts`

**Interfaces:**
- Produces:
  - `type SurfaceKind = 'wall' | 'roof' | 'ground' | 'closure'`
  - `type Ring = [number, number, number][]` (UTM e, n, z; ohne doppelten Schlusspunkt)
  - `type Surface = { kind: SurfaceKind; outer: Ring; holes: Ring[] }`
  - `type CityBuilding = { id: string; street?: string; number?: string; roofType: string; measuredHeight: number; surfaces: Surface[] }` – BuildingParts werden in ihr Building aufgelöst; Adresse aus `xal:ThoroughfareName`/`ThoroughfareNumber`.
  - `parseCityGml(xml: string): CityBuilding[]`
  - `triangulatePolygon3d(outer: Ring, holes: Ring[]): { positions: number[]; indices: number[] } | null` – Projektion auf die Ebene der Newell-Normale, earcut, `null` bei entarteten Flächen.

Ignoriert werden `lod2TerrainIntersection`-Kurven (MultiCurve). Fixture `gable-house.gml`: ein 10×8-m-Haus, Traufe 9 m, First 13 m, mit Adresse „Neusser Str. 1“, als ein Building mit einem BuildingPart. Fixture `broken.gml`: ein Ring mit 2 Punkten, ein Ring mit nur kollinearen Punkten, ein Ring mit doppeltem Schlusspunkt, eine gültige Wand.

- [ ] **Step 1: Failing tests**

```ts
test('parses gable house', () => {
  const [b] = parseCityGml(read('gable-house.gml'));
  expect(b.street).toBe('Neusser Str.'); expect(b.number).toBe('1');
  expect(b.surfaces.filter(s => s.kind === 'roof')).toHaveLength(2);
  expect(b.surfaces.filter(s => s.kind === 'wall')).toHaveLength(4);
  expect(b.surfaces.every(s => s.outer.length >= 3)).toBe(true);
});
test('closing point removed', () => {
  const [b] = parseCityGml(read('gable-house.gml'));
  const r = b.surfaces[0].outer; expect(r[0]).not.toEqual(r[r.length - 1]);
});
test('broken polygons are skipped, valid wall survives', () => {
  const [b] = parseCityGml(read('broken.gml'));
  const tris = b.surfaces.map(s => triangulatePolygon3d(s.outer, s.holes)).filter(Boolean);
  expect(tris).toHaveLength(1);
});
test('vertical wall triangulates to 2 triangles with area preserved', () => {
  const t = triangulatePolygon3d([[0,0,0],[10,0,0],[10,0,9],[0,0,9]], [])!;
  expect(t.indices).toHaveLength(6); expect(triangleArea(t)).toBeCloseTo(90, 3);
});
test('polygon with hole', () => {
  const t = triangulatePolygon3d([[0,0,0],[10,0,0],[10,10,0],[0,10,0]], [[[4,4,0],[6,4,0],[6,6,0],[4,6,0]]])!;
  expect(triangleArea(t)).toBeCloseTo(96, 3);
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. fast-xml-parser mit `removeNSPrefix: false`, `isArray` für `cityObjectMember`, `surfaceMember`, `boundedBy`, `consistsOfBuildingPart`, `interior`.
- [ ] **Step 4:** Run → PASS. Smoke: `parseCityGml` auf `data/raw/lod2/LoD2_32_356_5647_1_NW.gml` liefert > 500 Gebäude, mindestens eins mit `street === 'Neusser Str.'`.
- [ ] **Step 5:** Commit `feat(pipeline): parse and triangulate CityGML`.

### Task 5: Gebäude-Meshes mit Fassaden-Attributen

**Files:**
- Create: `packages/pipeline/src/buildings.ts`
- Test: `packages/pipeline/src/buildings.test.ts`

**Interfaces:**
- Consumes: `parseCityGml`, `triangulatePolygon3d`, `utmToLocal`.
- Produces: `type BuildingMesh = { id: string; centroid: { x: number; z: number }; positions: Float32Array; normals: Float32Array; facadeUv: Float32Array; kind: Uint8Array; buildingSeed: number; flags: number }` und `buildBuildingMesh(b: CityBuilding): BuildingMesh | null`.
  - `kind` pro Vertex: 0 Wand, 1 Dach, 2 Boden (Boden wird verworfen, nicht exportiert), 3 Closure (verworfen).
  - `facadeUv` pro Vertex: `u` = Meter entlang der Wand (horizontale Distanz vom ersten Wandpunkt, je Wandfläche), `v` = Höhe über Gebäudeboden in Metern. Für Dächer: Weltkoordinaten x/z.
  - `buildingSeed`: stabiler 32-bit-Hash der `id` (FNV-1a).
  - `flags`: Bit 0 = Adresse an „Neusser Str.“ (Ladenzeile), Bit 1 = Kulisse (außerhalb Spielbereich, wird in Task 8 gesetzt).
  - Höhe: alle Punkte minus min(z) der GroundSurfaces → Gebäudeboden bei y = 0.

- [ ] **Step 1: Failing tests**

```ts
test('gable house sits on y=0 and reaches 13 m', () => {
  const m = buildBuildingMesh(parseCityGml(read('gable-house.gml'))[0])!;
  expect(minY(m)).toBeCloseTo(0, 3); expect(maxY(m)).toBeCloseTo(13, 1);
});
test('wall normals point away from centroid', () => { /* für jedes Wand-Dreieck: dot(normal, mid - centroid) > 0 */ });
test('facade v equals height above ground', () => { /* Vertex auf Traufe hat v ≈ 9 */ });
test('Neusser Str. flag set', () => expect(m.flags & 1).toBe(1));
test('seed is stable', () => expect(buildBuildingMesh(b)!.buildingSeed).toBe(buildBuildingMesh(b)!.buildingSeed));
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Normalen flach pro Dreieck; Windungsreihenfolge so drehen, dass Wandnormalen nach außen zeigen.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(pipeline): building meshes with facade attributes`.

### Task 6: OSM-Straßenraum

**Files:**
- Create: `packages/pipeline/src/osm.ts`, `packages/pipeline/src/streets.ts`, `packages/pipeline/src/roadgraph.ts`, `packages/pipeline/src/parking.ts`, `packages/pipeline/fixtures/osm-small.json`
- Test: `packages/pipeline/src/osm.test.ts`, `packages/pipeline/src/streets.test.ts`, `packages/pipeline/src/roadgraph.test.ts`

**Interfaces:**
- Consumes: `wgs84ToLocal`.
- Produces:
  - `type Pt = { x: number; z: number }`
  - `type OsmFeatures = { boundary: Pt[]; roads: Road[]; tramTracks: Pt[][]; tramStops: { pos: Pt; name: string }[]; greens: Pt[][]; trees: Pt[]; lamps: Pt[]; shops: { pos: Pt; name?: string; type: string }[]; squares: { name: string; outline: Pt[] }[] }`
  - `type Road = { id: number; name?: string; kind: string; points: Pt[]; width: number; oneway: boolean; lanes: number }` – Breite: `width`-Tag, sonst `lanes × 3.25`, sonst nach `kind` (primary 10, secondary 9, tertiary 8, residential 6.5, service 4, footway/path/cycleway 2.5, pedestrian 6).
  - `parseOsm(json: unknown): OsmFeatures`
  - `buildStreetGeometry(f: OsmFeatures): { road: Mesh; sidewalk: Mesh; curb: Mesh; tram: Mesh; green: Mesh; squares: Mesh }` mit `type Mesh = { positions: Float32Array; indices: Uint32Array; uv: Float32Array }`. Straßen als Bänder auf y = 0.01; Bordsteine 0.12 m hoch, 0.15 m breit an Kanten befahrbarer Straßen außer an Kreuzungen (5 m Abstand vom Knoten mit ≥ 3 Wegen); Gehweg 2.5 m breit außerhalb der Bordsteine auf y = 0.12; Gleise als zwei Schienenpaare (Spur 1.435 m).
  - `type RoadGraph = { nodes: { id: number; pos: Pt }[]; edges: { from: number; to: number; roadId: number; lanesForward: number; lanesBackward: number; tram: boolean }[]; stops: { name: string; pos: Pt; edgeIndex: number }[] }` und `buildRoadGraph(f: OsmFeatures): RoadGraph`.
  - `parkedCarSpots(f: OsmFeatures, seed: number): { pos: Pt; heading: number }[]` – an residential/tertiary-Straßen alle 6 m am rechten Rand mit 40 % Belegung, nicht innerhalb 10 m von Kreuzungen, Haltestellen oder auf Gleisen; höchstens 300 Spots.

Fixture: eine Kreuzung zweier residential-Straßen, ein Tram-Gleis mit Haltestelle „Florastr.“, ein Park, drei Bäume, zwei Laternen, ein Laden, ein Grenzpolygon.

- [ ] **Step 1: Failing tests** – Fixture-basiert: Anzahl Straßen/Bäume/Laternen; Breite residential ohne Tags = 6.5; Graph hat einen Knoten mit Grad 4 an der Kreuzung; Haltestelle ist der Gleis-Kante zugeordnet; keine Bordstein-Vertices innerhalb 5 m vom Kreuzungsknoten; kein Parkplatz innerhalb 10 m von Kreuzung oder Haltestelle; zweimal gleiche Seed → gleiche Spots.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(pipeline): streets, tram, road graph, parking spots`.

### Task 7: Kollisions-Asset, Spawn, Chunks, Manifest

**Files:**
- Create: `packages/shared/src/assets/manifest.ts`, `packages/shared/src/assets/collision.ts`, `packages/pipeline/src/chunks.ts`, `packages/pipeline/src/spawn.ts`, `packages/pipeline/src/main.ts`
- Test: `packages/shared/src/assets/collision.test.ts`, `packages/pipeline/src/spawn.test.ts`, `packages/pipeline/src/chunks.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `type CollisionAsset = { vertices: Float32Array; indices: Uint32Array; boundary: Float32Array /* x,z-Paare */ }`; `encodeCollision(a): ArrayBuffer`, `decodeCollision(buf: ArrayBuffer): CollisionAsset`. Format: Magic `NNC1`, uint32 Längen, dann die drei Arrays little-endian. Enthält Gebäudewände/-dächer, Bordsteine und Boden (ein großes Rechteck auf y = 0 über den ganzen Bereich).
  - `type WorldManifest = { version: 1; origin: { e: number; n: number }; chunkSize: 200; chunks: { key: string; x: number; z: number; file: string; bytes: number }[]; spawn: { x: number; y: number; z: number; heading: number }; boundary: [number, number][]; lamps: [number, number][]; trees: [number, number][]; tramStops: { name: string; x: number; z: number }[]; shops: { x: number; z: number; label: string; type: string; buildingId?: string }[]; parked: { x: number; z: number; heading: number; color: number }[]; attribution: string }`; `parseManifest(json: unknown): WorldManifest` (wirft bei Schemafehler).
  - `findSpawn(roads: Road[], target: Pt, buildings: BuildingMesh[]): { x: number; y: number; z: number; heading: number }` – nächster Punkt auf einer Straße mit `name === 'Neusser Straße'` zu `target`, dann seitlich auf den Gehweg (Straßenbreite/2 + 1.5 m) auf die Seite, deren Punkt in keinem Gebäudegrundriss liegt; `heading` entlang der Straße Richtung Norden.
  - Output: `apps/client/public/world/manifest.json`, `chunk_{ix}_{iz}.glb` (Gebäude, Straßen, Grün je Chunk; Meshopt-komprimiert; Vertex-Attribute `facadeUv`, `kind`, `seed`, `flags` als `_FACADEUV` usw.), `collision.bin`, `roadgraph.json`.
  - Gebäude außerhalb der Grenze, aber ≤ 150 m entfernt: `flags |= 2`; weiter entfernt: verworfen.
  - Später austauschbare Gebäude (Spec): jedes Chunk-GLB trägt in `extras.buildings` die Liste `{ id, firstVertex, vertexCount }`; `main.ts` liest optional `data/building-overrides.json` (`{ [id]: "pfad.glb" }`, anfangs `{}`) und lässt dort genannte Gebäude weg bzw. bindet das Ersatz-GLB ein. Test: Override-Eintrag entfernt das Gebäude aus Chunk-Geometrie und Kollision.

- [ ] **Step 1: Failing tests**

```ts
test('collision round trip', () => { const a = sample(); expect(decodeCollision(encodeCollision(a))).toEqual(a); });
test('decode rejects wrong magic', () => expect(() => decodeCollision(new ArrayBuffer(16))).toThrow());
test('spawn is on Neusser Straße sidewalk near Wilhelmplatz and outside buildings', () => {
  const s = findSpawn(fixtureRoads, { x: 0, z: 0 }, fixtureBuildings);
  expect(Math.hypot(s.x, s.z)).toBeLessThan(80);
  expect(insideAnyFootprint(s, fixtureBuildings)).toBe(false);
});
test('chunk key for point', () => expect(chunkKey(-1, 399)).toBe('-1_1'));
test('manifest parse rejects missing spawn', () => expect(() => parseManifest({ version: 1 })).toThrow());
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `main.ts` verdrahtet fetch → parse → meshes → streets → chunks → manifest; Läden zunächst mit Platzhalter-Label (Task 11 ersetzt).
- [ ] **Step 4:** Run tests → PASS. Run `npm run pipeline` → Ausgabe erzeugt; Summe aller Dateien in `apps/client/public/world/` < 25 MB (Ausgabe des Skripts nennt die Summe); Spawn liegt < 80 m vom Ursprung.
- [ ] **Step 5:** Commit `feat(pipeline): world assets, collision, spawn` (inkl. erzeugter Assets).

### Task 8: Welt im Browser anzeigen

**Files:**
- Create: `apps/client/src/loader.ts`, `apps/client/src/materials/facade.ts`, `apps/client/src/materials/street.ts`, `apps/client/src/hud.ts`
- Modify: `apps/client/src/main.ts`
- Test: `apps/client/src/loader.test.ts`

**Interfaces:**
- Consumes: `parseManifest`, Chunk-GLBs.
- Produces: `class WorldLoader { constructor(scene: THREE.Scene, baseUrl: string); init(onProgress: (p: number) => void): Promise<WorldManifest>; update(cameraPos: THREE.Vector3): void }` – lädt Chunks ≤ 600 m vom Spieler, entlädt > 800 m, max. 2 gleichzeitige Downloads. `chunksToLoad(manifest, pos, loaded): string[]` als reine Funktion (getestet). `createFacadeMaterial(): THREE.MeshStandardMaterial` (über `onBeforeCompile`) mit Uniform `nightFactor` (0..1).
- Fassaden-Regeln (Shader, aus `facadeUv`, `seed`, `flags`): Geschosshöhe 3.2 m (EG 4.2 m bei Bit 0), Fensterachsen alle 2.6 m, Fenster 1.2 × 1.6 m mit Laibung; Putzfarbe aus Palette von 10 kölschen Altbautönen (Ocker, Altrosa, Hellgrau, Weiß, Sandstein, Taubenblau …) per `seed`; Bit 0: EG mit großen Schaufenstern statt Fenstern; Bit 1 (Kulisse): einfarbig, keine Fenster. Nacht: pro Fenster per Hash 35 % warm beleuchtet, Schaufenster 90 %, Emission × `nightFactor`. Dach: Ziegelrot/Schiefergrau per `seed`.

- [ ] **Step 1: Failing test** – `chunksToLoad` liefert bei Position (0,0) alle Chunks mit Mittelpunkt ≤ 600 m, sortiert nach Entfernung, ohne bereits geladene.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; vorläufige Free-Fly-Kamera am Spawn; HUD zeigt Ladebalken und dauerhaft die Attribution aus dem Manifest.
- [ ] **Step 4:** Run test → PASS. `npm run dev`, im Browser: Neusser Straße am Spawn sichtbar, Gebäude mit Satteldächern, farbige Fassaden mit Fenstern, Läden im EG, Straßen, Gleise, Grünflächen. Screenshot für den Nutzer.
- [ ] **Step 5:** Commit `feat(client): render world with procedural facades`.

### Task 9: Sonne, Tag und Nacht

**Files:**
- Create: `packages/shared/src/sun.ts`, `apps/client/src/lighting.ts`, `apps/client/src/props.ts`
- Test: `packages/shared/src/sun.test.ts`

**Interfaces:**
- Produces: `type SunState = { altitude: number /* rad */; azimuth: number /* rad, three.js-Konvention */; nightFactor: number /* 0 Tag … 1 Nacht, linear zwischen Sonnenhöhe +6° und −6° */ }`; `cologneInstantFromLocal(now: Date, override?: string): Date` – nimmt Datum + Wanduhrzeit des Browsers (bzw. `HH:MM` aus Override) und liefert den Zeitpunkt, an dem in `Europe/Berlin` dieselbe Wanduhrzeit gilt; `sunState(now: Date, override?: string): SunState` (suncalc, 50.9631 N, 6.9522 E).
- Client: `Lighting.update(sun: SunState, cameraPos)`: Directional-Light aus Sonnenrichtung mit Schatten nur im 150-m-Umkreis der Kamera; Himmels-/Nebelfarbe nach Sonnenhöhe; Mond-Blaulicht nachts; Laternen (aus Manifest, instanziert, Leuchtkopf emissiv × `nightFactor`) und die 8 nächsten Laternen als echte PointLights. Bäume als instanzierte Low-Poly-Bäume; Haltestellen mit Häuschen und Schild (Name aus Manifest).

- [ ] **Step 1: Failing tests**

```ts
const at = (iso: string, o?: string) => sunState(new Date(iso), o);
test('midsummer noon in Köln is high daylight', () => {
  const s = at('2026-06-21T13:30:00+02:00'); expect(s.altitude * 180 / Math.PI).toBeGreaterThan(55); expect(s.nightFactor).toBe(0);
});
test('winter midnight is night', () => expect(at('2026-12-21T00:00:00+01:00').nightFactor).toBe(1));
test('wall-clock time is used regardless of browser timezone', () => {
  // gleicher Wanduhr-Wert 21:00 am 15.11. → Nacht in Köln, egal welche TZ der Browser hat
  expect(cologneInstantFromLocal(fakeLocalDate(2026, 10, 15, 21, 0, 'America/New_York')).toISOString())
    .toBe('2026-11-15T20:00:00.000Z');
});
test('override HH:MM wins', () => expect(at('2026-06-21T13:30:00+02:00', '23:30').nightFactor).toBe(1));
test('invalid override is ignored', () => expect(at('2026-06-21T13:30:00+02:00', '99:xx').nightFactor).toBe(0));
test('DST switch night does not throw', () => expect(() => cologneInstantFromLocal(new Date(2026, 2, 29, 2, 30))).not.toThrow());
```

`fakeLocalDate` erzeugt ein `Date`, dessen `getFullYear/…/getMinutes` die genannten Werte liefern (über `vi.stubEnv('TZ', …)` bzw. Konstruktion mit lokalen Feldern); die Implementierung darf nur die lokalen Getter lesen.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Client liest `?time=` aus der URL und aktualisiert die Sonne einmal pro Sekunde.
- [ ] **Step 4:** Run → PASS. Im Browser mit `?time=12:00`, `?time=17:15`, `?time=23:00` prüfen; Screenshots für den Nutzer.
- [ ] **Step 5:** Commit `feat: real-time sun and night lighting`.

### Task 10: Physik – Figur und Auto (shared)

**Files:**
- Create: `packages/shared/src/physics/world.ts`, `character.ts`, `vehicle.ts`, `step.ts`, `tuning.ts`
- Test: `packages/shared/src/physics/physics.test.ts`

**Interfaces:**
- Consumes: `CollisionAsset`.
- Produces:
  - `createPhysicsWorld(c: CollisionAsset): Promise<PhysicsWorld>`; `PhysicsWorld = { rapier; world: RAPIER.World; step(): void }`. Statische Trimesh aus `vertices/indices`; Grenze als 4 m hohe unsichtbare Wandsegmente entlang `boundary`.
  - `type CharacterInput = { forward: number; right: number; run: boolean; yaw: number }` (forward/right in −1..1)
  - `class Character { constructor(pw: PhysicsWorld, spawn: {x;y;z}); applyInput(i: CharacterInput, dt: number): void; position(): {x;y;z}; velocity(): {x;y;z}; setEnabled(on: boolean): void }` – Kapsel r 0.3, h 1.8; Gehen 1.6 m/s, Rennen 5.5 m/s, Stufen bis 0.25 m, Schwerkraft −20.
  - `type VehicleInput = { throttle: number; steer: number; brake: boolean }`
  - `class Vehicle { constructor(pw, pose: {x;z;heading}); applyInput(i: VehicleInput, dt: number): void; pose(): { x; y; z; qx; qy; qz; qw }; speed(): number }` – Box 4.2 × 1.5 × 1.8 m, 1200 kg, 4 Räder, Höchstgeschwindigkeit 60 km/h vorwärts, 20 km/h rückwärts, überfährt Bordsteine 0.12 m.
  - `class FixedStepper { constructor(step = 1/60, maxSteps = 5); advance(dt: number, fn: () => void): number /* ausgeführte Schritte */ }`
  - Alle Zahlen in `tuning.ts`.

- [ ] **Step 1: Failing tests** (Node, Rapier-WASM via `await RAPIER.init()`, Mini-Collision: Boden + eine Wand bei x = 10 + Bordstein bei z = 5):
  - Figur gespawnt auf y = 1 steht nach 1 s auf dem Boden (y-Fuß ≈ 0 ± 0.05).
  - Figur läuft 5 s gegen die Wand → x bleibt < 10 − 0.3.
  - Rennen erreicht 5.5 ± 0.3 m/s.
  - Figur steigt den 0.12-m-Bordstein hoch.
  - Auto Vollgas 10 s → Geschwindigkeit ≤ 60 km/h + 1 und > 50 km/h.
  - Auto fährt mit 50 km/h gegen die Wand → durchdringt sie nicht.
  - Auto fährt über den Bordstein, ohne stecken zu bleiben.
  - `FixedStepper.advance(2.0)` führt genau 5 Schritte aus (Frame-Sprung-Schutz).
  - Figur kann die Grenzwand nicht durchlaufen.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): rapier character and vehicle`.

### Task 11: Spielen – Figur, Kamera, Autos, Ladennamen

**Files:**
- Create: `apps/client/src/player.ts`, `apps/client/src/car.ts`, `apps/client/src/camera.ts`, `apps/client/src/input.ts`, `packages/pipeline/src/shops.ts`, `data/shop-names.json`
- Modify: `apps/client/src/main.ts`, `apps/client/src/props.ts`, `packages/pipeline/src/main.ts`
- Test: `apps/client/src/input.test.ts`, `packages/pipeline/src/shops.test.ts`

**Interfaces:**
- Consumes: Task 10, Manifest `parked`, `shops`.
- Produces:
  - `nearestEnterableCar(player: {x;z}, cars: { id: number; x; z; occupied: boolean }[], maxDist = 3): number | null`
  - Steuerung: WASD/Pfeile, Shift rennen, Maus (Pointer-Lock nach Klick) dreht Kamera, E ein-/aussteigen, Leertaste Handbremse. Kamera: Third-Person, 4 m hinter/1.8 m über der Figur, im Auto 7 m/2.5 m, weicht Wänden per Raycast aus.
  - Figur: eigene Low-Poly-Figur aus Primitiven (Kopf, Rumpf, Arme, Beine) mit Lauf-Schwing-Animation; Autos: eigener Low-Poly-Kleinwagen/Kombi aus Primitiven, Farbe aus Manifest, Scheinwerfer/Rücklichter emissiv × `nightFactor`.
  - Aussteigen setzt die Figur 1.5 m links neben das Auto; ist dort ein Hindernis, rechts; sonst hinter das Auto.
  - `assignShopLabels(shops: { name?: string; type: string }[], curated: Record<string, string>, seed: number): { label: string }[]` – kuratierter Name, wenn OSM-Name in `data/shop-names.json` steht; sonst generischer Name aus einer Liste je `type` (mind. 8 je häufigem Typ, z. B. kiosk: „Büdchen am Eck“, „Et Büdche“ …; bakery, cafe, restaurant, hairdresser, supermarket, clothes, pharmacy, bar, fallback). Nie den echten OSM-Namen ausgeben.
  - `data/shop-names.json`: Pipeline listet alle Läden mit Adresse „Neusser Str.“ (`npm run pipeline -- --list-shops`); der Implementierer schreibt je eine augenzwinkernde, kölsche Anspielung, die nicht mit der echten Marke verwechselbar ist. **Liste wird dem Nutzer zur Freigabe vorgelegt, bevor sie committet wird.**
  - Schilder: Ladenname als Canvas-Textur über dem Schaufenster des zugeordneten Gebäudes, zur Straße ausgerichtet.

- [ ] **Step 1: Failing tests**

```ts
test('nearest free car within 3 m', () => {
  expect(nearestEnterableCar({ x: 0, z: 0 }, [{ id: 1, x: 2, z: 0, occupied: true }, { id: 2, x: 2.5, z: 0, occupied: false }])).toBe(2);
});
test('no car in range', () => expect(nearestEnterableCar({ x: 0, z: 0 }, [{ id: 1, x: 5, z: 0, occupied: false }])).toBeNull());
test('real OSM name never shown', () => {
  const out = assignShopLabels([{ name: 'Echter Laden', type: 'bakery' }], {}, 1);
  expect(out[0].label).not.toContain('Echter Laden');
});
test('curated name used', () => expect(assignShopLabels([{ name: 'X', type: 'cafe' }], { X: 'Kaffee Klaaf' }, 1)[0].label).toBe('Kaffee Klaaf'));
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; Game-Loop: Input → `FixedStepper` → Character/Vehicle → Render-Interpolation.
- [ ] **Step 4:** Run → PASS. Im Browser: am Spawn auf dem Gehweg stehen, Neusser Straße entlanglaufen, rennen, in ein geparktes Auto steigen, fahren, gegen Häuser fahren (abprallen), über Bordstein, aussteigen; an der Stadtteilgrenze wird man aufgehalten. Ladenliste dem Nutzer zur Freigabe zeigen.
- [ ] **Step 5:** Commit `feat(client): walking, driving, shop signs`.

### Task 12: Laden-/Fehlerfälle, Leistung, Abnahme

**Files:**
- Modify: `apps/client/src/main.ts`, `apps/client/src/hud.ts`, `apps/client/src/loader.ts`
- Test: `apps/client/src/hud.test.ts`

**Interfaces:**
- Produces: `bootErrorMessage(e: unknown): string` – Texte: kein WebGL → „Dein Browser kann leider kein 3D (WebGL). Probier es mit einem aktuellen Chrome, Firefox oder Safari.“; Netzwerk/404 → „Nippes konnte nicht geladen werden. Bitte lade die Seite neu.“; sonst „Da ist was schiefgelaufen. Bitte lade die Seite neu.“. Leistungsanzeige per `?debug=1` (fps, Draw Calls, geladene Chunks).

- [ ] **Step 1: Failing tests** für die drei Meldungen (`new Error('WebGL unavailable')`-Klasse `NoWebGLError`, `new FetchError(404)`, beliebiger Fehler).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; Loader wirft `FetchError` bei !ok; Boot prüft WebGL2 vor allem anderen.
- [ ] **Step 4:** Run `npm test` → alles PASS. Run `npm run build && npx vite preview`; im Chrome mit `?debug=1`:
  - Ladezeit bis spielbar < 10 s (Netzwerk-Drosselung „Fast 4G“ aus).
  - Fahrt die Neusser Straße entlang bei `?time=12:00` und `?time=23:00`: fps ≥ 50 auf dem Mac des Nutzers. Wenn nicht: Schattenradius, Chunk-Radius, Baumdichte in dieser Reihenfolge reduzieren.
  - Nutzer prüft Wiedererkennbarkeit der Neusser Straße.
- [ ] **Step 5:** Commit `feat(client): robust loading, perf overlay`.
