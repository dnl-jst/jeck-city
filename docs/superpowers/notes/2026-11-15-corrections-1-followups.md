# Korrekturrunde 1 – offene Punkte und Entscheidungen

Stand: Abschluss Korrekturrunde 1 (2026-11-15), aus dem Ausführungs-Ledger übernommen.

## Später
- Zweibahnige Abzweige (zweistreifige Straße teilt sich in zwei Einbahn-Fahrbahnen, z. B. Neusser 297011920, Krefelder 967261194): Bordstein passt am Teilungsknoten nicht exakt.
- Unterdeckung Gehweg ≈ 3.4–4.5 % (Lücken > 4 m mit Hinterhaus ≤ 10 m); Rest-Überdeckung durch 1.5-m-Mindestgehweg an sehr nahen Fassaden.
- St.-Marien-Modell ragt im Westen bis 4.2 m über den LoD2-Grundriss; Gehweg folgt dem LoD2-Grundriss.
- Baumkronen können auf schmalen Gehwegen in Fassaden ragen; Bäume, Laternen, Haltestellen ohne Kollision.
- Pipeline-Laufzeit: facadeDistance ist O(Gebäude × Dreiecke) je Stützpunkt.

## Aufgeschobene Kleinigkeiten (Reviews)
- Task 1: complete (commits 71184c6..c0cc1b5, review clean). Minor → carried into Task 2: endpoint sidewalk flare at junction vertices (sidewalkwidth.ts median3 endpoints). Minor (deferred): 8 vs 2.5 transition; dual-carriageway+junction interaction untested; parking area may count for two ways; lamps ALTERNATE_WIDTH uses new widths.
- Task 2: complete (commits c0cc1b5..f5a90e5, review clean). Carried into Task 3: centre line solid/none with ≥2 lanes/direction; bike pictogram direction on oneway cycleway:left. Minor (deferred): cycle lane <0.37 m guard; markings-vs-parking test; skewed junction tests; fromNeighbours by index; wear speckle pixelated; Wilhelmplatz side 8 m verify.
- Task 3: complete (commits 4df638a..b372673, review clean). Minor (deferred): drive-check stall → opaque 15-min timeout; until double snapshot; away(30) catch; looser junction test threshold; spawn real-manifest test skipIf; one-sided strip → other side no kerb parking; spawnCarSpot no junction clearance.
- Task 3b: review Needs fixes (3 Important: centre-line jumps at lane-count changes (13 plain splits), sidewalk gap at ramp ends, collision test can't fail). Fix round 1 sent. Minor (deferred): short ways clip ramps <6 m; wider-kerb run-out approximation; dual-carriageway detection symmetric; 3+ same-name ways non-mutual next.
- Task 4: review Needs fixes (gable windows above cornice). Fix round 1 sent (+ culling invariant). Minor (deferred): lamp/track/ramp skip tests for trees; shop eave <4 m; GLSL/TS parity test; crowns clip facades on narrow sidewalks.

## Entscheidungen des Controllers (Rulings)
- Pre-flight: T1→T2 (cross/sidewalk widths → markings), T1→T3 (cross.park* → parking), T2/T3 both touch main.ts/chunks (sequential, OK), T4 independent client + placements. No conflicts. Ruling: drive-check timeouts in sim steps (fixes known flake).
- Task 1: DONE_WITH_CONCERNS f8cc373 (Neusser carriageway 9.7 m because parking:both=separate). Ruling: separate counts as strip if adjacent amenity=parking street_side/lane/layby area within 8 m (width from area depth or orientation default) — matches user photo (parking lane on asphalt) — cost if wrong: strip too wide where areas are off-street. Accepted: parking=yes→street_side; width raised to lanes; dynamic junction gap. Pre-review fix sent.
- Task 3: DONE_WITH_CONCERNS b372673 (399 cars, nearest-400 cap → cars only within ~350 m; spawn car 2.30 m). Ruling: cap 400 was a plan defect → raise to 2600 so 70 % occupancy holds everywhere (instanced render, physics only ≤150 m) — carried into 3b — cost: manifest grows ~150 KB. Review Task 3 + dispatch 3b in parallel.
- Task 3b: DONE_WITH_CONCERNS 1df0c8b (markings continuous at user spot; 2600 cars; triangles at spawn 0.85M→3.3M). Ruling: 55 % strip occupancy accepted; kerb parking stays 40 %. Ruling: parked-car instance distance culling (≤250 m, rebuilt on 20 m move) added to Task 4 — cost: far cars pop in. Review dispatched.
- Task 3b: fix round 1 implemented a95f287 (centre jumps 28→0; sidewalk reaches facade; collision test fails without ramps). Ruling: two-way → dual-carriageway split nodes (Neusser 297011920, Krefelder 967261194) deferred to a later round — cost: kerb mismatch at a few dual-carriageway starts. Re-review dispatched.
