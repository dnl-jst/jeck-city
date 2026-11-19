# Autos neu, Stufe 1: Kleinwagen-Pilot – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Der Kleinwagen ist neu gebaut – Hülle mit echten Fensteröffnungen, durchsichtigem Glas, Türen als eigene Knoten, Innenraum, Sitz- und Lenkradknoten – und steht so im Spiel; der Nutzer bekommt Bilder zur Freigabe.

**Architecture:** Neue Blender-Module `carbody.py` (Hülle, Öffnungen, Türen, Glas, Fernmodell) und `carinterior.py` (Innenraum, Sitze, Lenkrad) neben dem unveränderten `carparts.py`, das die drei alten Typen bis Stufe 2 weiter baut. Sitz- und Türmaße stehen in `packages/shared` (`CAR_SEATS`) und werden gegen die GLB-Knoten getestet. Der Client erkennt neues Glas daran, dass das Material `glass` als durchsichtig (glTF `BLEND`) ankommt; alte Modelle bleiben, wie sie sind.

**Tech Stack:** Blender 5.3 headless (bpy/bmesh), glTF, TypeScript, three.js (InstancedMesh), Vitest, Playwright mit Hardware-GPU.

**Spec:** `docs/superpowers/specs/2026-11-19-autos-neu-design.md` (Stufe 1 der „Reihenfolge“). Stufen 2–4 bekommen eigene Pläne, sobald der Pilot freigegeben ist.

## Global Constraints

- `CAR_SPECS` (Maße, Radstand, Spur, Radradius) bleiben unverändert; `CAR_REPORT` muss für den Kleinwagen weiter Länge 4,05 / Breite 1,75 / Höhe 1,47 (± 2 cm) melden.
- Koordinaten wie `data/models/cars/README.md`: Meter, Blender Z oben, Boden z = 0, Ursprung zwischen den Achsen, Front nach −Y, links = +X. `u` = Meter vor dem Ursprung.
- Bestehende Knoten-/Materialnamen bleiben: `body`, `wheel_fl|fr|rl|rr`, `light_fl|fr`, `tail_l|r`, `paint`, `lamp_front`, `lamp_rear`.
- Skript ändern, nicht die `.blend`; glTF binär ohne Draco; Principled BSDF.
- Kein Größen- oder Dreieckslimit; Grenze ist nur die Bildrate (Task 6).
- Generische Form, keine Marken, keine Logos. Keine Geschlechterbezüge in Texten, Namen, Kommentaren.
- Code und Kommentare englisch wie im Bestand. Arbeit auf Branch `cars-rework`, am Ende PR; nie direkt auf `main`.
- Playwright-Läufe mit Hardware-GPU (`scripts/browser-args.mjs`, kein `NN_SOFTWARE_GL`).
- Blender headless bauen (die Blender-MCP-Instanz kann von anderen Sitzungen belegt sein):
  `blender -b --factory-startup --python data/models/cars/kleinwagen/build.py`

## Review Focus

1. **Blick durch Glas ins Nichts:** Aus jedem Winkel (auch flach von oben durch die Frontscheibe, schräg durchs Heckfenster in den Kofferraum, durch die Seitenscheibe auf die gegenüberliegende Türinnenseite) darf man keine Rückseiten, keinen Boden unter dem Auto und keine Radhaus-Löcher sehen. → Task 3, Bilder `cut` und `through`.
2. **Alte Modelle im selben Spiel:** Die drei alten Typen (Glas undurchsichtig, kein Innenraum) müssen unverändert aussehen und dürfen nicht durchsichtig werden. → Task 5, Test `keeps opaque glass untouched`.
3. **Glas in Instanzen und nachts:** Durchsichtiges Glas ohne Sortierung je Instanz – Auto hinter Auto, Glas vor Regen/Schnee, Scheinwerferkegel eines fahrenden Autos auf ein geparktes. → Task 6, Bilder `row-day`, `row-night`, `rain`.
4. **Fernmodell-Wechsel:** Beim Übergang nah → fern darf das Auto nicht sichtbar „umspringen“ (Glas plötzlich schwarz, Silhouette anders). → Task 2 (Fernmodell aus derselben Außenhaut), Task 6 Bild `lod-pair`.
5. **Figur passt hinein:** Eine 1,78 m große sitzende Gestalt auf jedem der vier Sitze darf nicht durch Dach, Lehne, Lenkrad oder Tür ragen. → Task 3, Prüfpuppe in den Bildern `seated`.

---

### Task 1: Sitz- und Türmaße in `@nn/shared`

**Files:**
- Create: `packages/shared/src/physics/carseats.ts`
- Create: `packages/shared/src/physics/carseats.test.ts`
- Modify: `packages/shared/src/physics/index.ts` (oder wo `cartypes` exportiert wird) – `carseats` mit exportieren

**Interfaces:**
- Produces:
  ```ts
  export type DoorName = 'door_fl' | 'door_fr' | 'door_rl' | 'door_rr';
  /** Car frame as the models': x to the left, u ahead of the axle midpoint, h above the ground (m). */
  export type CarSeat = { x: number; u: number; h: number; door: DoorName };
  export type CarDoor = { hingeX: number; hingeU: number; rearU: number; openAngle: number };
  export type SeatLayout = { seats: CarSeat[]; doors: Partial<Record<DoorName, CarDoor>> };
  /** Seat 0 is the driver. Types without an entry still use the old one-driver model (until stage 2). */
  export const CAR_SEATS: Partial<Record<CarType, SeatLayout>>;
  ```
- Werte Kleinwagen (Startwerte; Task 3 darf sie um wenige cm nachziehen, dann hier und im Modell gleich):
  - seats: `{x: 0.37, u: -0.12, h: 0.50, door: 'door_fl'}`, `{x: -0.37, u: -0.12, h: 0.50, door: 'door_fr'}`, `{x: 0.36, u: -0.95, h: 0.53, door: 'door_rl'}`, `{x: -0.36, u: -0.95, h: 0.53, door: 'door_rr'}`
  - doors: `door_fl {hingeX: 0.86, hingeU: 1.05, rearU: -0.11, openAngle: 1.13}`, `door_fr` gespiegelt (`hingeX: -0.86`), `door_rl {hingeX: 0.87, hingeU: -0.11, rearU: -1.33, openAngle: 1.13}`, `door_rr` gespiegelt.

- [ ] **Step 1: Failing test** in `carseats.test.ts`:
  ```ts
  it('kleinwagen: four seats, each behind its own door inside the body', () => {
    const L = CAR_SEATS.kleinwagen!, sp = CAR_SPECS.kleinwagen;
    expect(L.seats).toHaveLength(4);
    expect(new Set(L.seats.map((s) => s.door)).size).toBe(4);
    expect(L.seats[0]!.x).toBeGreaterThan(0); // the driver sits on the left
    for (const s of L.seats) {
      const d = L.doors[s.door]!;
      expect(Math.abs(s.x)).toBeLessThan(sp.width / 2 - 0.3);
      expect(s.u).toBeLessThan(d.hingeU);
      expect(s.u).toBeGreaterThan(d.rearU);
      expect(Math.sign(d.hingeX)).toBe(Math.sign(s.x));
    }
  });
  ```
- [ ] **Step 2:** `npx vitest run packages/shared/src/physics/carseats.test.ts` → FAIL (Modul fehlt).
- [ ] **Step 3:** `carseats.ts` mit den Typen und Werten oben; Export ergänzen.
- [ ] **Step 4:** Test → PASS; `npm run typecheck` → ohne Fehler.
- [ ] **Step 5:** Commit `feat(shared): seat and door layout per car type (kleinwagen)`.

---

### Task 2: `carbody.py` – Hülle mit Öffnungen, Glas, Türen, Fernmodell

**Files:**
- Create: `data/models/cars/carbody.py`
- Modify: `data/models/cars/kleinwagen/build.py` (auf `carbody` umstellen; Decals/Details zunächst wie bisher)
- Unverändert: `data/models/cars/carparts.py` (alte Typen); `carbody` importiert daraus `tab`, `ring`, `stations`, `apply_modifiers`, `decal`, `decal_object`, `wheel`, `mirror`, `empty`, `export_car`, `clear_scene`, `grid`, `car_materials`.

**Interfaces:**
- Produces (in `carbody.py`):
  ```python
  def car_materials2(paint): ...
      # car_materials() plus: 'glass' as clear glass (base (0.10, 0.13, 0.14), alpha 0.38, rough 0.05, metal 0,
      # blend so the exporter writes alphaMode BLEND), 'glass_dark' (the old opaque glass, for the distance model),
      # 'interior' (0.035 grey, rough 0.8), 'interior_trim' (0.09, rough 0.6), 'seat' (0.06, rough 0.9),
      # 'rubber' (0.02, rough 0.7; window seals), 'lens' (clear lamp cover, alpha 0.25)
  def build_shell(S, M, coll, doors) -> dict
      # doors: {'door_fl': {'u': (rear_u, hinge_u), 'z': (z0, z1), 'side': +1}, ...}
      # returns {'body': Object, 'doors': {name: Object}, 'glass': Object}
  def build_lod(S, M, coll) -> Object      # closed skin, 'glass_dark' on the window faces, no doors, no interior
  def run2(name, here, build, build_lod_extra=None) -> dict   # like carparts.run, see below
  ```
- Verhalten von `build_shell` (das, was nicht aus Signatur und Bildern folgt):
  1. Außenhaut wie bisher aus dem Loft (`S`-Tabellen, Subsurf, Radhäuser per Boolean).
  2. Die Flächen der `side`-/`topglass`-Bereiche werden **herausgelöst** und zu `glass` (eigenes Objekt, Kind von `body`; Seitenscheiben der Türen gehören zum jeweiligen Türobjekt). Glas sitzt 8 mm nach innen versetzt; um jede Öffnung läuft ein `rubber`-Rahmen.
  3. Türflächen (Seitenwand zwischen `u`-Grenzen und `z`-Grenzen, samt Fensterrahmen bis zur Dachkante) werden herausgelöst zu `door_*`, Rand ringsum um 3 mm eingerückt (sichtbare Fuge). Objektursprung auf der Scharnierachse (`hingeX`, `hingeU` aus Task 1, z = 0), Kind von `body`.
  4. Hülle und Türen bekommen Wandstärke nach innen (Solidify 30 mm, Innenseite Material `interior_trim`); in der Türöffnung der Karosserie entsteht dadurch eine sichtbare Laibung, die Radhäuser sind innen geschlossen (Material `dark`).
- `run2`: baut das Nahmodell (`build(coll)`), meldet, speichert `.blend`, exportiert `<name>.glb`, rendert; räumt die Szene, baut das Fernmodell (`build_lod` + Räder/Lampen-Leerobjekte über `build_lod_extra`, dezimiert auf Verhältnis 0,25) und exportiert `<name>_lod.glb`. `CAR_REPORT` enthält zusätzlich `missing` gegen die erweiterte Knotenliste (`door_*` laut `doors`), `glass_tris`, `lod_tris`.
- Review-Bilder (zusätzlich zu `34`, `side`, `rear`, `front`, `grid`): `open` (alle Türen um `openAngle` geöffnet, ¾-Ansicht), `through` (Seitenansicht auf Augenhöhe 1,6 m aus 3 m, durchs Glas). Render-Engine so wählen, dass Glas durchsichtig erscheint (EEVEE, oder Workbench mit Material-Alpha).

- [ ] **Step 1:** `carbody.py` mit `car_materials2`, `build_shell`, `build_lod`, `run2` schreiben; `kleinwagen/build.py` ruft `build_shell` mit den vier Türen (Grenzen aus Task 1: vorn `u` −0,11…1,05, hinten −1,33…−0,11; `z` 0,30…Dachkante) und hängt bestehende Türgriffe, Zierleiste und Spiegel an die jeweilige Tür statt an `body`.
- [ ] **Step 2:** Bauen (Befehl siehe Global Constraints). Erwartet: `CAR_REPORT kleinwagen` mit `missing: []`, Länge/Breite/Höhe im Rahmen, keine Python-Fehler; Dateien `kleinwagen.glb`, `kleinwagen_lod.glb`.
- [ ] **Step 3:** Bilder `shots/cars/kleinwagen-{grid,open,through}.png` ansehen (Read). Abnahme: Scheiben durchsichtig, Öffnungen mit Wandstärke, Türfugen gleichmäßig, Türen drehen um ihre Vorderkante ohne die Karosserie zu durchdringen, keine Shading-Streifen, Außenform nicht schlechter als `git show main:…` (alter Stand in `shots/cars/` zum Vergleich vorher kopieren). Nachbessern, bis das stimmt.
- [ ] **Step 4:** Commit `feat(models): car shell with real window openings, glass, doors (kleinwagen)`.

---

### Task 3: `carinterior.py` – Innenraum, Sitze, Lenkrad, Sitzknoten

**Files:**
- Create: `data/models/cars/carinterior.py`
- Modify: `data/models/cars/kleinwagen/build.py`
- Create: `apps/client/src/car-model-nodes.test.ts` (liest die GLB aus `data/models/cars/`)
- Modify: `packages/shared/src/physics/carseats.ts` (nur falls Maße nachgezogen werden)

**Interfaces:**
- Consumes: `build_shell`-Ergebnis, `car_materials2` (Task 2); `CAR_SEATS` (Task 1).
- Produces (in `carinterior.py`):
  ```python
  def build_interior(S, M, coll, body, layout) -> Object
      # layout: {'seats': [(x, u, h), ...], 'rear_bench': True, 'wheel': {'x': 0.37, 'u': 0.33, 'z': 0.93, 'rake': 0.42, 'r': 0.185}}
      # one mesh object 'interior' (child of body) plus the nodes below
  def manikin(coll, seat, driver=False) -> Object   # review only, never exported: seated figure of 1.78 m
  ```
- Knoten im Export (Kinder von `body`): `interior` (Mesh), `steering` (Mesh, Ursprung in der Lenkradnabe, lokale Z-Achse = Lenksäule) mit Kindern `grip_l`, `grip_r` (Leerobjekte am Kranz, „Viertel vor drei“), `seat_0` … `seat_3` (Leerobjekte am Hüftpunkt, Reihenfolge wie `CAR_SEATS`).
- Inhalt von `interior`: Bodenwanne bis an Schweller und Radhäuser (schließt den Blick nach unten), Stirnwand, Armaturenbrett mit Instrumentenhutze und Lenksäule, Mittelkonsole mit Schalthebel und Handbremse, zwei Vordersitze (Sitzfläche, Lehne, Kopfstütze, je eigene Form – keine Quader), durchgehende Rückbank mit zwei Kopfstützen, Türinnenverkleidungen mit Armlehne (gehören zu den Türobjekten), Kofferraumabdeckung, Dachhimmel, Säulenverkleidung, Innenspiegel an der Frontscheibe.
- `CAR_REPORT` zusätzlich: `seats: [[x, u, h], …]` (Weltposition der `seat_*`-Knoten).
- Review-Bilder zusätzlich: `cut` (Draufsicht ohne Dach/Glas – per Clipping oder ausgeblendet), `seated` (¾-Ansicht und Seitenansicht, alle vier Prüfpuppen gesetzt, Fahrer mit Händen an `grip_l/r`, eine Vordertür offen).

- [ ] **Step 1: Failing test** `apps/client/src/car-model-nodes.test.ts`: liest den JSON-Chunk von `data/models/cars/kleinwagen/kleinwagen.glb` (GLB-Header: 12 Byte, dann Chunk-Länge u32, Typ `JSON`), sammelt Knoten nach Namen und prüft:
  ```ts
  for (const n of ['body', 'interior', 'steering', 'grip_l', 'grip_r', 'door_fl', 'door_fr', 'door_rl', 'door_rr',
    'seat_0', 'seat_1', 'seat_2', 'seat_3', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr', 'light_fl', 'light_fr', 'tail_l', 'tail_r'])
    expect(names).toContain(n);
  // glTF frame: x = left, y = up, z = forward
  CAR_SEATS.kleinwagen!.seats.forEach((s, i) => {
    const [x, y, z] = world(`seat_${i}`);
    expect(Math.hypot(x - s.x, y - s.h, z - s.u)).toBeLessThan(0.05);
  });
  for (const [name, d] of Object.entries(CAR_SEATS.kleinwagen!.doors)) {
    const [x, , z] = world(name);
    expect(Math.hypot(x - d.hingeX, z - d.hingeU)).toBeLessThan(0.05);
  }
  expect(material('glass').alphaMode).toBe('BLEND');
  ```
  (`world(name)`: Translationen entlang der Elternkette summieren; die Kette hat keine Drehung außer bei `steering`, dessen Kinder hier nicht geprüft werden.)
- [ ] **Step 2:** `npx vitest run apps/client/src/car-model-nodes.test.ts` → FAIL (`interior` fehlt).
- [ ] **Step 3:** `carinterior.py` schreiben, in `kleinwagen/build.py` einhängen (Layout aus den Werten von Task 1), bauen.
- [ ] **Step 4:** Bilder `cut`, `seated`, `through` ansehen. Abnahme (Review Focus 1 und 5): kein Blick ins Leere aus den Bildwinkeln; Prüfpuppen ragen nirgends durch Dach, Lehne, Lenkrad, Tür; Kopf ≥ 4 cm unter dem Dachhimmel; Hände erreichen den Kranz mit gebeugtem Arm. Stimmen die Maße nicht: Sitzpunkte verschieben, dann `carseats.ts` und `build.py` **beide** anpassen.
- [ ] **Step 5:** Test → PASS; `npx vitest run packages/shared/src/physics/carseats.test.ts` → PASS.
- [ ] **Step 6:** Commit `feat(models): kleinwagen interior, seats, steering wheel and seat nodes`.

---

### Task 4: Außen mehr Tiefe (Kleinwagen)

**Files:**
- Modify: `data/models/cars/carbody.py` (wiederverwendbare Teile), `data/models/cars/kleinwagen/build.py`

**Interfaces:**
- Produces (in `carbody.py`, für Stufe 2 wiederverwendbar):
  ```python
  def lamp_unit(part, body, M, mat, c, d, outline, depth=0.06) -> Vector
      # cuts a recess into the body, puts reflector + bulb ('chrome', mat) in it and a clear 'lens' cover on top;
      # returns the lamp centre (for the light_*/tail_* empties). mat 'lamp_front' / 'lamp_rear' stays the glowing part.
  def grille(part, body, M, c, d, outline, bars=6, depth=0.04)
  def wheel2(name, M, S, side, coll, parent, loc) -> Object   # rim with real spokes, brake disc and caliper behind, tyre with sidewall profile
  ```
- Dazu im Kleinwagen: abgesetzte Stoßfänger (eigene Kante, unlackierte untere Schürze), Sicke in der Flanke und betonter Radlauf über die `S`-Tabellen bzw. Creases, Türgriffe als Körper mit Griffmulde, Kennzeichen mit Rahmen, Scheibenwischer, Antenne, Auspuff, dritte Bremsleuchte (`lamp_rear`), Tankklappe (Fuge), Seitenblinker.
- Die Materialien `lamp_front`/`lamp_rear` müssen weiter an den leuchtenden Flächen hängen (der Client steuert ihr Leuchten).

- [ ] **Step 1:** Teile schreiben, in `kleinwagen/build.py` die bisherigen Lampen-/Grill-Decals und `wheel` ersetzen. Bauen; `CAR_REPORT`: `missing: []`, Maße im Rahmen.
- [ ] **Step 2:** Bilder `grid`, `front`, `rear`, `34` ansehen und mit dem alten Stand vergleichen. Abnahme: Lampen haben sichtbare Tiefe hinter klarer Abdeckung, Grill ist Geometrie, Räder zeigen Speichen/Bremse, keine z-Fighting-Flecken, keine schwebenden Decals (`DECAL_MISS` leer). Nachbessern, bis das stimmt.
- [ ] **Step 3:** `npx vitest run apps/client/src/car-model-nodes.test.ts` → PASS.
- [ ] **Step 4:** Commit `feat(models): kleinwagen exterior depth – lamp units, grille, wheels, bumpers`.

---

### Task 5: Client – durchsichtiges Glas; Modelle ausliefern

**Files:**
- Modify: `apps/client/src/car.ts` (`instanceMaterial`, `makeRig`, `ParkedCars`-Konstruktor)
- Modify: `apps/client/src/car.test.ts`
- Create: `packages/pipeline/src/ship-cars.ts`; Modify: `packages/pipeline/src/main.ts` (Auto-Block dorthin auslagern), `package.json` (Script `ship-cars`)

**Interfaces:**
- Produces (in `car.ts`):
  ```ts
  /** Clear glass of the new models: material 'glass' that the glTF marks as blended. */
  export function isClearGlass(m: Material): boolean;
  /** The material a car mesh is drawn with: clear glass tuned for the game, everything else as it is. */
  export function carMaterial(m: Material): Material;
  ```
  `carMaterial` für klares Glas: Klon mit `transparent = true`, `depthWrite = false`, `opacity` wie geliefert, `roughness = 0.05`, `metalness = 0`, `envMapIntensity = 1.5`, `side = FrontSide`. Meshes mit klarem Glas: `castShadow = false`, `renderOrder = 1` (nach dem undurchsichtigen Rest des Autos). Gilt für `ParkedCars` (Instanzen; `instanceMaterial` ruft `carMaterial`) und `makeRig` (gefahrenes Auto). Material `lens` (Lampenabdeckung) wird genauso behandelt.
- Produces (Pipeline): `export async function shipCarModels(outDir: string): Promise<WorldManifest['carModels']>` in `ship-cars.ts` (der bisherige Block aus `main.ts`); als Programm gestartet (`npm run ship-cars`) schreibt es `car_<type>{,_lod}.glb` nach `apps/client/public/world/` und ersetzt `carModels` in der dortigen `manifest.json` – ohne den Rest der Pipeline.

- [ ] **Step 1: Failing tests** in `car.test.ts`:
  ```ts
  it('tunes clear glass', () => {
    const g = new MeshStandardMaterial({ name: 'glass', transparent: true, opacity: 0.38 });
    const m = carMaterial(g) as MeshStandardMaterial;
    expect(m).not.toBe(g);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.opacity).toBeCloseTo(0.38);
  });
  it('keeps opaque glass untouched', () => { // the old models
    const g = new MeshStandardMaterial({ name: 'glass' });
    expect(isClearGlass(g)).toBe(false);
    expect(carMaterial(g)).toBe(g);
  });
  it('keeps paint white for instancing', () => { /* existing behaviour of instanceMaterial, if not yet covered */ });
  ```
- [ ] **Step 2:** `npx vitest run apps/client/src/car.test.ts` → FAIL (`carMaterial` fehlt).
- [ ] **Step 3:** `isClearGlass`, `carMaterial` implementieren und in `instanceMaterial`, `ParkedCars` (Schatten/`renderOrder` je Instanz-Mesh) und `makeRig` verwenden.
- [ ] **Step 4:** Tests → PASS.
- [ ] **Step 5:** `ship-cars.ts` auslagern, `main.ts` ruft `shipCarModels(OUT_DIR)`; `"ship-cars": "tsx packages/pipeline/src/ship-cars.ts"` in `package.json`. `npm run ship-cars` → Ausgabe `car models: kleinwagen … KB, …`; `npm run typecheck` und `npm test` → grün.
- [ ] **Step 6:** Commit `feat(client): clear car glass; pipeline: ship car models on their own`.

---

### Task 6: Im Spiel prüfen – Bilder und Bildrate

**Files:**
- Create: `scripts/car-shots.mjs`; Modify: `package.json` (Script `car-shots`)
- Modify: `data/models/cars/carbody.py` / `kleinwagen/build.py` / `apps/client/src/car.ts` nur für Korrekturen aus der Prüfung

**Interfaces:**
- `npm run car-shots -- <baseUrl> <outDir>`: Playwright (Chromium, `browserArgs` aus `scripts/browser-args.mjs`), offline (`?offline=1`), sucht aus den Weltdaten zwei Kleinwagen (Typindex 0), die an einer Straße mit vielen geparkten Autos stehen, und schreibt nach `<outDir>`:
  `near-day.png` (¾ aus 4 m, `time=14:00`), `side-day.png` (Seite aus 3 m, Augenhöhe), `near-night.png` (`time=23:00`), `row-day.png` und `row-night.png` (Straße entlang, viele Autos hintereinander), `rain.png` (Regen-Preset über `weather=`), `lod-pair.png` (dasselbe Auto knapp vor und knapp hinter der Fernmodell-Distanz, nebeneinander montiert). Kamera über den vorhandenen `cam=x,y,z,yaw,pitch`-Parameter.
  Danach an der `row-day`-Position 5 s lang `requestAnimationFrame`-Abstände messen und `FRAME_MS avg=… p95=…` ausgeben.
  Mit `--frame-only` als drittem Argument: keine Bilder, nur die Messung (für den Vergleich mit dem alten Stand).

- [ ] **Step 1:** Skript schreiben. Vergleichswert holen, solange in `apps/client/public/world/` noch der alte Kleinwagen liegt (sonst die alten GLB aus `git show main:data/models/cars/kleinwagen/…` bauen lassen): Client-Code von `main` in einem Worktree starten, `npm run car-shots -- <url> /dev/null --frame-only` → `FRAME_MS` notieren.
- [ ] **Step 2:** `npm run dev`, dann `npm run car-shots -- <URL, die dev ausgibt> shots/cars/ingame`. Erwartet: sieben Bilder, eine `FRAME_MS`-Zeile.
- [ ] **Step 3:** Bilder ansehen. Abnahme: Innenraum tagsüber aus der Nähe erkennbar; Glas spiegelt/tönt, ohne milchig zu sein; kein Auto „verschwindet“ hinter dem Glas eines anderen; nachts sauber dunkel, Scheinwerfer und Rückleuchten leuchten wie zuvor; Regen vor/hinter Glas ohne Artefakte; im `lod-pair` kein auffälliger Sprung (sonst Glas-Tönung im Nahmodell erhöhen); alte Typen unverändert.
- [ ] **Step 4:** Bildrate: `avg` höchstens 10 % schlechter als der Vergleichswert. Sonst zuerst die Nahdistanz der Instanzen bzw. die Qualitätsstufe (`apps/client/src/quality.ts`) anpassen, nicht das Modell verarmen; Ergebnis und Maßnahme im PR nennen.
- [ ] **Step 5:** Commit `chore: car-shots check (in-game stills, frame time)` (+ Korrekturen).

---

### Task 7: Doku, PR, Freigabe durch den Nutzer

**Files:**
- Modify: `data/models/cars/README.md`

- [ ] **Step 1:** README: neue Module (`carbody.py`, `carinterior.py`; `carparts.py` = alte Typen bis Stufe 2), neue Knoten/Materialien (Tabelle aus dem Spec), neue Review-Bilder, `npm run ship-cars`, `npm run car-shots`, Verweis auf `CAR_SEATS` als Quelle der Sitzmaße.
- [ ] **Step 2:** `npm test && npm run typecheck` → grün.
- [ ] **Step 3:** Commit, Push, PR `feat(cars): rebuilt kleinwagen – interior, clear glass, doors (stage 1)` gegen `main`; im Text: was neu ist, `CAR_REPORT`-Zahlen (Dreiecke nah/fern, Dateigrößen), `FRAME_MS` vorher/nachher.
- [ ] **Step 4:** Dem Nutzer zeigen: `shots/cars/kleinwagen-{grid,open,seated,cut}.png` und `shots/cars/ingame/{near-day,side-day,near-night,row-day}.png`, dazu alt/neu nebeneinander. **Hier anhalten:** Die Stufen 2–4 beginnen erst nach seinem Okay bzw. seinen Korrekturen (Spec, „Ansätze“).

## Abweichung vom Spec

- „Bilder … mit sitzender Figur“ (Spec, Ansätze): In Stufe 1 sitzt eine **Prüfpuppe** in den Blender-Bildern; die echte Spielfigur im Auto kommt mit Stufe 3. Die Bilder aus dem Spiel zeigen in Stufe 1 das Auto leer.
