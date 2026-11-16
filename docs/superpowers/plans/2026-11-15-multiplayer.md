# Mehrspieler (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Alle Besucher sind gleichzeitig in Nippes: Name eingeben, auf der Neusser Straße spawnen, andere zu Fuß und im Auto sehen, mit ihnen zusammenstoßen. Ein Colyseus-Server ist Schiedsrichter, die eigene Figur und das eigene Auto reagieren trotzdem sofort.

**Architecture:** Die Simulation wandert aus `apps/client/src/game.ts` in eine DOM-freie `WorldSim` in `@nn/shared/sim`. Der Server (`apps/server`, Colyseus 0.18) führt sie autoritativ mit 60 Hz aus. Der Client führt eine zweite `WorldSim` als Vorhersage-Welt: Die eigene Entität ist dynamisch und wird mit dem Server abgeglichen, fremde Entitäten sind kinematische Stellvertreter auf interpolierten Snapshot-Posen. Schneller Zustand läuft als eigenes Binärformat (`@nn/shared/net`), langsamer Zustand als Colyseus-Schema.

**Tech Stack:** TypeScript 7, Rapier 0.21.0 (bestehend), Colyseus 0.18 (`colyseus`, `@colyseus/schema` 5, `@colyseus/sdk`), Node 24, tsx (Laufzeit des Servers), Vite 8, Three.js 0.187, vitest, Playwright, Docker, Caddy.

**Spec:** `docs/superpowers/specs/2026-11-15-multiplayer-design.md`. Vor Task 1 außerdem lesen: Abschnitt „Mehrspieler (Version 1)“ in `docs/superpowers/specs/2026-11-15-nippes-nights-design.md`, „Für Plan 2 beachten“ in `docs/superpowers/notes/2026-11-15-plan-1-followups.md`, `docs/superpowers/specs/2026-11-15-terrain-dgm1-design.md`.

**Stand:** Basis `main` @ `6385f66`. Das Gelände (DGM1) ist gelandet, damit ist Spec-Frage 0 erledigt: Es wird auf dem Gelände-Stand gebaut. `createPhysicsWorld(collision, terrain)` baut das Heightfield; `heightAt`/`terrainNormal` liefern Bodenhöhe und Neigung; `StreetProps` und `parkedPose` nutzen sie schon. Server und Client bauen die Welt aus denselben Dateien `manifest.json`, `collision.bin` und `terrain.bin`.

**Welt-Assets im Worktree:** `apps/client/public/world/` ist nicht versioniert. Vor Tests mit echten Assets verlinken: `ln -s /home/dj/projects/nippes-nights/apps/client/public/world apps/client/public/world`. Gibt es den Ordner dort nicht, `npm run pipeline` ausführen.

## Global Constraints

- Node 24. Colyseus-Pakete exakt pinnen, ohne `^`: Version per `npm view <pkg> version` zum Installationszeitpunkt bestimmen; Stand beim Planen `colyseus 0.18.12`, `@colyseus/schema 5.0.48`, `@colyseus/sdk 0.18.10`. Keine weiteren neuen Laufzeit-Abhängigkeiten außer diesen und `tsx` (schon gepinnt, `4.23.15`) für den Server.
- Rapier bleibt genau `0.21.0` und es gibt genau eine Kopie (`initRapier`-Versionsprüfung).
- Kein Cloudflare, kein Next.js. Ein Raum namens `nippes`.
- Takt: Simulation 60 Hz (`TUNING.world.dt`, unverändert), Snapshots 20 Hz (jeder 3. Tick), Client-Eingaben 60 Hz, bis zu 3 pro Paket.
- `@nn/shared/sim` und `@nn/shared/net`: kein Three.js, kein DOM, kein `Math.random`, kein `Date`/`performance.now`. Zufall nur über einen geseedeten PRNG, Zeit nur als Tick-Zähler.
- Konstanten in `@nn/shared/net/constants.ts`, genau diese Namen und Werte: `PROTOCOL_VERSION = 1`, `TICK_HZ = 60`, `SNAPSHOT_EVERY = 3`, `MAX_INPUTS_PER_PACKET = 3`, `MAX_PLAYERS = 60` (Nachtrag 2026-11-16, vorher 100), `INTEREST_RADIUS = 250`, `INTEREST_RELEASE = 270`, `RECONNECT_S = 15`, `JOIN_PER_IP_PER_MIN = 5`, `MAX_INPUTS_PER_S = 90`, `MAX_MESSAGE_BYTES = 512`, `KNOCKDOWN_KMH = 8`, `KNOCKDOWN_S = 1.0`, `ENTER_MAX_DIST = 3`, `RESET_AFTER_S = 600`, `RESET_CLEAR_RADIUS = 100`, `SPAWN_STEP = 1.5`, `SPAWN_MAX_DIST = 60`, `INTERP_DELAY_S = 0.1`, `EXTRAPOLATE_MAX_S = 0.15`, `HARD_SNAP_M = 2`, `MAX_REPLAY_STEPS = 60`, `CORRECTION_BLEND_S = 0.1`, `REMOTE_ENGINE_VOICES = 6`, `REMOTE_RADIO_RADIUS = 25`, `REMOTE_RADIO_LOWPASS_HZ = 800`, `REMOTE_RADIO_GAIN_DB = -18`, `RETRY_CONNECT_S = 10`.
- Server-Eingabewarteschlange (`apps/server/src/inputs.ts`): hält höchstens 30 Eingaben (`QUEUE_MAX = 30`, 0,5 s), Token-Bucket mit Burst 30 (`INPUT_BURST`); die Dauerrate bleibt `MAX_INPUTS_PER_S`. Läuft die Warteschlange leer, werden die kontinuierlichen Felder der letzten Eingabe (forward, right, run, brake, horn, yaw) höchstens 6 Ticks wiederholt (`REPEAT_MAX`, 100 ms; Pulse use/jump/bell nie), danach neutral.
- Namen: 2–20 Zeichen nach Trimmen und NFC-Normalisierung, erlaubt sind Unicode-Buchstaben, Ziffern, Leerzeichen und `-_.'`. Innere Leerzeichenfolgen werden zu einem zusammengefasst. Dubletten werden ohne Groß-/Kleinschreibung erkannt und bekommen ` 2`, ` 3` … angehängt („Jupp 2“). Der Server prüft verbindlich.
- Texte, exakt so:
  - Server nicht erreichbar: „Nippes ist gerade nicht erreichbar – versuch es später nochmal.“ (Neuversuch alle 10 s)
  - Raum voll: „Nippes ist gerade voll – versuch es gleich nochmal.“
  - Versionskonflikt: „Neue Version – bitte Seite neu laden.“
  - Name zu kurz oder zu lang: „Der Name muss 2–20 Zeichen lang sein.“
  - Unerlaubte Zeichen: „Erlaubt sind Buchstaben, Ziffern, Leerzeichen und - _ . '“
  - Schimpfwort: „Bitte such dir einen anderen Namen aus.“
  - Zu viele Beitritte: „Zu viele Versuche – warte kurz.“
  - Einsteigen abgelehnt, weil besetzt: „Das Auto ist besetzt“
  - Bestehende Texte („Erst anhalten“, „Hier kannst du nicht aussteigen“) bleiben unverändert.
- Zusammenstöße: Ein Auto schneller als 8 km/h trifft eine Person → Knockback in Fahrtrichtung plus etwas nach oben, Zustand `down` für 1.0 s ohne Eingabe, danach steht sie wieder auf. Das Auto verliert nur wenig Tempo. Unter 8 km/h schiebt das Auto die Person einfach weg. Keine Verletzungen, keine Punkte.
- Einsteigen nur ≤ 3 m entfernt und nur in ein freies Auto; bei gleichzeitigen Versuchen gewinnt, wer zuerst beim Server ankommt. Aussteigen bei < 2 m/s (`canGetOut`, `exitSpot` wie heute). Verlässt ein Fahrer das Spiel, bleibt das Auto mit Motor aus stehen.
- Rückstellung: Verschobene Autos ohne Fahrer und gefallene Laternen gehen nach 600 s ohne Nutzung zurück auf ihren Manifest-Platz, aber nur, wenn kein Spieler ≤ 100 m entfernt ist.
- Reconnect: Fenster 15 s. Figur bleibt stehen, Auto bleibt belegt, Eingabe ist neutral. Danach verschwindet die Figur und das Auto wird frei.
- Tag/Nacht bleibt lokal pro Besucher und wird nicht synchronisiert.
- Kein Offline-Fallback für Spieler. `?offline=1` (lokale `WorldSim` ohne Netz) gibt es nur mit `import.meta.env.DEV` oder `?debug=1`.
- Dev-Hooks im Mehrspieler: `?cam`, Flugmodus F und schreibende `window.__nn*`-Hooks nur, wenn der Server im Dev-Modus läuft (`NODE_ENV !== 'production'`, im Join-Ergebnis als `devMode` gemeldet). `?time`/`?date` bleiben immer erlaubt.
- Betrieb: ein Docker-Image auf einem Port; Umgebungsvariablen `PORT` (Standard 2567), `MAX_PLAYERS` (60; per Umgebung bis 100), `PUBLIC_URL`, `LOG_LEVEL` (`info`); `/healthz`. Logs enthalten keine Klartext-IP, sondern einen gesalzenen SHA-256-Präfix (8 Hex-Zeichen, Salz pro Prozessstart).
- Bestehende Checks bleiben grün: `npm test`, `npm run typecheck`, `npm run drive-check` (jetzt mit `?offline=1`). Die Einzelspieler-Qualität (Optik, Ton, Fahrgefühl) darf nicht schlechter werden.

## Review Focus

1. **Spieler trennt die Verbindung mitten in der Fahrt:** Der Server darf die zuletzt gehaltene Eingabe nicht weiter anwenden, sonst fährt das Auto führerlos mit Vollgas weiter. Fehlt für einen Tick die Eingabe, gilt eine neutrale Eingabe (kein Gas, keine Lenkung, Bremse aus, yaw beibehalten) und das Auto rollt aus. → Task 7, Test `missing input is neutral, not repeated`.
2. **Zwei Spieler drücken E im selben Tick am selben Auto:** Genau einer sitzt drin; der andere bleibt zu Fuß und sein Client zeigt „Das Auto ist besetzt“ und nimmt den vorhergesagten Einstieg zurück. → Task 3 (`same-tick enter: lower queue order wins`) und Task 10 (`denied enter is rolled back`).
3. **Feindliche oder kaputte Nachrichten** (NaN- oder ∞-yaw, abgeschnittene Puffer, 10 kB-Pakete, unbekannter Nachrichtentyp, 500 Eingaben/s): Der Server stürzt nicht ab, klemmt die Werte, verwirft den Überschuss bzw. trennt die Verbindung, und alle anderen Spieler laufen ungestört weiter. → Task 2 (`decodeInputs rejects malformed`) und Task 7 (`flood and garbage do not crash the room`).
4. **Tab lag im Hintergrund und kommt zurück:** Der Client hat für Sekunden nichts gesendet, der Ringpuffer ist voll oder die Lücke ist größer als 60 Schritte. Dann wird hart auf den Server-Stand gesetzt, ohne Wiederholungs-Lawine; der Server-Ratelimit verwirft den Nachhol-Burst. → Task 10 (`more than MAX_REPLAY_STEPS pending → hard set`).
5. **Namen aus Leerzeichen, Zero-Width-Zeichen, Emoji oder in anderer Groß-/Kleinschreibung** („jupp“ neben „Jupp“): Abgelehnt mit der passenden Meldung bzw. zu „jupp 2“ dedupliziert; nie ein unsichtbarer oder leerer Name über einer Figur. → Task 2 (`names: invisible and case duplicates`).

---

### Task 1: Physik-Erweiterungen für Sim, Abgleich und Personen-Kollisionen

**Files:**
- Modify: `packages/shared/src/physics/world.ts` (Kollisionsgruppen), `character.ts`, `vehicle.ts`, `props.ts`
- Create: `packages/shared/src/physics/surface.ts` (`surfaceY` aus `apps/client/src/game.ts` hierher verschieben; der Client importiert es von `@nn/shared`)
- Test: `packages/shared/src/physics/physics.test.ts`, `props.test.ts`

**Interfaces:**
- Produces:
  - `CHARACTER_GROUPS = 0x0008_fffb` (Mitglied Bit 3, filtert Autos aus) und `CAR_GROUPS = 0x0004_fff7` (Autos ignorieren Personen im Solver). Der Character-Controller-Query sieht Autos weiterhin, man kann also nicht durch ein Auto laufen. Kinematische Personen-Stellvertreter (Task 10) nutzen dieselbe Gruppe.
  - `type CharacterState = { x: number; y: number; z: number; vx: number; vy: number; vz: number; grounded: boolean; downTicks: number }` mit `Character.saveState(): CharacterState` und `Character.restoreState(s: CharacterState): void`.
  - `Character.knock(v: {x,y,z}, ticks: number): void`: setzt `down` für `ticks` Schritte. Solange `down` aktiv ist, ignoriert `applyInput` die Richtungseingaben und bewegt die Kapsel mit der Knock-Geschwindigkeit (Schwerkraft, Bodenreibung 6 m/s² horizontal) über den Character-Controller. Dazu `isDown(): boolean`.
  - `Character.push(dx: number, dz: number): void`: zusätzliche Verschiebung im nächsten `applyInput`, geht durch den Controller.
  - `type VehicleState = { x,y,z, qx,qy,qz,qw, vx,vy,vz, ax,ay,az, steer: number }` mit `Vehicle.saveState()` / `Vehicle.restoreState(s)`. `restoreState` setzt Pose und Geschwindigkeiten, weckt das Chassis und setzt `steerAngle` an allen Lenkrädern.
  - `Vehicle.steer(): number` (aktueller Lenkwinkel, für Snapshots).
  - `StreetProps.standUp(i: number): void` stellt Laterne i an ihrem Manifest-Platz wieder auf (fixed, `PROP_GROUPS`, wieder in `standing`). `StreetProps.follow(i: number, pose: PropPose): void` macht sie kinematisch auf `pose` mit `LYING_PROP_GROUPS` (Client: vom Server gestreamte Laterne). `StreetProps.isResting(i): boolean` (dynamisch und schlafend).
  - `surfaceY(pw, x, z, fromY): number | null` (unverändert, nur verschoben).

- [ ] **Step 1: Failing tests** in `physics.test.ts` (synthetische Welt wie die bestehenden Tests):
  - `car passes a standing character without stopping`: Ein Auto mit 30 km/h trifft eine stehende Figur. Nach 1 s ist das Auto noch ≥ 25 km/h schnell. Das ist die Plan-1-Einschränkung, die hier behoben wird; Knockback kommt erst in Task 4.
  - `character cannot walk through a parked car`: Läuft man 3 s gegen ein schlafendes Auto, bleibt der Abstand der Mittelpunkte ≥ halbe Breite + Radius − 0.05.
  - `character save/restore round-trips mid-jump`: Mitten im Sprung speichern, 30 Schritte laufen, wiederherstellen, dieselben 30 Eingaben erneut anwenden → gleiche Position (< 1e-4 m) und `vy` wie beim ersten Durchlauf.
  - `knock: down for N ticks, no input effect, then walks again`: `knock({x:5,y:3,z:0}, 60)` → während 60 Schritten ändert `forward: 1` nichts an der Richtung, `isDown()` ist true, die Figur landet. Danach ist `isDown()` false und Eingaben wirken wieder.
  - `vehicle save/restore replays within 1 cm`: 2 s fahren mit Lenkung, speichern, 20 Schritte mit Eingaben, wiederherstellen, dieselben 20 Schritte → Positionsfehler < 0.01 m, Lenkwinkel gleich.
- [ ] **Step 2:** `npx vitest run packages/shared/src/physics` → die neuen Tests schlagen fehl.
- [ ] **Step 3:** Implementieren. In `props.test.ts` zusätzlich: `standUp restores a knocked lamp` und `follow makes a lamp kinematic at the pose`.
- [ ] **Step 4:** `npx vitest run packages/shared/src/physics` und `npm run typecheck` → grün; die bestehenden Physik-Tests bleiben grün.
- [ ] **Step 5:** Commit `feat(physics): state save/restore, knockdown, car/person groups, lamp reset`.

### Task 2: `@nn/shared/net`: Konstanten, Namen, Quantisierung, Binärformat

**Files:**
- Create: `packages/shared/src/net/constants.ts` (Werte siehe Global Constraints), `names.ts`, `badwords.ts`, `quant.ts`, `codec.ts`, `index.ts`
- Modify: `packages/shared/src/index.ts` (re-export `./net`)
- Test: `packages/shared/src/net/names.test.ts`, `quant.test.ts`, `codec.test.ts`

**Interfaces:**
- Produces:
  - `type NameResult = { ok: true; name: string } | { ok: false; error: 'length' | 'chars' | 'bad' }` und `checkName(raw: string): NameResult`. `NAME_ERRORS: Record<'length'|'chars'|'bad', string>` enthält die exakten Texte aus den Global Constraints. `dedupeName(name: string, taken: Iterable<string>): string`.
  - `isBadName(name: string): boolean`: Normalisierung durch Kleinschreibung, Umlaute → ae/oe/ue/ss, Leetspeak (`0→o 1→i 3→e 4→a 5→s 7→t @→a $→s`) und Entfernen von Nicht-Buchstaben. Danach Teilstring-Treffer gegen eine kurze deutsch-englische Liste in `badwords.ts` (≈ 40 Einträge, Auswahl dem Umsetzer überlassen; Kölner Alltagswörter wie „Jeck“ dürfen nicht anschlagen).
  - `quant.ts`: `qPos(m) → int32 (cm)`, `dqPos`, `qAngle(rad) → uint16`, `dqAngle`, `packQuat(q) → { a: int16, b: int16, c: int16, idx: 0..3 }` (smallest three, Vorzeichen so, dass die weggelassene Komponente ≥ 0 ist), `unpackQuat`, `qVel(m/s) → int16 (cm/s, geklemmt ±327 m/s)`.
  - `STATION_IDS = ['koellefornia', 'radiokoeln', 'einslive'] as const` und `type StationId` ziehen aus `apps/client/src/audio/stations.ts` hierher um (der Client re-exportiert sie), damit der Server `radio`-Nachrichten gegen die Liste prüfen kann; Unbekanntes → `null`.
  - `type PlayerInput = { forward: number; right: number; run: boolean; jump: boolean; brake: boolean; use: boolean; yaw: number }`, `NEUTRAL_INPUT(yaw)`.
  - `type InputPacket = { seq: number; tick: number; inputs: PlayerInput[] }` (`seq` ist die Sequenznummer der ersten Eingabe, die folgenden sind seq+1 …). `encodeInputs(p): Uint8Array` / `decodeInputs(b: Uint8Array): InputPacket | null`. forward/right als int8 (×127), Flags-Byte, yaw als uint16. `null` bei falscher Länge oder mehr als 3 Eingaben. Nicht-endliche Werte werden beim Kodieren geklemmt; die Dekodierung liefert immer Werte in −1..1.
  - `type Snapshot` mit den Feldern aus Spec 6.3:
    - Kopf: `serverTick: u32`, `ackSeq: u32`.
    - `own`: `mode` (0 walk/1 drive/2 down), `char: CharacterState` als float32, `car: VehicleState | null` als float32, `carId`, `engine` (0 off/1 starting/2 running).
    - `walkers[]`: `slot: u8`, Position (cm), `yaw: u16`, `speed: u8` (dm/s), `state: u8` (0 stehend/1 laufend/2 gefallen).
    - `cars[]`: `id: u16`, Position (cm), Quaternion (smallest three), Geschwindigkeit (cm/s, int16×3), `steer: int8`, `flags: u8` (Bit 0 Bremslicht, Bit 1 hat Fahrer).
    - `lamps[]`: `i: u16`, Pose wie bei Autos.
    - `events[]`: `{ t: 'knock', slot } | { t: 'impact', x, z, strength: u8 } | { t: 'lamp', i }`.
    
    Dazu `encodeSnapshot(s): Uint8Array` / `decodeSnapshot(b): Snapshot | null`. Das erste Byte ist `PROTOCOL_VERSION`.
- [ ] **Step 1: Failing tests:**
  - `names: length, chars, collapse` (`'  Jupp   Schmitz '` → `'Jupp Schmitz'`; `'J'` → `length`; `'Jupp<3'` → `chars`).
  - `names: invisible and case duplicates`: `'​​'` → `length`; `'😀😀'` → `chars`; `dedupeName('jupp', ['Jupp'])` → `'jupp 2'`; `dedupeName('Jupp', ['Jupp', 'jupp 2'])` → `'Jupp 3'`.
  - `names: leetspeak and umlaut filter`: `'Arschl0ch'` und `'ARSCHLOCH'` ergeben `bad`; `'Jeck'`, `'Rheinländer'` und `'Kölsch'` sind ok.
  - `quant round-trips`: Position Fehler ≤ 0.005 m bei x = ±3000; Winkel ≤ 2π/65536; 1000 zufällige (fest geseedete) Einheitsquaternionen → Winkelfehler < 0.002 rad.
  - `snapshot round-trip`: 40 Fußgänger, 30 Autos, 2 Laternen und 3 Ereignisse; nach Encode und Decode sind die Felder innerhalb der Quantisierung gleich. Die Größe beträgt höchstens 60 × 13 + 40 × 26 + 120 Bytes bei 60 Fußgängern und 40 Autos (also ≤ 50 KB/s bei 20 Hz).
  - `decodeInputs rejects malformed`: abgeschnittener Puffer → null; 4 Eingaben → null; 10 kB → null; NaN-yaw beim Kodieren → endlich.
- [ ] **Step 2:** `npx vitest run packages/shared/src/net` → FAIL.
- [ ] **Step 3:** Implementieren. Nur `DataView`, keine Abhängigkeit.
- [ ] **Step 4:** Tests und `npm run typecheck` grün.
- [ ] **Step 5:** Commit `feat(net): protocol constants, names, quantisation, binary codec`.

### Task 3: `WorldSim`: Welt, Spieler, Autos, Ein-/Aussteigen, Zündung

**Files:**
- Create: `packages/shared/src/sim/assets.ts`, `cars.ts`, `ignition.ts` (aus `apps/client/src/ignition.ts` verschoben, Zeit jetzt in Ticks), `rules.ts` (`nearestEnterableCar`, `canGetOut`, `exitSpot`, `headingOf`, `parkedPose` aus `apps/client/src/car.ts` verschoben; `parkedPose` ohne Three.js umschreiben), `spawn.ts`, `world-sim.ts`, `index.ts`
- Modify: `packages/shared/src/index.ts`, `apps/client/src/car.ts`, `apps/client/src/ignition.ts` (re-export oder Import umstellen; die Client-Tests `car.test.ts` und `ignition.test.ts` laufen gegen die verschobenen Funktionen weiter)
- Test: `packages/shared/src/sim/world-sim.test.ts`, `spawn.test.ts`, `cars.test.ts`

**Interfaces:**
- Consumes: Task 1 (Gruppen, save/restore), Task 2 (`PlayerInput`, Konstanten).
- Produces:
  - `type WorldAssets = { manifest: WorldManifest; collision: CollisionAsset; terrain: TerrainGrid }`; `loadWorldAssets(read: (file: string) => Promise<ArrayBuffer>): Promise<WorldAssets>` (liest `manifest.json`, `collision.bin`, `terrain.bin`); `worldHash(manifestBytes: ArrayBuffer): Promise<string>` (SHA-256, erste 12 Hex-Zeichen, über `crypto.subtle`, das es in Node 24 und im Browser gibt).
  - `type PlayerId = number` (Slot 0..MAX_PLAYERS−1).
  - `class CarPool` (Logik aus `ParkedCars` ohne Rendering): `poses: CarPose[]`, `colors: number[]`, `driver: (PlayerId | null)[]`, `vehicle(i): Vehicle | null`, `updateProximity(foci: {x,z}[])` mit `CAR_PHYSICS_NEAR = 150` / `CAR_PHYSICS_FAR = 200` (Konstanten aus `car.ts` hierher verschieben) und für **alle** Foki, `sync()`, `enter(i, id): Vehicle`, `exit(i)`, `isMoved(i): boolean` (Pose weicht > 0.05 m oder > 2° vom Manifest ab), `reset(i)`, `awake(): number[]` (Indizes wacher Chassis).
  - `class Ignition` in Ticks: `start()`, `stop()`, `update(): IgnitionEvent[]` pro Tick, `state`, `lightLevel(): 0 | 0.5 | 1` (0 bis zum Anlasser, 0.5 während des Anlassens, 1 wenn er läuft; das Flackern macht der Client). Zeitpunkte unverändert: `DOOR_CLOSE_AT`, `CRANK_AT` und `ENGINE_CATCH_S`, in Ticks gerundet.
  - `findSpawn(pw, manifest, terrain, occupied: (x,z) => boolean): {x,y,z}`: Kandidaten sind Manifest-Spawn, dann abwechselnd ±k·1.5 m entlang der Straße (Achse `spawn.heading`; ein Test auf dem echten Manifest prüft, dass alle Kandidaten ≤ 60 m auf dem Gehweg liegen, also `surfaceY` innerhalb 0.3 m von `spawn.y`; sonst die Achse senkrecht dazu verwenden). Ein Kandidat ist frei, wenn eine Kapsel dort nichts überlappt (Welt, Autos, andere Personen). Ist alles belegt, wird der Manifest-Spawn genommen.
  - `type SimEvent = { t: 'enter'; id; car } | { t: 'enterDenied'; id } | { t: 'exit'; id; car } | { t: 'exitDenied'; id; reason: 'speed' | 'blocked' } | { t: 'ignition'; car; e: IgnitionEvent } | { t: 'knock'; id; by: number } | { t: 'impact'; x; z; strength } | { t: 'lamp'; i }`.
  - `class WorldSim`:
    - `static create(a: WorldAssets, opts?: { foci?: 'players' | { x: number; z: number }[] }): Promise<WorldSim>`
    - `readonly pw`, `readonly cars: CarPool`, `readonly props: StreetProps`, `tick: number`
    - `addPlayer(id: PlayerId, at?: {x,z}): void` (ohne `at`: `findSpawn`), `removePlayer(id)` (gibt das Auto frei, Motor aus)
    - `step(inputs: ReadonlyMap<PlayerId, PlayerInput>): SimEvent[]`: Eingaben in Map-Reihenfolge, die zugleich die Ankunftsreihenfolge ist; dann Regeln, dann `pw.step()`.
    - `player(id): PlayerSnapshot` mit `{ mode: 'walk'|'drive'|'down'; pos; vel; yaw; carId: number | null; char: CharacterState; car: VehicleState | null; engine }`
    - `players(): Iterable<PlayerId>`
    - `use(E)` mit steigender Flanke entscheidet einsteigen/aussteigen wie heute in `Game.getIn`/`getOut`. `exitFree` wandert als Funktion nach `rules.ts`.
    - Im Auto: `throttle = engine === 'running' ? forward : 0`, `steer = right`, `brake`.
- [ ] **Step 1: Failing tests** in `world-sim.test.ts`. Sie laufen gegen echte Assets (`skipIf` wie in `physics.test.ts`) und zusätzlich gegen eine kleine synthetische Welt (`fixtureAssets()` in `sim/fixture.test-util.ts`: flacher Boden, 4 Autos, 2 Laternen, 1 Baum), damit CI ohne Pipeline läuft:
  - `two players spawn apart`: Zwei `addPlayer` ohne Position → Abstand ≥ 1.4 m; beide stehen (`grounded`) nach 30 Schritten.
  - `enter and exit`: Spieler 3 m neben Auto 0, `use` → `enter`-Ereignis, `mode` drive, `cars.driver[0] === id`. Nach 90 Ticks ist die Zündung `running`. Danach `use` im Stand → `exit`, Spieler steht neben dem Auto.
  - `throttle is dead until running`: In den ersten 50 Ticks nach dem Einsteigen bewegt `forward: 1` das Auto < 0.05 m.
  - `same-tick enter: lower queue order wins`: Zwei Spieler am selben Auto, beide `use` im selben `step` → der erste in der Map fährt, der zweite bekommt `enterDenied`.
  - `driver leaves → car free, engine off`: `removePlayer` des Fahrers → `driver` null, Zündung `off`, ein dritter Spieler kann einsteigen.
  - `exit refused at speed` (`exitDenied` mit `speed`).
  - `deterministic replay`: Zwei unabhängig erzeugte `WorldSim` mit derselben Eingabefolge (10 s laufen, einsteigen, fahren) liefern nach 600 Ticks Positionen, die < 1e-6 m auseinander liegen. Das sichert Spec 13.3 auf derselben JS-Engine ab.
- [ ] **Step 2:** `npx vitest run packages/shared/src/sim` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** `npm test`, `npm run typecheck` grün (die Client-Tests nutzen die verschobenen Funktionen).
- [ ] **Step 5:** Commit `feat(sim): WorldSim with players, car pool, enter/exit, ignition`.

### Task 4: `WorldSim`: Zusammenstöße mit Personen, Laternen, Rückstellung

**Files:**
- Create: `packages/shared/src/sim/collisions.ts`, `packages/shared/src/sim/resets.ts`
- Modify: `packages/shared/src/sim/world-sim.ts`
- Test: `packages/shared/src/sim/collisions.test.ts`, `resets.test.ts`

**Interfaces:**
- Consumes: `Character.knock/push/isDown` (Task 1), `WorldSim` (Task 3).
- Produces:
  - `carHitsPeople(sim): void` läuft vor jedem Schritt (Muster wie `StreetProps.checkHits`). Pro wachem Auto mit Geschwindigkeit über `KNOCKDOWN_KMH` zählen alle Fußgänger-Kollider (nicht `down`) in der Box um das Chassis, erweitert um Geschwindigkeit·dt + 0.05, als Treffer. Treffer → `knock(v_car·0.9 + (0,3,0), KNOCKDOWN_S·60)`, Auto-Geschwindigkeit ·0.97, Ereignisse `knock` und `impact`. Langsamer → `push` um den Überlapp entlang der Auto-Geschwindigkeit.
  - `separatePeople(sim): void`: Paare von Fußgängern (O(n²) mit Raster 2 m), deren Abstand < 2·Radius ist, werden je zur Hälfte auseinander geschoben (`push`).
  - `class ResetTimers` (aufgerufen alle 60 Ticks): merkt pro Auto und Laterne den Tick der letzten Bewegung bzw. Belegung; nach `RESET_AFTER_S` ohne Spieler ≤ `RESET_CLEAR_RADIUS` → `cars.reset(i)` bzw. `props.standUp(i)`.
  - `WorldSim.lampState(i)`: `'standing' | 'tipping' | 'lying'` und `WorldSim.lampsDown(): number[]`.
- [ ] **Step 1: Failing tests:**
  - `car at 30 km/h knocks a walker down for 1 s`: Das Ereignis `knock` kommt genau einmal. Die Figur ist 60 ± 1 Ticks `down`, danach `walk`. Ihre Verschiebung zeigt in Fahrtrichtung (Skalarprodukt > 0). Das Auto ist danach noch ≥ 25 km/h schnell.
  - `car at 5 km/h pushes without knockdown`: kein `knock`-Ereignis; die Figur steht danach außerhalb des Chassis.
  - `walkers do not overlap`: Zwei Spieler laufen frontal aufeinander zu → Mindestabstand ≥ 2·Radius − 0.05.
  - `down player ignores input`.
  - `lamp falls once, reset after 600 s only without players near`: Laterne fällt (`lamp`-Ereignis). Bei einem Spieler in 50 m ist sie nach 36 000 Ticks noch gefallen; ist der Spieler 150 m weg, steht sie nach weiteren 36 000 Ticks wieder. Die Tick-Uhr wird über einen Test-Hook `sim.advanceIdleTicks(n)` vorgestellt, ohne n Physikschritte zu simulieren.
  - `moved car resets after 600 s` (gleiches Muster).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** Grün.
- [ ] **Step 5:** Commit `feat(sim): knockdown, pushing, walker separation, idle resets`.

### Task 5: Interessenbereich und Snapshot-Erzeugung

**Files:**
- Create: `packages/shared/src/net/interest.ts`, `packages/shared/src/sim/snapshot.ts`
- Test: `packages/shared/src/net/interest.test.ts`, `packages/shared/src/sim/snapshot.test.ts`

**Interfaces:**
- Produces:
  - `class Interest`: pro Client `update(focus: {x,z}, entities: Iterable<{ key: string; x: number; z: number }>): Set<string>` mit Eintritt bei ≤ `INTEREST_RADIUS` und Austritt bei > `INTEREST_RELEASE`. Schlüssel: `p<slot>`, `c<id>`, `l<i>`.
  - `buildSnapshot(sim: WorldSim, id: PlayerId, interest: Interest, ackSeq: number, events: SimEvent[], slotOf: (id) => number): Snapshot`: fremde Fußgänger und Fahrer im Bereich; Autos, die fahren oder wach sind; Laternen, die `tipping` sind; Ereignisse mit Position im Bereich (`knock` immer für einen selbst).
- [ ] **Step 1: Failing tests:**
  - `hysteresis`: Entität bei 260 m kommt nicht hinein, bei 249 m schon; bei 265 m bleibt sie drin, bei 271 m fällt sie raus.
  - `sleeping parked cars are never in snapshots`, `pushed car is streamed while awake`, `own player not in walkers`.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(net): interest management and snapshot builder`.

### Task 6: Client-`Game` als Darstellung über `WorldSim` (Einzelspieler-Modus)

Ziel: Das Spiel läuft wieder genauso wie heute, nur über eine lokale `WorldSim` (`?offline=1`). Danach gibt es genau eine Simulation für Server, Vorhersage und Offline.

**Files:**
- Modify: `apps/client/src/game.ts` (Simulationsteile raus, `WorldSim` rein), `apps/client/src/car.ts` (`ParkedCars` wird reines Rendering: liest `sim.cars.poses` und `colors`, besitzt keine Vehicles mehr), `apps/client/src/main.ts`, `scripts/drive-check.mjs` (URL mit `?offline=1`)
- Create: `apps/client/src/session.ts`
- Test: `apps/client/src/car.test.ts` (an das Rendering anpassen), `apps/client/src/session.test.ts`

**Interfaces:**
- Consumes: `WorldSim`, `CarPool`, `Ignition` (Task 3).
- Produces:
  - `interface Session { readonly sim: WorldSim; readonly me: PlayerId; frame(dt: number, input: PlayerInput, radioCmd?: StationId | null): SimEvent[]; alpha: number; steps: number }`. `OfflineSession` führt die Eingabe über `FixedStepper` direkt in `sim.step(new Map([[me, input]]))`. Task 10 liefert `OnlineSession` mit derselben Schnittstelle.
  - `Game` bekommt die `Session` statt `PhysicsWorld`. Ton (`ignition`-Ereignisse → `doorClosed`/`crank`/`engineRunning`), Radio-Rad, Karte, Kamera und Glare bleiben in `Game`. Die Lichtleistung ist `lightLevel` plus Flackern (`0.25 + 0.35·rand` bei 0.5).
  - `?offline=1` ist nur erlaubt mit `import.meta.env.DEV || debug`. Ohne Server (bis Task 9) ist offline der einzige Modus.
- [ ] **Step 1:** `session.test.ts`: `offline session steps the sim at 60 Hz` (dt 0.05 → 3 Schritte) und `jump is consumed once`.
- [ ] **Step 2:** Refaktorieren. `__nnState` liefert dieselben Felder wie bisher.
- [ ] **Step 3:** `npm test`, `npm run typecheck`, dann `npm run dev` und in zweitem Terminal `npm run drive-check` (GPU wie üblich, siehe `scripts/browser-args.mjs`) → grün. Zusätzlich `npm run screenshot` vor und nach dem Umbau: Nacht- und Tagbild gleich (Sichtvergleich).
- [ ] **Step 4:** Commit `refactor(client): Game renders a WorldSim through a Session`.

### Task 7: Server-Grundgerüst: Raum, Beitritt, Takt, Eingaben

**Files:**
- Create: `apps/server/package.json` (`@nn/server`, `type: module`, Abhängigkeiten `colyseus`, `@colyseus/schema`, `@nn/shared`, `tsx`; `scripts.start = "tsx src/main.ts"`), `apps/server/tsconfig.json` (erbt `tsconfig.base.json`, `types: ["node"]`), `src/main.ts`, `src/config.ts`, `src/room.ts`, `src/state.ts`, `src/inputs.ts`, `src/join-limit.ts`, `src/log.ts`
- Modify: Root-`package.json` (`typecheck` um `apps/server` ergänzen), `vitest.config.ts` (schließt `apps/*` schon ein)
- Test: `apps/server/src/inputs.test.ts`, `join-limit.test.ts`, `room.test.ts`

**Interfaces:**
- Consumes: `WorldSim`, `loadWorldAssets`, `worldHash`, `checkName`/`dedupeName`, `decodeInputs`, Konstanten.
- Produces:
  - `config.ts`: `loadConfig(env): { port: number; maxPlayers: number; publicUrl: string | null; logLevel: 'debug'|'info'|'warn'|'error'; dev: boolean; worldDir: string }`. `worldDir` hat Standard `apps/client/dist/world` und, falls das fehlt, `apps/client/public/world`; überschreibbar mit `NN_WORLD_DIR`. Dazu `fakeLag: { ms: number; jitterMs: number; stallPct: number } | null`, nur im Dev-Modus aus `NN_FAKE_LAG`, Format `ms,jitter,stallPct`.
  - `class InputQueue` pro Spieler: `push(p: InputPacket, nowMs)` verwirft Eingaben mit `seq ≤ lastQueued`, verwirft alles über `MAX_INPUTS_PER_S` (Token-Bucket) und hält höchstens 6 Eingaben (älteste fallen raus). `next(): PlayerInput` liefert pro Tick eine Eingabe oder `NEUTRAL_INPUT(lastYaw)`. Dazu `ackSeq`.
  - `log.ts`: `log(level, msg, fields)` als JSON-Zeile auf stdout, gefiltert nach `LOG_LEVEL`; Join/Leave mit Slot, Name und `ipHash` (nie die IP), Tick-Überläufe, Fehler.
  - `class JoinLimiter`: `allow(ipHash, nowMs): boolean` (5 pro 60 s gleitend).
  - Colyseus-`Room` `nippes` (`maxClients` aus der Konfiguration):
    - `onAuth`: `{ name, protocolVersion, worldHash }` prüfen. Bei Abweichung `ServerError(409, 'version')`, bei ungültigem Namen `ServerError(400, error)`, bei Limit `ServerError(429, 'rate')`. Der Client übersetzt diese Codes in die exakten Texte.
    - `onJoin`: Slot vergeben, `dedupeName`, `sim.addPlayer`.
    - Nachricht `i` (Bytes) → `InputQueue.push`. Eine unbekannte Nachricht oder eine Nachricht über `MAX_MESSAGE_BYTES` trennt den Client (`client.leave(4400)`). Nachricht `radio` (`StationId | null`) setzt den Senderzustand des eigenen Autos. Nachricht `devTeleport {x,z}` gilt nur im Dev-Modus.
    - Simulation über `setSimulationInterval` mit einem `FixedStepper(1/60, 3)` auf der vergangenen Wanduhrzeit. Läuft der Tick mehr als 3 Schritte hinterher, wird der Rest verworfen und ein `warn`-Log geschrieben, höchstens 1 pro 10 s, mit Anzahl.
    - Join-Ergebnis an den Client (`client.send('welcome', { slot, name, devMode, tick })`).
  - `state.ts` (Schema mit `schema()`-Builder, ohne Decorators): `players: MapSchema<{ slot, name, mode, carId }>`; `cars: MapSchema<{ driver, engine, lights, radio, x,y,z,qx,qy,qz,qw }>` nur für Autos, die vom Manifest abweichen oder einen Fahrer haben (Pose wird aktualisiert, sobald das Auto ruht); `lamps: MapSchema<{ x,y,z,qx,qy,qz,qw }>` für ruhende gefallene Laternen. Ohne StateView: Das sind höchstens ein paar hundert kleine Einträge, der Interessenbereich gilt nur für den schnellen Snapshot (Spec 6.3: Encoding ist dem Umsetzer überlassen).
- [ ] **Step 1: Failing tests:**
  - `inputs.test.ts`:
    - `missing input is neutral, not repeated`: Nach einer `forward: 1`-Eingabe und dann keiner liefert `next()` beim zweiten Mal forward 0, yaw gleich.
    - `duplicate and old seqs are ignored`.
    - `rate limit drops excess`: 300 Eingaben in 1 s → höchstens 90 + Burst 6 angenommen.
    - `queue keeps newest 6`.
  - `join-limit.test.ts`: 6. Beitritt innerhalb 60 s abgelehnt, nach 60 s wieder erlaubt.
  - `room.test.ts`: Der Raum läuft in-process mit `@colyseus/sdk` als Client gegen echte Assets (`skipIf` ohne Assets):
    - `join with wrong protocol → 409`.
    - `bad name → 400 'bad'`.
    - `101st player is rejected` (Konfiguration `maxPlayers: 2`, dritter abgelehnt).
    - `flood and garbage do not crash the room`: Ein Client sendet 10 kB-Bytes, NaN-Pakete und 500 Eingaben/s → er wird getrennt bzw. gedrosselt; ein zweiter Client bekommt weiter Ticks (`state.players` aktualisiert sich).
- [ ] **Step 2:** `npx vitest run apps/server` → FAIL.
- [ ] **Step 3:** Implementieren. Vor dem Schreiben die Colyseus-0.18-Doku zu `defineServer`/`Room`/`schema()`/`ServerError` lesen (`node_modules/colyseus`, `node_modules/@colyseus/schema/README.md`), keine 0.15-Beispiele aus dem Netz übernehmen.
- [ ] **Step 4:** Grün; `npm run typecheck` grün.
- [ ] **Step 5:** Commit `feat(server): Colyseus room with authoritative WorldSim, input queue, join checks`.

### Task 8: Server: Snapshots, Reconnect, Auslieferung, `/healthz`

**Files:**
- Modify: `apps/server/src/room.ts`, `apps/server/src/main.ts`
- Create: `apps/server/src/static.ts`, `apps/server/src/health.ts`, `apps/server/src/fake-lag.ts`
- Test: `apps/server/src/room.test.ts` (erweitern), `static.test.ts`

**Interfaces:**
- Produces:
  - Alle `SNAPSHOT_EVERY` Ticks pro Client `buildSnapshot` → `client.sendBytes('s', encodeSnapshot(...))`. Die Ereignisse seit dem letzten Snapshot werden gesammelt.
  - `onLeave(client, code)`: Ist die Trennung nicht beabsichtigt, wartet `allowReconnection(client, RECONNECT_S)`. Bis dahin bekommt der Slot neutrale Eingaben. Danach `sim.removePlayer`.
  - `static.ts`: liefert `apps/client/dist` aus. `index.html` mit `no-cache`; Dateien unter `assets/` (Vite-Hash) mit `public, max-age=31536000, immutable`; `world/*` mit `no-cache` (nach einem Deploy nie ein altes Manifest); alle Dateien mit ETag (Größe + mtime), `If-None-Match` → 304. Vorkomprimierte `.br`/`.gz` werden nach `Accept-Encoding` gewählt. Pfade außerhalb von `dist` → 404.
  - `GET /healthz` → `200 {"players": n, "tickP95Ms": x, "dropped": n}` (gleitendes Fenster der letzten 600 Ticks).
  - `fake-lag.ts` (nur Dev): verzögert ein- und ausgehende Nachrichten pro Client um `ms ± jitter`. Mit Wahrscheinlichkeit `stallPct` hält es eine Nachricht zusätzlich 200 ms zurück, ohne die Reihenfolge zu ändern; so sieht 1 % Verlust über TCP aus.
- [ ] **Step 1: Failing tests:**
  - `two clients see each other`: A und B treten bei; nach ≤ 1 s enthält der Snapshot von A B in `walkers` und umgekehrt.
  - `enter is exclusive`: A und B stehen an Auto 0 (`devTeleport`), beide senden `use` → genau einer hat `mode` drive.
  - `car hits walker → down, up after ~1 s`: A fährt (devTeleport + Gas) auf B zu → B bekommt das Ereignis `knock`; `own.mode` ist 2, 1.0 ± 0.1 s später 0.
  - `reconnect within 15 s keeps player and car`: A sitzt im Auto, Socket wird hart geschlossen, nach 2 s `reconnect` → gleicher Slot, `mode` drive, gleiches Auto.
  - `after 15 s the car is free`: Mit `RECONNECT_S` im Test auf 1 s gesetzt (Konfigurations-Override).
  - `static.test.ts`: Cache-Header wie oben, `../`-Pfad → 404, `Accept-Encoding: br` liefert `.br`.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(server): snapshots, reconnect window, static hosting, healthz`.

### Task 9: Client-Netz: Namensdialog, Verbindung, Eingaben senden, Interpolation

**Files:**
- Create: `apps/client/src/net/lobby.ts` (DOM-Overlay), `apps/client/src/net/connection.ts`, `apps/client/src/net/interp.ts`, `apps/client/src/net/clock.ts`
- Modify: `apps/client/src/main.ts` (Ablauf: Namensdialog → Verbindung → Welt laden → Spiel), `apps/client/vite.config.ts` (Dev-Proxy `/healthz` und die WebSocket-Route auf `localhost:2567`), Root-`package.json` (`dev` startet Client und Server parallel, ohne neue Abhängigkeit: ein kleines `scripts/dev.mjs` mit `child_process.spawn` für beide und gemeinsamem Beenden)
- Test: `apps/client/src/net/interp.test.ts`, `clock.test.ts`, `lobby.test.ts`

**Interfaces:**
- Consumes: Codec, Konstanten, `checkName`/`NAME_ERRORS`.
- Produces:
  - `class Lobby`: `ask(): Promise<string>` (Enter bestätigt; Vorabprüfung mit `checkName`; Fehlermeldung unter dem Feld), `showError(text, retryInS?)`. Den Namen in `localStorage` merken, mit try/catch.
  - `connectRoom(name, worldHash): Promise<Connection>`. Server nicht erreichbar → Texte aus den Global Constraints mit automatischem Neuversuch alle `RETRY_CONNECT_S` (Countdown im Dialog); 409 → Versionstext ohne Neuversuch; voll → Volltext mit Neuversuch; 429 → „Zu viele Versuche – warte kurz.“
  - `Connection`: `sendInputs(p: InputPacket)`, `sendRadio(s)`, `onSnapshot(cb)`, `state` (Schema-Spiegel), `welcome`, `rttMs`, `close()`. Reconnect bei Abbruch: `client.reconnect(token)` bis 15 s, währenddessen HUD-Status „Verbindung unterbrochen …“.
  - `class SnapshotBuffer<T>`: `push(serverTick, entities: Map<key, T>)`, `sample(renderTick): Map<key, T>` (lineare Interpolation, Quaternion per nlerp). Hinter dem letzten Snapshot wird bis `EXTRAPOLATE_MAX_S` mit der Geschwindigkeit extrapoliert, danach eingefroren.
  - `class ServerClock`: schätzt aus Snapshot-Ankünften den Server-Tick (gleitender Offset, Ausreißer verwerfen). `renderTick() = estimate − INTERP_DELAY_S·60`.
- [ ] **Step 1: Failing tests:**
  - `interp between two snapshots` (halber Weg → Mittelpunkt);
  - `extrapolates up to 150 ms then freezes`;
  - `entity missing in newer snapshot disappears after it`;
  - `clock converges with 30 ms jitter within 2 s` (simulierte Ankünfte; Fehler < 1 Tick);
  - `lobby rejects 'J' with the length text`: `Lobby` trennt die reine Funktion `validate(raw): string | null` von der DOM-Schicht; getestet wird `validate`, ohne DOM-Bibliothek.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(client): lobby, connection, snapshot interpolation, server clock`.

### Task 10: Vorhersage und Abgleich (`OnlineSession`)

**Files:**
- Create: `apps/client/src/net/online-session.ts`, `packages/shared/src/sim/proxies.ts`, `packages/shared/src/sim/replay.ts`
- Modify: `packages/shared/src/sim/world-sim.ts`
- Test: `packages/shared/src/sim/replay.test.ts`, `apps/client/src/net/online-session.test.ts`

**Interfaces:**
- Consumes: `Session` (Task 6), `Connection`, `SnapshotBuffer` (Task 9), save/restore (Task 1).
- Produces:
  - `WorldSim.setProxies(walkers: Map<PlayerId, {x,y,z}>, cars: Map<number, CarPose>)`: Fremde Fußgänger werden kinematische Kapseln (`CHARACTER_GROUPS`). Fremde gefahrene oder vom Server gestreamte Autos werden kinematisch auf der Pose (`CarPool.follow(i, pose)`). Autos, die nicht mehr gestreamt werden, werden an der Endpose aus dem langsamen Zustand wieder dynamisch und schlafend (`CarPool.release(i, pose)`).
  - `WorldSim.replay(id, from: { char: CharacterState; car: VehicleState | null; mode }, inputs: PlayerInput[]): void`: Eigenen Zustand setzen; Posen und Geschwindigkeiten aller anderen wachen dynamischen Körper sichern; die Eingaben schrittweise mit `pw.step()` anwenden, ohne Regeln für andere, ohne Ereignisse und ohne Tick-Fortschritt; die gesicherten Körper wiederherstellen. Nach außen ist der Zustand dann „eigene Entität auf neuem Stand, alles andere unverändert“.
  - `OnlineSession implements Session`:
    - Jede Eingabe bekommt `seq`. Der Ringpuffer der unbestätigten Eingaben fasst 120. Gesendet werden pro Frame die neuen Eingaben, bis zu 3 pro Paket.
    - Bei Snapshot: Eingaben ≤ `ackSeq` verwerfen. Liegen > `MAX_REPLAY_STEPS` Eingaben aus oder ist der Fehler > `HARD_SNAP_M`, wird hart auf den Server-Stand gesetzt (Puffer leeren). Sonst `replay`. Den Unterschied zwischen alter und neuer Vorhersage-Pose als Render-Offset über `CORRECTION_BLEND_S` abklingen lassen.
    - Einsteigen wird vorhergesagt (lokale `nearestEnterableCar` mit Belegung aus dem langsamen Zustand → Zündung startet lokal, also auch der Ton). Ist im Snapshot mit `ackSeq ≥ seq(use)` `own.mode` nicht drive, wird zurückgenommen: zu Fuß, `audio.exitCar()`, HUD „Das Auto ist besetzt“.
    - Laternen: Die lokale `StreetProps` sagt das Umfahren vorher. Die Server-Pose wird bei Ankunft übernommen (`follow`/ruhend), eine Laterne, die der Server nach 1 s nicht als gefallen meldet, mit `standUp` zurückgesetzt.
    - Statistik für das Debug-Overlay: `rttMs`, `snapshotAgeMs`, `predErrorM` (letzter Korrekturbetrag), `players`.
- [ ] **Step 1: Failing tests:**
  - `replay.test.ts`:
    - `replay leaves other dynamic bodies untouched`: Ein gestoßenes Auto rollt; `replay` mit 10 Schritten → seine Pose und Geschwindigkeit sind bitgleich zu vorher.
    - `prediction matches server at 0 ms latency` (Spec 13.3): Server-`WorldSim` und Client-`WorldSim` mit Proxies, 10 s geradeaus laufen bzw. fahren, Snapshot nach jedem 3. Tick per Codec übertragen → Positionsfehler < 0.01 m.
  - `online-session.test.ts` gegen einen Fake-`Connection` mit Server-`WorldSim` dahinter und konfigurierbarer Verzögerung:
    - `150 ms RTT: no correction jump > 0.2 m (p95)` beim Laufen und Fahren über 20 s.
    - `more than MAX_REPLAY_STEPS pending → hard set`: 2 s keine Snapshots, dann einer → harter Satz, kein Replay.
    - `denied enter is rolled back`: Der Server lässt einen anderen Spieler zuerst einsteigen.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(client): client-side prediction and reconciliation`.

### Task 11: Fremde Spieler darstellen

**Files:**
- Create: `apps/client/src/remote/remote-players.ts`, `apps/client/src/remote/name-label.ts`
- Modify: `apps/client/src/player.ts` (`setDown(k: 0..1)`: Umkippen um die Querachse, 0.25 s rein, Aufstehen 0.3 s), `apps/client/src/car.ts` (`DrivenCar` mit Option `{ beams: boolean }`: fremde Autos ohne SpotLights und Schatten, nur Leucht-Materialien und Glare-Sprites), `apps/client/src/game.ts`, `apps/client/src/main.ts` (gefallene Laternen über `props.knockDown` aus Server-Zustand bzw. Ereignissen)
- Test: `apps/client/src/remote/remote-players.test.ts`

**Interfaces:**
- Consumes: `SnapshotBuffer`-Samples (Task 9), Schema-Spiegel.
- Produces:
  - `class RemotePlayers`: `update(sample: { walkers: Map<slot, Walker>; cars: Map<id, RemoteCar> }, names: Map<slot, string>, camera, night, dt)`. Ein Pool von `PlayerFigure` (Figuren bei Austritt verstecken, wiederverwenden). Fremde gefahrene Autos werden als `DrivenCar({ beams: false })` gezeigt, die Instanz in `ParkedCars` wird dabei auf Skalierung 0 gesetzt wie beim eigenen Auto. Vom Server gestreamte, aber unbesetzte Autos aktualisieren nur die Instanzmatrix in `ParkedCars`.
  - `class NameLabel`: Sprite mit `CanvasTexture` 0.35 m über dem Kopf (über dem Dach im Auto), sichtbar ≤ 50 m, ab 35 m ausgeblendet, `depthTest: true`. Den eigenen Namen nicht zeigen.
  - Gestürzt: `setDown` aus dem Zustand `state === 2` im Snapshot. Das gilt auch für die eigene Figur (`own.mode === 2`).
- [ ] **Step 1: Failing tests:** `figures are pooled` (Ein- und Austritt von 5 Spielern → höchstens 5 Figuren erzeugt), `label fades between 35 and 50 m` (reine Funktion `labelOpacity(d)`), `remote car hides its parked instance`.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Manuell: `npm run dev` (Client + Server), zwei Browserfenster mit verschiedenen Namen → beide sehen sich, Namen lesbar, Fahren und Umfahren sichtbar. Screenshot nach `shots/mp-two.png`.
- [ ] **Step 6:** Commit `feat(client): render remote players, cars, names and knockdowns`.

### Task 12: Ton im Mehrspieler: fremde Motoren, fremdes Radio, Server-Ereignisse

**Files:**
- Create: `apps/client/src/audio/remote-audio.ts`
- Modify: `apps/client/src/audio/mixer.ts` (`loopAt(id, bus): PositionalLoopVoice` mit `PannerNode` HRTF/`inverse`, `setPosition(x,z)`), `apps/client/src/audio/game-audio.ts` (Ereignisse `knock`/`impact` als positionierte One-Shots), `apps/client/src/main.ts`
- Test: `apps/client/src/audio/remote-audio.test.ts`

**Interfaces:**
- Produces:
  - `class RemoteAudio`: `update(listener: {x,z}, cars: { id: number; x: number; z: number; speed: number; accel: number; engine: 'off'|'starting'|'running'; radio: StationId | null }[], dt)`.
    - `speed` kommt aus der Snapshot-Geschwindigkeit, `accel` (Ersatz für die unbekannte fremde Gasstellung, geglättet, geklemmt auf 0..1) aus deren Änderung; `engine` und `radio` aus dem langsamen Zustand.
    - Motorstimmen für die nächsten `REMOTE_ENGINE_VOICES` laufenden Autos über die bestehende `VehicleSound`-Logik mit `loopAt`. Wechselt ein Auto aus den nächsten 6 heraus, wird seine Stimme ausgeblendet, nicht abgeschnitten.
    - Fremdes Radio: nur für das nächste Auto mit `radio !== null` in ≤ `REMOTE_RADIO_RADIUS`. Ein zweites `HTMLAudioElement` mit `crossOrigin = 'anonymous'` → `MediaElementSource` → `BiquadFilter` lowpass `REMOTE_RADIO_LOWPASS_HZ` → Panner → Gain `REMOTE_RADIO_GAIN_DB` relativ zu `RADIO_VOLUME`, linear auf 0 bei 25 m.
    - Alle drei Sender schicken heute CORS-Header (geprüft am 2026-11-15). Löst das Element mit `crossOrigin` einen Fehler aus, wird dieser Sender für die Sitzung als „ohne Fremdradio“ markiert und bleibt stumm. Er wird nie ungefiltert gespielt, und das eigene Radio bleibt unberührt beim reinen `HTMLAudioElement`.
    - Bei Stummschaltung (N) und verstecktem Tab gilt dasselbe wie für das eigene Radio.
  - Der Radiosender des eigenen Autos wird bei jeder Änderung als `radio`-Nachricht an den Server geschickt (`GameAudio` meldet die Änderung über einen Callback `onStation(id)`).
- [ ] **Step 1: Failing tests** (Fakes für Mixer und Element wie in `game-audio.test.ts`):
  - `at most 6 engine voices, nearest first`;
  - `remote radio only nearest within 25 m`;
  - `cors failure marks station silent, never plays unfiltered`;
  - `muted: remote radio silent`.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(audio): remote engines, muffled remote radio, collision sounds`.

### Task 13: Dev-Hooks sperren, Debug-Overlay erweitern

**Files:**
- Modify: `apps/client/src/main.ts`, `apps/client/src/game.ts`, `apps/client/src/debug.ts`, `apps/client/src/devparams.ts`
- Test: `apps/client/src/devparams.test.ts`, `debug.test.ts`

**Interfaces:**
- Produces:
  - `devAllowed(mode: 'offline' | 'online', welcome: { devMode: boolean } | null, debug: boolean): { cam: boolean; fly: boolean; writeHooks: boolean }`. Offline gilt der bisherige Stand. Online ist alles nur bei `devMode` erlaubt. `?cam` wird online über die Nachricht `devTeleport` umgesetzt.
  - `__nnState` (nur lesend) bleibt immer; ergänzt um `online: boolean`, `players: number`. `__nnWheelNudge` und andere schreibende Hooks gibt es nur, wenn `writeHooks` erlaubt ist.
  - Lesende Hooks für `mp-check` (Task 14): `__nnState().correction` (Betrag der Render-Korrektur der eigenen Pose in diesem Frame, m) und `window.__nnRemote(): { slot: number; name: string; x: number; z: number; mode: string }[]`.
  - Das Debug-Overlay zeigt zusätzlich `RTT`, `Snapshot-Alter`, `Vorhersagefehler`, `Spieler`.
- [ ] **Step 1: Failing tests:** `devAllowed` als Tabelle (offline/online × devMode × debug); im Overlay erscheinen die neuen Zeilen.
- [ ] **Step 2–4:** FAIL → implementieren → grün.
- [ ] **Step 5:** Commit `feat(client): gate dev hooks in multiplayer, net stats in debug overlay`.

### Task 14: `mp-check` und Latenz-Test (Playwright)

**Files:**
- Create: `scripts/mp-check.mjs`
- Modify: Root-`package.json` (`"mp-check": "node scripts/mp-check.mjs"`)

**Interfaces:**
- Consumes: `__nnState` (`online`, `players`, `x`, `z`, `mode`), `devTeleport` über `?cam` (Dev-Server).
- Produces: `node scripts/mp-check.mjs [baseUrl] [--lag]`.
  - Ohne `--lag`: Zwei Headless-Chromium-Kontexte (GPU-Argumente aus `browser-args.mjs`) treten mit den Namen „Check A“ und „Check B“ bei. Beide müssen `players === 2` sehen. A steigt ins nächste Auto, fährt ≥ 30 m. B sieht A sich ≥ 30 m bewegen (`__nnRemote()`, Task 13).
  - Mit `--lag`: Der Server läuft mit `NN_FAKE_LAG=75,10,1` (≈ 150 ms RTT, 1 % Stalls). Gemessen wird pro Frame die Korrektur der eigenen Render-Pose (`__nnState().correction`) beim 20 s Laufen und Fahren → p95 ≤ 0.2 m. Die fremde Figur macht keinen Sprung > 1 m zwischen zwei Frames (Spec 13.4).
- [ ] **Step 1:** Skript schreiben, mit einem kurzen Budget in Physikschritten wie in `drive-check.mjs`, nicht mit der Wanduhr.
- [ ] **Step 2:** `npm run dev` (startet Server und Client), dann `npm run mp-check` → `mp-check: OK`. Danach Server mit `NN_FAKE_LAG=75,10,1` neu starten, `npm run mp-check -- --lag` → OK mit ausgegebenen p95-Werten.
- [ ] **Step 3:** `npm run drive-check` (offline) weiterhin grün.
- [ ] **Step 4:** Commit `test: mp-check with two browsers and simulated latency`.

### Task 15: Bots und Lasttest

**Files:**
- Create: `apps/server/src/bots/bot.ts`, `apps/server/src/bots/loadtest.ts`
- Modify: Root-`package.json` (`"loadtest": "tsx apps/server/src/bots/loadtest.ts"`)
- Test: `apps/server/src/bots/bot.test.ts`

**Interfaces:**
- Consumes: `@colyseus/sdk`, Codec, `devTeleport` (Bots verteilen sich, nur gegen Dev-Server).
- Produces:
  - `class Bot`: verbindet sich, sendet 60 Hz Eingaben in Paketen zu 3. Läufer wählen alle 3–8 s ein neues Ziel. Fahrer steigen ins nächste Auto, fahren und lenken in Kurven (Ziel: in Bewegung bleiben, nicht schön fahren). Alles mit geseedetem PRNG. Gemessen werden empfangene Bytes pro Sekunde.
  - `loadtest.ts [--url ws://…] [--bots 100] [--minutes 10]`: 60 % Läufer, 40 % Fahrer, alle teleportiert in einen Radius von 300 m um den Spawn. Alle 10 s werden `/healthz` (Tick p95, verworfene Ticks) und Server-RSS (aus `/healthz`, Feld `rssMb` ergänzen) abgefragt. Am Ende steht eine Tabelle und der Exit-Code ist ≠ 0, wenn ein Kriterium aus Spec 13.5 verfehlt ist: Tick p95 < 8 ms, < 1 % verworfene Ticks, Bandbreite p95 < 50 KB/s pro Client, RSS-Anstieg zwischen Minute 2 und 10 < 10 %.
- [ ] **Step 1: Failing test** `bot.test.ts`: `bot sends ≤ 20 packets/s of ≤ 3 inputs` gegen einen Fake-Room.
- [ ] **Step 2–3:** Implementieren → grün.
- [ ] **Step 4:** Lauf auf diesem Rechner: Server mit `taskset -c 0,1` auf 2 Kerne begrenzen (`NODE_ENV=development taskset -c 0,1 npm start -w @nn/server`), dann `npm run loadtest -- --minutes 10`. Werte in `docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md` festhalten. Wird ein Kriterium verfehlt, gezielt profilieren (`node --cpu-prof`). Naheliegende Hebel: weniger wache Fahrzeuge (`CAR_PHYSICS_NEAR` serverseitig für reine Läufer-Foki 60 m) und Snapshot-Erzeugung pro Raster statt pro Paar. Dann erneut messen.
- [ ] **Step 5:** Commit `feat(server): bots and 100-player load test`.

### Task 16: Docker-Image, Caddy-Beispiel, README

**Files:**
- Create: `apps/server/Dockerfile`, `.dockerignore`, `deploy/Caddyfile.example`, `scripts/precompress.mjs`
- Modify: `README.md` (Abschnitt „Mehrspieler betreiben“), Root-`package.json` (`"build"` baut den Client und führt danach `precompress` aus; `"start": "npm start -w @nn/server"`)

**Interfaces:**
- Produces:
  - Multi-Stage-Dockerfile auf `node:24-bookworm-slim`:
    1. Build: `npm ci`, dann `npm run build`. Die Welt kommt nicht aus dem Repo: Der Build erwartet `apps/client/public/world/` im Build-Kontext (vorher `npm run pipeline`). Fehlt sie, bricht der Build mit einer klaren Meldung ab.
    2. Runtime: `npm ci --omit=dev -w @nn/server -w @nn/shared`, kopiert `apps/client/dist` (inklusive `world/`), `packages/shared`, `apps/server`. Läuft als `USER node`, mit `ENV NODE_ENV=production PORT=2567`, `EXPOSE 2567`, `HEALTHCHECK` auf `/healthz`, `CMD ["npm","start","-w","@nn/server"]`.
  - `precompress.mjs`: legt für `dist/**/*.{js,css,html,json,bin,glb}` `.br` (Qualität 11) und `.gz` (Level 9) an, mit `node:zlib`.
  - `Caddyfile.example`: `nippes.example.org { encode zstd gzip; reverse_proxy 127.0.0.1:2567 }`, mit einem Kommentar, dass WebSockets ohne weitere Konfiguration durchgehen.
  - README: Build (`npm run pipeline`, `docker build -f apps/server/Dockerfile -t nippes-nights .`), Start (`docker run -p 2567:2567 -e MAX_PLAYERS=60 nippes-nights`; 100 nur auf einem schnelleren Einzelkern), Proxy, Update (neues Image, laufende Spieler werden getrennt, der Client zeigt den Versionstext), Mindestgröße 2 vCPU / 2 GB RAM.
- [ ] **Step 1:** `docker build` lokal → erfolgreich; `docker run` und `curl localhost:2567/healthz` → `200 {"players":0,…}`; Browser auf `http://localhost:2567` → Namensdialog, Spiel lädt.
- [ ] **Step 2:** `npm run mp-check http://localhost:2567/` gegen den Container → OK. Der Container läuft in Produktion, deshalb läuft der `?cam`-Teil von mp-check dort nicht; das Skript nimmt dann die Spawn-Positionen.
- [ ] **Step 3:** Commit `feat(deploy): Docker image, Caddy example, README`.

### Task 17: Abschluss-Abnahme

- [ ] `npm test`, `npm run typecheck`, `npm run drive-check` (offline), `npm run mp-check`, `npm run mp-check -- --lag`, Lasttest-Notiz vorhanden → alle grün bzw. Kriterien erfüllt. Ausgaben in die PR-Beschreibung.
- [ ] Spec 13.7 an den Nutzer übergeben: manueller Test mit zwei Rechnern (Mac + Linux-PC) gegen `npm run dev` im LAN (`vite --host` ist schon an) oder gegen den Container.
- [ ] Follow-ups und Minor-Punkte nach `docs/superpowers/notes/2026-11-15-plan-2-followups.md`.
