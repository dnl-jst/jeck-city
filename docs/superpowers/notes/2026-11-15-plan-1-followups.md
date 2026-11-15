# Plan 1 – offene Punkte und Entscheidungen

Stand: Abschluss Plan 1 (2026-11-15). Aus dem Ausführungs-Ledger übernommen, damit es die Löschung des Arbeitsverzeichnisses überlebt.

## Vor Plan 2 erledigt (finale Fix-Welle)
- Fester dt in applyInput, Character.dispose, NaN-Guard im FixedStepper, degenerierte Kollisionsdreiecke werden verworfen.

## Für Plan 2 beachten
- Determinismus nur bei gleicher Erzeugungsreihenfolge; rapier3d-compat ist nicht der -deterministic-Build; Math.sin/cos können zwischen V8 und JSC im letzten Bit abweichen → Reconciliation nötig.
- Auto bleibt beim Aufprall auf eine Person stehen (kinematische Figur) – v1-Einschränkung.
- Dev-Hooks (?cam, ?time, ?date, window.__nn*) sind ohne ?debug=1 aktiv – ?cam vor Mehrspieler sperren.

## Für die Korrekturrunde
- Straßenbreiten aus allen OSM-Tags (Rad-/Parkstreifen), Gehweg bis Gebäudeflucht, Markierungen, Straßenbäume; Spawn + Spawn-Auto danach neu platzieren (Einstiegsabstand ≤ 3 m mit Test auf echtem Manifest).
- Geschosshöhen Gründerzeit (≈3.6–4 m, EG ≈4.5 m), Kamera etwas höher/weiter.
- drive-check: Auto per Nähe statt Index; 'car did not stop'-Timeout unter Last flaky.
- Laternen, Bäume, Haltestellen ohne Kollision.
- U-Bahn-Eingänge (OSM subway_entrance) sichtbar machen.

## Aufgeschobene Kleinigkeiten (aus Reviews)
- Task 1: complete (commits 9c024a1..9263a74, review clean). Parked minor: root typecheck script omits packages/pipeline → hand to Task 3.
- Task 2: complete (commits 9263a74..f8969bd, review clean). Minor parked: ORIGIN_UTM 'as const' readonly literals; localToWgs84 only round-trip tested.
- Task 3: complete (commits f8969bd..248af93, review clean). Minor parked: thrown network errors not retried; east bbox edge 3 m short.
- Task 4: complete (commits 248af93..563a95c, review clean). Minor parked: interior-ring/part-precedence tests missing; smoke test skips silently.
- Task 5: minor (deferred): Math.min spread on large arrays; u origin = outer[0]; tests lack no-ground and multi-part fixtures.
- Task 5: minor (deferred): internal walls (both sides inside own footprint, ~6% of wall tris) could be dropped in Task 7 to save triangles.
- Task 5: minor (deferred): surface centre averages incl. closing point.
- Task 6: minor (deferred): stop-edge test doesn't assert which track; weak track-clearance test; 0.5 mm y-step needs polygonOffset in client (→ Task 8); boundary [] silently if ring open; fixture.ts in src.
- Task 6: minor (deferred): bus_stop rule lacks dedicated fixture; T-junction test seed-dependent.
- Task 7: minor (deferred): overrides 'in' prototype keys/no validation; spawn silent fallback; no real-scale collision test; _KIND/_FLAGS values not compared after roundtrip; 200 m prefilter in placements.
- Task 8: minor (deferred): BED_Y fixed 0.016 (flat terrain so OK); platform/sidewalk ribbons overlap tracks at stops (data).
- Task 9: minor (deferred): castShadow toggle at sunrise/sunset → program rebuild hitch (keep true, fade intensity); DST test weak (no values, host-zone Date); moodAt allocates Colors per frame; props castShadow/frustumCulled=false; placeShelter fallback untested.
- Task 9b: complete (commits 1863736..bd5939e, review clean). ⚠️ overlay vs loading screen z-order: resolved as acceptable (debug tool). Minor (deferred): fps calc not gated; Cmd+P triggers copy; yaw wrap tests.
- Task 10: minor (deferred): T-junctions from per-triangle split (float-level); no Character.dispose (Plan 2 needs); determinism only same-order/non-deterministic build (Plan 2 note); FixedStepper no NaN guard; dt param vs fixed timestep; literals 9.81/±1/maxSteps outside TUNING; car spawn assumes y=0; internal exports public.
- Task 11: follow-up re-review clean. Task 11: complete (commits bfa106b..529e7c1). Minor (deferred): borderline near-translations (Café Gäätche, Locker Levve, Levve-Apotheke, Alles Billich Süd) — user-approved; atlas packer/MIN_DIST untested.
- Task 12b: complete (commits c00097a..88aa2a8, review clean). Minor (deferred): guard failure path untested; no dedupe check; drive-check hard-codes car index; 2 cars face walls.
- Task 12c: complete (commits 88aa2a8..0d21a34, review clean). Ruling: enter margin only 0.14 m and spawn-car lateral offset grows with road width → corrections round (street widening) must re-place spawn on/near the parking lane or keep car ≤3 m (test on real manifest) — cost if wrong: car not enterable from spawn after widening. Minor (deferred): north assumption vs spawn.heading; 301 > MAX_SPOTS.

## Entscheidungen des Controllers (Rulings)
- Ruling: work on branch in main checkout, no separate worktree — user wants a live dev server at a stable path; repo is brand new — cost if wrong: none, branch isolates main.
- | T1 self | git init in step 1 | Already done by controller (9c024a1). Ruling: skip step 1. |
- | T5→T7 | flags bit1 "set in Task 8" | Plan text says Task 8, but Task 7 sets it. Ruling: Task 7 sets bit1. Cost: none. |
- | T8→T12 | hud.ts/loader.ts; FetchError/NoWebGLError location unspecified | Ruling: define both in apps/client/src/errors.ts. Cost: trivial. |
- Task 5: dispatched (BASE 563a95c, implementer a53858ddbf295133f, sonnet). Rulings: centroid=mean ground verts; kind only 0/1 in output.
- Task 5: Ruling: plan-mandated centroid wall orientation → replaced by footprint probe (per wall surface: Newell normal in local space, probe 0.3 m horizontally from surface centre; inside own building's ground-polygon union → flip; fallback centroid test if no ground surface) — spec anti-goal 'Klötzchen/unrecognisable' outranks plan text; measured 13–19% inward walls — cost if wrong: one more fix round.
- Task 6: dispatched (BASE bb0a0ee, implementer af9adb404a9eb07d7, sonnet). Rulings: boundary from outer members; area=yes/place=square/pedestrian → squares; sidewalks/kerbs only on drivable roads; parking both sides two-way, right side oneway; y-offset per class ≤5 mm; uv metres.
- Task 6: implementer DONE_WITH_CONCERNS c2ab568. Ruling: Köln Stadtbahn = railway=light_rail → add to fetch + parse as tramTracks; rail (DB) out of scope v1; stops deduped by name within 60 m — cost if wrong: tram missing on Neusser Str. Pre-review fix sent to implementer.
- Task 6: pre-review fix bcf49c3 (light_rail: 10 surface tracks, 12 stops, 3 surface-attached). Ruling: tunnel tracks/stops stay excluded in v1 (underground in reality, nothing visible at street level); Task 7 must put only surface (graph-attached) stops into manifest.tramStops — cost if wrong: missing U-Bahn entrances, addable later.
- Task 7: dispatched (BASE 4ae424b, implementer a4b1564e97c16b92b, opus). Rulings: bit1 here; tramStops = graph.stops; drop internal walls; 8-colour palette; shop placeholder=type + buildingId; spawn name 'Neusser Straße'; GLB layout (7 named meshes, _FACADEUV/_KIND/_SEED/_FLAGS, world-space positions, meshopt); collision incl. ground rect; 25 MB budget; overrides removal path; --skip-fetch.
- Task 7: implementer DONE_WITH_CONCERNS 6c3ae01 (17.2 MB). Ruling: spawn <80 m bound is a plan defect (Neusser Straße centreline is 129 m from Wilhelmplatz centre); accept nearest-point spawn at 133.6 m, bound for real data relaxed to <200 m — cost: none. Ruling: accept stricter internal-wall rule (avoids holes above lower parts).
- Task 8: dispatched (BASE 6c3ae01, implementer aac6a86df8d191360, opus). Rulings: errors.ts now; placeholder lighting + nightFactor uniform + ?night=1; free-fly camera; facade quality bar; procedural street materials; playwright devDep + npm run screenshot, shots/ dir — cost: ~150 MB chromium download in user cache.
- Task 9: dispatched (BASE 371e962, opus). Rulings: suncalc in shared; ?night→?time + ?date; real TZ test via separate vitest project if stubEnv fails; shadows 150 m/2048/PCFSoft; 8-lamp PointLight pool reassigned >10 m; instanced lamps/trees; stop shelters with CanvasTexture sign; 4 shots.
- Task 9: implementer DONE_WITH_CONCERNS 1e39553. .nvmrc committed 5c89eea + pushed (branch incl. 1e39553). Ruling: generate lamps every 28 m on drivable roads (OSM has 0 lamps within 100 m of spawn) + tram stop heading/shelter offset in manifest — pre-review fix sent. PCFSoft→PCF radius 2 accepted (three 0.187 removed PCFSoft).
- Task 10: dispatched (BASE bd5939e, implementer a427c4f3fa616a330, opus). Rulings: rapier3d-compat pin w/ vehicle controller; memoised init; dt 1/60 no wall-clock; boundary cuboids; KCC params; speed-sensitive steering; setOccupied/dispose, sleeping parked cars; real collision.bin smoke test; step benchmark.
- Task 10: implementer DONE_WITH_CONCERNS 4f244c1 (rapier 0.21.0; step 0.55 ms). Ruling: split long triangles accepted; sidewalk (and raised squares) must be in collision → pipeline change + regenerate (pre-review fix); add Character.teleport; car-vs-person stop accepted for v1 (Plan 2 note).
- Task 11: dispatched (BASE bfa106b, opus). Rulings: player default, F fly in debug; ?cam spawns player; physics loaded in loading screen; instanced parked cars + Vehicles within 150 m (dispose >200 m), pushed pose kept; camera smoothing + physics raycast; pointer lock hint; input modifiers/blur; shop names: generic now, curated → data/shop-names.proposed.json for user approval, shop-names.json = {}; signs via CanvasTexture; screenshots; scripted drive.
- Task 11: USER: jump on Space is wanted (keep). USER approved shop-name proposals; Ruling: neutralise allusions on personal names of small owner-run shops (e.g. Rahmati, Slowik, Rosinski, Kemp, Dahmen, Raab, Wilden, Berghaus-Prang, Schlömer, Zimmermann, Steinbach, Dorff, Sedat, Ugur, Karadag, Lena, Anny) → neutral type-based Kölsch names; founder-named chains (Rossmann, Fielmann, Deichmann, McDonald's, Merzenich, Kamps, Köttgen) stay. Apply to data/shop-names.json together with review fixes.
- Task 12: dispatched (BASE 529e7c1, sonnet). Rulings: perf overlay = existing 9b overlay; WebGL2 check first; progress + controls hint; build+preview :4173 time-to-ready unthrottled + Fast 4G, reduce initial radius if >10 s; npm run accept.
- Task 12: Ruling: Fast-4G acceptance is a measurement, not a code defect; this machine is loaded (15–85) by external processes. Route to user: run 'npm run accept' on a quiet Mac (script exits 1 on ≥10 s). If it fails, next lever = render-before-physics. — cost if wrong: one more task after user measurement.
- Task 12c: complete (commits 88aa2a8..0d21a34, review clean). Ruling: enter margin only 0.14 m and spawn-car lateral offset grows with road width → corrections round (street widening) must re-place spawn on/near the parking lane or keep car ≤3 m (test on real manifest) — cost if wrong: car not enterable from spawn after widening. Minor (deferred): north assumption vs spawn.heading; 301 > MAX_SPOTS.
