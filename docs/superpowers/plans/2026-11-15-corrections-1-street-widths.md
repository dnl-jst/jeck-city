# Nippes Nights – Korrekturrunde 1: Straßenbreiten & Maßstab

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Straßen bekommen ihre echte Breite (Fahrspuren + Radstreifen + Parkstreifen), Gehwege reichen bis zur Hausfassade, Markierungen und Parkstreifen sind sichtbar, Gründerzeit-Geschosse sind realistisch hoch – sodass die Neusser Straße am Spawn so wirkt wie auf dem Referenzfoto des Nutzers.

**Auslöser (Nutzer, 2026-11-15):** „Die Straßen sind sehr schmal, in echt sind da 2 Fahrspuren und auf beiden Seiten ein Radweg.“ Referenzfoto Spawn Richtung Norden: 2 Fahrspuren mit gestrichelter Leitlinie, Radstreifen beidseitig (gestrichelt, rot an Einmündungen), Parkstreifen links mit Autos, breite Gehwege mit Straßenbäumen; Figur wirkt zu groß.

**Ursache:** `packages/pipeline/src/osm.ts` setzt die Breite = `width`-Tag, sonst `lanes × 3.25`, sonst nach Klasse; `cycleway*`- und `parking*`-Tags werden ignoriert. Gehweg fest 2.5 m (`streets.ts`), Rest bis Fassade ist „Hof“. Fassaden-Shader: Geschoss 3.2 m, EG 4.2 m – zu niedrig für Gründerzeit.

**Spec:** `docs/superpowers/specs/2026-11-15-nippes-nights-design.md` (unverändert gültig). Offene Punkte aus Plan 1: `docs/superpowers/notes/2026-11-15-plan-1-followups.md`.

## Global Constraints

- Nur offene Daten (OSM + NRW LoD2). Das Referenzfoto (Street View) dient nur als Maßstabsreferenz, nie als Asset.
- Heading-Konvention: vorwärts = (sin h, cos h) in x/z. Welt: x Ost, y oben, z Süd.
- Physik/Kollision bleibt server-tauglich (packages/shared DOM-frei, deterministisch); Kollisionsformat NNC2 bleibt.
- Pipeline deterministisch; erzeugte Assets werden committet; Weltgröße bleibt unter 25 MB.
- Spawn auf dem Gehweg der Neusser Straße nahe Wilhelmplatz; ein geparktes Auto (Manifest-Index 0) muss vom Spawn aus mit E erreichbar sein (Mittelpunktabstand ≤ 2.7 m, Test auf dem echten Manifest).
- `npm test`, `npm run typecheck`, `npm run drive-check` grün; drive-check wählt das Auto über Nähe zum Spawn, nicht über feste Koordinaten/Index.

## Review Focus

1. Zweibahnige Straßen (zwei `oneway`-Wege nebeneinander, z. B. Teile der Neusser Straße/Gürtel): Breiten dürfen sich nicht überlappen oder einen Gehweg in die Mitte legen → Test in Task 1.
2. Gehweg bis Fassade: Strahl darf nicht durch Lücken/Einfahrten 30 m in einen Hof schießen (Deckel 8 m) → Test in Task 1.
3. Kreuzungen: breitere Bänder dürfen keine Bordsteine/Parkstreifen quer über Einmündungen legen → Test in Task 1/2.
4. Spawn/Spawn-Auto nach Verbreiterung: Auto erreichbar, Spieler nicht im Auto, Auto nicht auf dem Gehweg → Test in Task 3.
5. Markierungen flimmern nicht (z-fighting) und liegen nicht auf Gehwegen → Screenshot-Prüfung in Task 2.

---

### Task 1: Straßenquerschnitt aus OSM-Tags, Gehweg bis Fassade

**Files:** Modify `packages/pipeline/src/osm.ts`, `packages/pipeline/src/streets.ts`; Create `packages/pipeline/src/crosssection.ts`, `packages/pipeline/src/sidewalkwidth.ts`; Tests daneben; Fixture-Erweiterung `packages/pipeline/fixtures/osm-small.json`.

**Interfaces:**
- Produces:
  - `type CrossSection = { lanesForward: number; lanesBackward: number; laneWidth: number; cycleLeft: number; cycleRight: number; parkLeft: number; parkRight: number; parkLeftOrientation: 'parallel'|'diagonal'|'perpendicular'|null; parkRightOrientation: …; carriageway: number /* Summe = Bordstein-zu-Bordstein */ }` (links/rechts relativ zur Wegrichtung).
  - `crossSectionFromTags(tags: Record<string,string>, kind: string): CrossSection` – Regeln:
    - Spurbreite 3.25 m (residential/living_street 3.0 m); Spuren aus `lanes`, `lanes:forward/backward`, sonst 2 (oneway 1).
    - Radstreifen 1.6 m je Seite, wenn `cycleway`, `cycleway:both`, `cycleway:left/right` = `lane` (oder `cycleway:*:lane` gesetzt); `track`/`separate`/`no` → 0 auf der Fahrbahn. `cycleway=opposite_lane` → 1.6 auf der Gegenseite.
    - Parkstreifen je Seite aus `parking:both|left|right` (`lane`, `street_side`, `on_kerb`→0, `half_on_kerb`→1.0, `separate`/`no`→0) und Legacy `parking:lane:both|left|right` (`parallel`, `diagonal`, `perpendicular`); Breite parallel 2.0 m, diagonal 4.5 m, senkrecht 5.0 m; Ausrichtung aus `parking:*:orientation`.
    - `width`-Tag hat Vorrang für `carriageway` (Komponenten proportional skalieren, mindestens Fahrspuren).
  - `Road` erhält `cross: CrossSection`; `Road.width` = `cross.carriageway`.
  - `sidewalkWidths(road, buildings, opts): { left: number[]; right: number[] }` – je Stützpunkt Abstand Bordstein → nächste Gebäudefassade senkrecht zur Straße (Strahl gegen Grundrisse), geklemmt auf [1.5, 8] m; kein Gebäude innerhalb 10 m → 2.5 m; über Stützpunkte geglättet (Median über 3).
- Zweibahnige Straßen: zwei `oneway`-Wege gleicher `name`, parallel (Richtung ±180°, Abstand < Summe der halben Breiten + 6 m) → die Innenseiten bekommen keinen Gehweg/Bordstein, sondern einen Mittelstreifen (Grünfläche) zwischen den Fahrbahnen.
- `streets.ts`: Fahrbahnband = `carriageway`; Bordstein an dessen Rand; Gehweg mit variabler Breite aus `sidewalkWidths`; Gehweg-Band endet an Kreuzungen wie bisher.

- [ ] **Step 1: Failing tests** – Neusser-Straße-artige Tags (`lanes=2`, `cycleway:both=lane`, `parking:left=lane`, `parking:left:orientation=parallel`) → carriageway = 2×3.25 + 2×1.6 + 2.0 = 11.7; `cycleway=track` → kein Radstreifen auf der Fahrbahn; Legacy `parking:lane:both=diagonal` → je 4.5; `width=14` skaliert; Gehweg-Strahl: Fassade 4 m hinter Bordstein → 4.0; Lücke ohne Gebäude in 10 m → 2.5; Hof 30 m tief → 8 (Deckel); zweibahnige Fixture → kein Gehweg zwischen den Fahrbahnen; keine Bordstein-Vertices innerhalb 5 m vom Kreuzungsknoten (wie bisher).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Auf echten Daten berichten: carriageway der Neusser Straße am Spawn (erwartet ≈ 11–14 m), Abstand Fassade–Fassade dort (aus LoD2) vs. carriageway + Gehwege.
- [ ] **Step 5:** Commit `feat(pipeline): street cross-sections from OSM tags, sidewalks to the building line`.

### Task 2: Markierungen, Radstreifen, Parkstreifen sichtbar

**Files:** Modify `packages/pipeline/src/streets.ts` (+ neues `markings.ts`), `packages/pipeline/src/chunks.ts` (neues Mesh `markings` im Chunk-GLB, Parkstreifen-Fläche `parking`), `apps/client/src/materials/street.ts`, `apps/client/src/loader.ts`; Tests.

**Interfaces:**
- Chunk-GLB bekommt zusätzlich die Meshes `markings` (POSITION, TEXCOORD_0, Attribut `_MARK` scalar: 0 weiß, 1 rot-Radweg) und `parking` (Parkstreifenfläche); beide optional.
- Markierungen (weiß, 0.12 m breit, y = Fahrbahn + 0.004): Leitlinie gestrichelt 3 m Strich/6 m Lücke zwischen den Richtungen bei zweistreifigen Straßen; Fahrstreifenbegrenzung gestrichelt bei ≥2 Spuren je Richtung; Radstreifen-Begrenzung durchgezogen (Breitstrich 0.25 m), unterbrochen 1 m/1 m im Kreuzungsbereich; Fahrrad-Piktogramm alle 40 m auf dem Radstreifen (aus Primitiven/Linien); Radstreifen im Kreuzungsbereich (≤ 12 m vom Knoten) rot eingefärbt (`_MARK`=1, Fläche statt Linie).
- Parkstreifen: eigene Fläche, Asphalt minimal heller als Fahrbahn mit Pflaster-Randstreifen (Shader aus uv).
- Client: Material für `markings` (weiß/rot, leicht abgenutzt per Noise, nachts nur über Laternen beleuchtet) mit polygonOffset/renderOrder über der Fahrbahn und unter Gleisen.

- [ ] **Step 1: Failing tests** – Leitlinien-Strichmuster (Anzahl Striche auf 90 m = 10), kein Markierungs-Vertex außerhalb der Fahrbahn, kein Strich innerhalb 5 m von Kreuzungsknoten (außer rot), Piktogramm-Abstand 40 m, rote Fläche nur ≤ 12 m vom Knoten.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; `npm run pipeline`; Screenshots `shots/c1-spawn-day.png` (Spawn, Blick Norden, wie Referenzfoto) und `shots/c1-spawn-night.png`, ansehen, iterieren.
- [ ] **Step 5:** Commit `feat: lane markings, cycle lanes and parking strips`.

### Task 3: Parken im Parkstreifen, Spawn & Spawn-Auto neu, drive-check robust

**Files:** Modify `packages/pipeline/src/parking.ts`, `packages/pipeline/src/spawn.ts`, `packages/pipeline/src/main.ts`, `scripts/drive-check.mjs`; Tests.

**Interfaces / Regeln:**
- Parkplätze: Wo `cross.parkLeft/Right > 0`: Autos mittig im Parkstreifen, Ausrichtung nach `orientation` (parallel = längs, diagonal 45°, senkrecht 90°), Abstand parallel 5.8 m, diagonal 3.2 m, senkrecht 2.6 m, Belegung 70 %. Ohne Parkstreifen-Tags wie bisher am Fahrbahnrand (40 %), aber nicht auf Radstreifen. Weiterhin: innerhalb Grenze (3 m), nicht in Grundrissen, nicht an Kreuzungen/Haltestellen/Gleisen; Gesamtobergrenze 400.
- Spawn: auf dem Gehweg der Neusser Straße nahe Wilhelmplatz, 1.0 m vom Bordstein; bevorzugt die Seite mit Parkstreifen; Blick nach Norden entlang der Straße.
- Spawn-Auto (Manifest-Index 0): im Parkstreifen (bzw. am Fahrbahnrand) neben dem Spawn, Mittelpunkt ≤ 2.7 m vom Spawn, Kontur ≥ 0.8 m vom Spieler, Fahrtrichtung der Seite.
- drive-check: nimmt das dem Spawn nächstgelegene Auto, steigt vom Spawn aus ein (ohne `?cam`), fährt, hält, steigt aus; Wartezeit-Timeouts in Simulationsschritten statt Wanduhr (Flake unter Last beheben).

- [ ] **Step 1: Failing tests** – Fixture-Straße mit `parking:left=lane` → Autos im Parkstreifen (Abstand zur Fahrbahnachse = carriageway/2 − 1.0 ± 0.1), Abstände 5.8 m; diagonale Ausrichtung; **echtes Manifest**: `parked[0]` ≤ 2.7 m vom Spawn, kein Auto innerhalb 1.5 m vom Spawnpunkt, Spawn liegt auf Gehweg (nicht in Fahrbahn/Gebäude).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `npm run pipeline`.
- [ ] **Step 4:** Run → PASS; `npm run drive-check` 2× hintereinander grün.
- [ ] **Step 5:** Commit `feat: parking strips, re-placed spawn and spawn car, robust drive-check`.

### Task 4: Gründerzeit-Geschosshöhen, Straßenbäume, Kamera

**Files:** Modify `apps/client/src/materials/facade.ts`, `apps/client/src/camera.ts`, `packages/pipeline/src/placements.ts` (oder neues `streettrees.ts`); Tests.

**Regeln:**
- Fassade: Obergeschosse 3.7 m (je Gebäude per Seed 3.5–3.9 m), EG 4.5 m (Ladenzeile 4.6 m); Fensterhöhe 1.9 m, Brüstung 0.9 m; Geschossanzahl = floor((Höhe − EG) / Geschosshöhe), Restfläche unter der Traufe als Attika/Gesims, keine abgeschnittenen Fensterreihen.
- Straßenbäume: entlang `DRIVABLE`-Straßen mit Gehweg ≥ 3.5 m alle 14 m (± 2 m Seed) auf dem Gehweg 1.2 m vom Bordstein, nur wo OSM keinen Baum innerhalb 8 m hat; nicht vor Ladeneingängen (Gebäude mit Bit 0: Abstand zum Schaufenster-Gebäude ≥ 2.5 m reicht), nicht an Kreuzungen (8 m), nicht an Haltestellen, nicht auf Spawn (4 m).
- Kamera zu Fuß: 5.0 m hinter, 2.3 m über Boden; Sichtfeld 60°.

- [ ] **Step 1: Failing tests** – reine Funktion für Geschossaufteilung (Höhe 17 m → EG 4.5 + 3 Geschosse à ~3.7 + Rest als Gesims; keine Fensterreihe ragt über die Traufe); Straßenbaum-Generator auf Fixture (Abstand 14 ± 2, Skip-Regeln).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement; `npm run pipeline`.
- [ ] **Step 4:** Run → PASS; Screenshots `shots/c1-final-day.png`, `shots/c1-final-night.png` am Spawn (Blick Norden) ansehen.
- [ ] **Step 5:** Commit `feat: realistic storey heights, street trees, camera`.
