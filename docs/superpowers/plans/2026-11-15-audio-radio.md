# Ton & Autoradio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Autoradio mit drei Kölner Live-Streams (Standard Radio Köllefornia) plus Schritt-, Fahr- und Stadtgeräusche aus CC0-Aufnahmen.

**Architecture:** Neues Modul `apps/client/src/audio/`. Reine, getestete Logik (Senderwahl, Drehzahlmodell, Geräusch-Auslöser) liegt getrennt von einer dünnen Browser-Schicht (`AudioContext` für Effekte, `HTMLAudioElement` für Streams). `Game` meldet Ereignisse (ein-/aussteigen, Schritt, Aufprall …) an ein `GameAudio`-Objekt, das alles verdrahtet.

**Tech Stack:** TypeScript, Web Audio API (nativ, keine neue Abhängigkeit), Three.js (bestehend), vitest, Playwright (bestehend, `scripts/drive-check.mjs`).

**Spec:** `docs/superpowers/specs/2026-11-15-audio-radio-design.md`

## Global Constraints

- Sender (Reihenfolge, Name, URL – exakt):
  1. `koellefornia` · „Radio Köllefornia“ · `https://stream.radio-koellefornia.de/listen/radio_koellefornia/radio.mp3`
  2. `radiokoeln` · „Radio Köln“ · `https://stream.lokalradio.nrw/444z7j4`
  3. `einslive` · „1LIVE“ · `https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3`
- Radio läuft **nur** über `HTMLAudioElement` (Köllefornia sendet kein CORS → `MediaElementSource` wäre stumm). Nie über Web Audio routen, kein `crossOrigin` setzen.
- Tasten: **R** = nächster Sender (nur im Auto), Mausrad = vor/zurück (nur im Auto), **N** = gesamter Ton an/aus (M bleibt frei für die spätere Karte). E/F/Q/P bleiben unverändert, M nicht belegen.
- HUD-Texte (exakt): Sendername wie oben, „Radio aus“, „Sender nicht erreichbar“, „Ton aus“, „Ton an“.
- `CONTROLS_HINT` (exakt): `WASD laufen · Shift rennen · Leertaste springen · E ein-/aussteigen · R Radio · N Ton · Maus umsehen (klicken)`
- Audiodateien: nur CC0, unter `apps/client/public/audio/`, jede in `apps/client/public/audio/CREDITS.md` (Datei, Quelle-URL, Autor, Lizenz „CC0 1.0“). Keine Sonniss-/„royalty-free“-Pakete. Keine Synthese als Ersatz für Aufnahmen.
- Keine neuen npm-Abhängigkeiten.
- Kein Ton vor der ersten Nutzeraktion; ein abgelehntes `play()` darf nie eine unbehandelte Promise-Rejection werfen.

## Review Focus

1. **Einsteigen, bevor Audio entsperrt ist** (nur Tastatur, nie geklickt): `play()` wird abgelehnt → kein Fehler, Radio startet beim ersten Entsperren nach, solange man noch im Auto sitzt. → Test in Task 3 (`retries play after unlock`).
2. **R schnell mehrfach drücken:** immer nur ein Stream; verspätete `error`/`playing`-Events des vorherigen Senders werden ignoriert. → Test in Task 3 (`stale events of a previous station are ignored`).
3. **Aussteigen während der Stream noch verbindet:** danach darf nichts mehr spielen; das alte Element hat `src` leer. → Test in Task 3 (`stop during connect leaves nothing playing`).
4. **Mausrad/R beim Laufen:** keine Wirkung, auch nicht nachträglich beim Einsteigen. → Test in Task 2 (`input while walking changes nothing`) und Task 7 (Wheel-Delta wird im Laufmodus verworfen).
5. **Stumm (N) und dann einsteigen:** Radio startet stumm, N hebt es auf; Tab im Hintergrund während man läuft startet beim Zurückkehren kein Radio. → Tests in Task 3 (`muted carries over to a new station`) und Task 7 (`visibility resume only in car`).

---

### Task 1: CC0-Aufnahmen beschaffen und Sound-Katalog

**Files:**
- Create: `apps/client/public/audio/*.ogg` (Liste unten), `apps/client/public/audio/CREDITS.md`
- Create: `apps/client/src/audio/sounds.ts`
- Test: `apps/client/src/audio/sounds.test.ts`

**Interfaces:**
- Produces: `export const SOUNDS: Record<SoundId, { file: string; loop: boolean; rpm?: number }>` und `export type SoundId = 'step1'|'step2'|'step3'|'step4'|'land'|'doorOpen'|'doorClose'|'engineStart'|'engineStop'|'engineIdle'|'engineMid'|'engineHigh'|'skid'|'impact1'|'impact2'|'impact3'|'ambience'|'tramBell'|'static'`; `export const ENGINE_LOOPS: SoundId[]` (die tatsächlich vorhandenen Motor-Loops, aufsteigend nach `rpm`).

Benötigte Aufnahmen (Dateiname = `<id>.ogg`, kebab-case: `step-1.ogg` … `tram-bell.ogg`):
- 4 Schritte auf Pflaster/Asphalt (Straßenschuh), je eine einzelne Schrittaufnahme, < 0.4 s
- Landung (dumpfer Doppelschritt), Autotür auf, Autotür zu, Motorstart, Motor aus
- Motor-Loops, nahtlos, aufgenommen bei bekannter/geschätzter Drehzahl (`rpm` im Katalog eintragen): Leerlauf (~800), mittel (~3000), hoch (~5000), möglichst vom selben Auto. Rückfall laut Spec: fehlen mid/high, nur `engineIdle` (+ ggf. einer) – dann diese Einträge aus `SOUNDS`/`ENGINE_LOOPS` weglassen und `SoundId` entsprechend kürzen.
- Reifenquietschen als Loop, 3 Aufprall-Schläge (Blech, verschieden stark)
- Nächtliche Stadtkulisse als nahtloser Loop (≥ 60 s, fernes Verkehrsrauschen, keine Stimmen im Vordergrund)
- Straßenbahn-Klingel (KVB-artiges „Bimmeln“, einzelnes Signal)
- Radio-Rauschen (Sendersuche/Static) als Loop

Quellen: Freesound (Suchfilter Lizenz CC0; HQ-MP3-Vorschau `previews.freesound.org/...-hq.mp3` ohne Login), Kenney (kenney.nl, alle CC0), OpenGameArt (Lizenzfilter CC0). Schneiden/konvertieren mit `ffmpeg` nach OGG Vorbis q5, Mono für Effekte, Stereo für Kulisse; Loops an Nulldurchgängen schneiden, Stille trimmen, Pegel normalisieren (Effekte −3 dBFS Peak).

- [ ] **Step 1: Write the failing test** `sounds.test.ts`:
  - `every catalogued file exists`: für jedes `SOUNDS[id].file` existiert `apps/client/public/audio/<file>` (via `node:fs` relativ zu `import.meta.dirname`).
  - `every file is credited as CC0`: `CREDITS.md` enthält für jede Datei eine Zeile mit dem Dateinamen und `CC0`.
  - `engine loops are ordered by rpm`: `ENGINE_LOOPS.length >= 1`, alle haben `loop: true` und `rpm`, aufsteigend.
- [ ] **Step 2:** `npx vitest run apps/client/src/audio/sounds.test.ts` → FAIL (Modul fehlt).
- [ ] **Step 3:** Aufnahmen suchen, Lizenz auf der Quellseite prüfen, herunterladen in ein eigenes Scratch-Verzeichnis, schneiden, nach `public/audio/` schreiben; `CREDITS.md` als Tabelle; `sounds.ts` anlegen.
- [ ] **Step 4:** Test → PASS. Zusätzlich Gesamtgröße notieren (`du -sh apps/client/public/audio`) – kein Limit, nur fürs Protokoll.
- [ ] **Step 5: Commit** `feat(audio): CC0 sound set with credits`

---

### Task 2: Senderwahl (reine Logik)

**Files:**
- Create: `apps/client/src/audio/stations.ts`
- Test: `apps/client/src/audio/stations.test.ts`

**Interfaces:**
- Produces:
  - `export type StationId = 'koellefornia' | 'radiokoeln' | 'einslive'`
  - `export const STATIONS: readonly { id: StationId; name: string; url: string }[]` (Werte aus Global Constraints)
  - `export class RadioTuner { readonly current: StationId | null; inCar: boolean; enterCar(): StationId | null; exitCar(): void; next(): StationId | null; prev(): StationId | null }`
  - `export const stationLabel = (s: StationId | null): string` → Name oder „Radio aus“

Verhalten: Zyklus `koellefornia → radiokoeln → einslive → null → koellefornia`; `prev` umgekehrt. Startzustand `koellefornia`. `enterCar()` setzt `inCar` und liefert den gemerkten Zustand (auch `null`). `next/prev` außerhalb des Autos: keine Änderung, Rückgabe `current`.

- [ ] **Step 1: Write the failing tests:**
  - `first entry plays Köllefornia`: `new RadioTuner().enterCar()` → `'koellefornia'`.
  - `R cycles through all stations and off`: nach `enterCar()` liefert `next()` viermal `'radiokoeln','einslive',null,'koellefornia'`.
  - `wheel back from Köllefornia is off`: `prev()` → `null`, nochmal → `'einslive'`.
  - `remembers last choice across cars, including off`: `enterCar(); next(); exitCar(); enterCar()` → `'radiokoeln'`; dasselbe mit Zustand `null` → `null`.
  - `input while walking changes nothing`: ohne `enterCar()` `next()` → `'koellefornia'`, `current` unverändert; nach `exitCar()` ebenso.
  - `labels`: `stationLabel('einslive')` → `'1LIVE'`, `stationLabel(null)` → `'Radio aus'`.
- [ ] **Step 2:** `npx vitest run apps/client/src/audio/stations.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(audio): radio tuner state`

---

### Task 3: Radio-Player (Stream-Steuerung)

**Files:**
- Create: `apps/client/src/audio/radio.ts`
- Test: `apps/client/src/audio/radio.test.ts`

**Interfaces:**
- Consumes: `STATIONS`, `StationId` (Task 2)
- Produces:
  - `export type StreamElement = Pick<HTMLAudioElement, 'src'|'muted'|'volume'|'play'|'pause'|'load'|'removeAttribute'|'addEventListener'>`
  - `export class Radio { constructor(make: () => StreamElement, events: { onConnecting(): void; onPlaying(): void; onUnreachable(): void }); tune(id: StationId | null): void; setMuted(m: boolean): void; unlocked(): void; suspend(): void; resume(): void; readonly playing: StationId | null }`
  - Konstante `RADIO_VOLUME = 0.8`.

Verhalten:
- `tune(id)`: altes Element stoppen (`pause()`, `removeAttribute('src')`, `load()`), für jeden Sender ein **neues** Element (so können verspätete Events per Generationszähler verworfen werden), `src = url`, `volume = RADIO_VOLUME`, `muted` übernehmen, `play()` mit `.catch` → merkt „wartet auf Freischaltung“. Ruft `onConnecting()` (Rauschen an) bis `playing`-Event → `onPlaying()` (Rauschen aus). `tune(null)` = nur stoppen.
- `error`/`stalled`-Abbruch: genau ein Neuversuch (neues Element, gleicher Sender); zweiter Fehler → `onUnreachable()`, `playing = null`, aber Auswahl bleibt beim Tuner (Task 2 merkt sie).
- `unlocked()`: wenn ein Sender gewählt ist und `play()` abgelehnt wurde → erneut `play()`.
- `suspend()`: stoppen wie oben, Sender merken; `resume()`: diesen neu tunen (nur wenn vorher etwas lief).
- `setMuted`: setzt `muted` am aktuellen Element, gilt auch für künftige.

- [ ] **Step 1: Write the failing tests** mit einem Fake-`StreamElement` (zeichnet `src`, `play`-Aufrufe, Listener auf; `play` gibt steuerbare Promise zurück; Test kann `'playing'`/`'error'` feuern):
  - `tuning sets the station url and plays`: `tune('koellefornia')` → aktuelles Fake hat Köllefornia-URL, `play` 1×, `onConnecting` 1×; Event `playing` → `onPlaying` 1×, `radio.playing === 'koellefornia'`.
  - `switching stops the previous stream`: `tune('koellefornia'); tune('einslive')` → erstes Fake: `pause` aufgerufen, `src` leer (`removeAttribute('src')`); genau ein Element ohne leeres `src`.
  - `stale events of a previous station are ignored`: nach Wechsel feuert erstes Fake `error` und `playing` → keine Callbacks, kein Neuversuch.
  - `stop during connect leaves nothing playing`: `tune('radiokoeln'); tune(null)`, danach löst erste `play`-Promise auf → `radio.playing === null`, kein `onPlaying`.
  - `one retry, then unreachable`: `error` → neues Element mit gleicher URL; zweites `error` → `onUnreachable` 1×, `playing === null`.
  - `retries play after unlock`: `play` rejected (`NotAllowedError`) → keine Exception; `unlocked()` → `play` erneut auf demselben Element.
  - `muted carries over to a new station`: `setMuted(true); tune('einslive')` → neues Fake `muted === true`; `setMuted(false)` → `false`.
  - `suspend/resume`: `tune('einslive'); suspend()` → gestoppt; `resume()` → neues Element mit 1LIVE-URL. `resume()` ohne vorheriges Spielen → kein Element.
- [ ] **Step 2:** `npx vitest run apps/client/src/audio/radio.test.ts` → FAIL.
- [ ] **Step 3:** Implementieren.
- [ ] **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(audio): live stream radio player`

---

### Task 4: Drehzahl- und Motor-Mix-Modell (reine Logik)

**Files:**
- Create: `apps/client/src/audio/engine-model.ts`
- Test: `apps/client/src/audio/engine-model.test.ts`

**Interfaces:**
- Produces:
  - `export const IDLE_RPM = 800, REDLINE_RPM = 6000`
  - `export const GEAR_TOP_KMH = [15, 30, 45, Infinity]` (Höchsttempo 60 km/h laut `TUNING.vehicle.maxForwardKmh`)
  - `export function engineTarget(kmh: number, throttle: number): { gear: number; rpm: number }` – `kmh` als Betrag; Rückwärts nutzt Gang 1.
  - `export function smoothRpm(current: number, target: number, dt: number): number` – exponentielles Annähern, Zeitkonstante 0.12 s hoch, 0.25 s runter.
  - `export function engineMix(rpm: number, loops: { rpm: number }[]): { gain: number; rate: number }[]` – je Loop.

Algorithmus `engineTarget`: Gang = erster Index mit `kmh < GEAR_TOP_KMH[i]`. Untergrenze `lo` = vorheriger Top (oder 0). Anteil `f = (kmh − lo)/(top − lo)` (für den letzten Gang `top = 60`), auf 0..1 begrenzt. Gang 1: `rpm = IDLE + f·(REDLINE−IDLE)`; höhere Gänge: `rpm = 2500 + f·(REDLINE−2500)`. Gas im Stand (`kmh < 2`, `throttle ≠ 0`): `rpm = max(rpm, 2200)`. Ohne Gas: `rpm = max(IDLE, rpm·0.85)`.

Algorithmus `engineMix`: zwischen den zwei benachbarten Loops (nach `rpm`) gleichleistungs-überblenden (`cos`/`sin` über den Anteil); unter dem tiefsten nur dieser, über dem höchsten nur dieser. `rate = clamp(rpm / loop.rpm, 0.5, 2.0)`. Summe der Gain-Quadrate = 1.

- [ ] **Step 1: Write the failing tests:**
  - `idle at standstill`: `engineTarget(0, 0)` → `{ gear: 0, rpm: 800 }`.
  - `revving in place`: `engineTarget(0, 1).rpm` → `2200`.
  - `rpm rises within a gear and drops at the shift`: `engineTarget(14, 1).rpm > 5000`; `engineTarget(16, 1).gear === 1` und `rpm < 3500`.
  - `top speed is near redline in top gear`: `engineTarget(60, 1)` → `gear 3`, `rpm` ≈ 6000 (±1).
  - `smoothRpm converges`: 2 s mit dt 1/60 von 800 Richtung 5000 → > 4900; kein Überschießen.
  - `single loop mix`: `engineMix(1600, [{rpm: 800}])` → `[{ gain: 1, rate: 2 }]`.
  - `crossfade halfway`: `engineMix(1900, [{rpm:800},{rpm:3000}])` → beide Gains ≈ 0.707, Summe der Quadrate 1.
  - `clamps rate`: `engineMix(6000, [{rpm: 800}])[0].rate` → `2`.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(audio): engine rpm model and loop mix`

---

### Task 5: Geräusch-Auslöser (reine Logik)

**Files:**
- Create: `apps/client/src/audio/cues.ts`
- Test: `apps/client/src/audio/cues.test.ts`

**Interfaces:**
- Produces:
  - `export class StepClock { update(groundSpeed: number, grounded: boolean, dt: number): boolean }` – true, wenn ein Schritt fällig ist. Schrittlänge 0.75 m bei ≤ 3 m/s, sonst 1.5 m (wie `PlayerFigure`: ein Schritt pro halbem Animationszyklus). Unter 0.3 m/s kein Schritt; Distanz-Akku zurücksetzen, wenn nicht am Boden.
  - `export function landed(wasGrounded: boolean, grounded: boolean, airTime: number): boolean` – true bei Übergang Luft→Boden nach > 0.25 s Luft.
  - `export class ImpactDetector { update(vx: number, vz: number, dt: number): number }` – Stärke 0..1 bei plötzlichem Geschwindigkeitsverlust: `dv = |v_prev − v|` (Vektor), Ereignis wenn `dv/dt > 25 m/s²` (über normaler Bremsung von ~11 m/s²). Stärke `clamp(dv / 8, 0.15, 1)`; danach 0.4 s Sperre.
  - `export function skidAmount(forwardSpeed: number, lateralSpeed: number, handbrake: boolean): number` – 0..1: `clamp((|lateral| − 1.5) / 4, 0, 1)`; bei Handbremse und `|forward| > 3` mindestens `clamp(|forward|/12, 0, 1)`.
  - `export class TramBell { constructor(rand: () => number); update(dt: number, distToStop: number): boolean }` – nur wenn `distToStop < 80`; nächste Klingel nach `60 + rand()·120` s (Timer läuft nur in Reichweite).
- [ ] **Step 1: Write the failing tests:**
  - `walking 3 m makes 4 steps`: 1.5 m/s, 2 s in dt 1/60 → 4 `true`.
  - `running steps are spaced 1.5 m`: 5 m/s, 3 s → 10.
  - `no steps in the air or standing still`.
  - `landing after a jump, not after a kerb hop`: `landed(false, true, 0.5)` true, `landed(false, true, 0.1)` false.
  - `hard stop is an impact, braking is not`: v 12→0 in einem Schritt dt 1/60 → Stärke 1; v sinkt mit 11 m/s² → immer 0; zweiter Schlag innerhalb 0.4 s → 0.
  - `skid`: `skidAmount(10, 0, false)` 0; `skidAmount(10, 5.5, false)` 1; `skidAmount(12, 0, true)` 1; `skidAmount(2, 0, true)` 0.
  - `tram bell`: mit `rand = () => 0` erste Klingel nach genau 60 s in Reichweite; außerhalb 80 m nie.
- [ ] **Step 2:** → FAIL. **Step 3:** Implementieren. **Step 4:** → PASS.
- [ ] **Step 5: Commit** `feat(audio): footstep, landing, impact, skid and tram bell cues`

---

### Task 6: Mixer und Fahrzeug-Stimme (Browser-Schicht)

**Files:**
- Create: `apps/client/src/audio/mixer.ts`, `apps/client/src/audio/vehicle-sound.ts`
- Test: `apps/client/src/audio/vehicle-sound.test.ts`

**Interfaces:**
- Consumes: `SOUNDS`, `ENGINE_LOOPS`, `SoundId` (Task 1); `engineTarget`, `smoothRpm`, `engineMix` (Task 4)
- Produces:
  - `export class AudioMixer { constructor(base = '/audio/'); unlock(): Promise<void>; load(): Promise<void>; setMuted(m: boolean); setInCar(inCar: boolean); oneShot(id: SoundId, o?: { gain?: number; rate?: number; at?: { x: number; z: number } }): void; loop(id: SoundId, bus: 'sfx'|'ambience'): LoopVoice; setListener(x: number, z: number, yaw: number): void }`
  - `export interface LoopVoice { setGain(g: number): void; setRate(r: number): void; stop(): void }`
  - `export class VehicleSound { constructor(out: { loop(id: SoundId): LoopVoice }); start(): void; stop(): void; update(s: { speed: number; throttle: number; skid: number }, dt: number): void }`

Mixer: ein `AudioContext`, erstellt in `unlock()` (beim ersten Klick/Tastendruck) bzw. `resume()`; Busse `master → destination`, `sfx → master`, `ambience → lowpass(BiquadFilter) → master`. `setInCar(true)`: Ambience-Gain 0.35, Tiefpass 700 Hz; `false`: Gain 1, Tiefpass 20 kHz (je über 0.3 s rampen). `load()` dekodiert alle `SOUNDS` parallel (fetch + `decodeAudioData`); fehlende Dateien loggen, nicht abbrechen. `oneShot` mit `at` nutzt einen `PannerNode` (HRTF, `refDistance` 5) relativ zum Listener. `oneShot`/`loop` vor dem Entsperren: stillschweigend nichts / stumme Stimme. Lautstärkekonstanten an einer Stelle (`MIX` in `mixer.ts`): steps 0.5, land 0.6, doors 0.8, engine 0.55, skid 0.6, impact 0.9, ambience 0.4, tramBell 0.7, static 0.25.

VehicleSound: hält eine Stimme je `ENGINE_LOOPS`-Eintrag und eine `skid`-Stimme; `update` → `engineTarget` → `smoothRpm` → `engineMix` → `setGain(mix.gain·MIX.engine)`/`setRate`; Skid-Gain `skid·MIX.skid` mit Rate `0.9 + 0.2·skid`. `stop()` stoppt alle Stimmen. Bezieht nur Fahrzeugzustand, keine Tastatur (Multiplayer-tauglich laut Spec).

- [ ] **Step 1: Write the failing tests** (`vehicle-sound.test.ts`, Fake-`out` zeichnet Gains/Raten je Stimme auf):
  - `idle after start`: `start(); update({speed:0, throttle:0, skid:0}, 1/60)` 60× → tiefste Motorstimme Gain > 0, Rate ≈ 1.
  - `revs up with speed`: 3 s bei 14 m/s (≈ 50 km/h) → Rate der aktiven Stimme / Gains verschoben zu höheren Loops (bzw. bei einem Loop Rate > 1.5).
  - `skid voice follows skid`: `skid: 1` → Skid-Gain 0.6; `skid: 0` → 0.
  - `stop silences all voices`: nach `stop()` wurde `stop` auf jeder Stimme aufgerufen.
- [ ] **Step 2:** → FAIL. **Step 3:** `vehicle-sound.ts` und `mixer.ts` implementieren (`mixer.ts` ohne Unit-Test; wird in Task 8 im Browser geprüft). **Step 4:** → PASS, plus `npm run typecheck` grün.
- [ ] **Step 5: Commit** `feat(audio): web audio mixer and per-vehicle engine voice`

---

### Task 7: GameAudio verdrahten (Game, Input, HUD, main)

**Files:**
- Create: `apps/client/src/audio/game-audio.ts`
- Test: `apps/client/src/audio/game-audio.test.ts`
- Modify: `apps/client/src/game.ts` (`getIn`, `getOut`, `frame`, `render`), `apps/client/src/input.ts` (Mausrad), `apps/client/src/hud.ts` (`CONTROLS_HINT`), `apps/client/src/main.ts` (Erzeugung, Entsperren, `visibilitychange`, `__nnState`), `packages/shared/src/physics/character.ts` (öffentliches `isGrounded(): boolean`), `apps/client/src/input.test.ts`, `apps/client/src/hud.test.ts`

**Interfaces:**
- Consumes: alles aus Task 1–6.
- Produces:
  - `Input.wheel(deltaY: number): void` und `Input.takeWheel(): number` (Summe der Rastungen seit letztem Aufruf: `+1` je `deltaY > 0`, `−1` je `< 0`); `attachInput` registriert `wheel` am Fenster (passiv), nur bei Pointer-Lock.
  - `Character.isGrounded(): boolean`
  - `export class GameAudio { constructor(deps: { mixer: AudioMixerLike; radio: RadioLike; tuner: RadioTuner; flash(text: string): void; rand?: () => number }); unlock(): void; toggleMute(): void; setHidden(hidden: boolean): void; enterCar(): void; exitCar(): void; radioStep(dir: 1 | -1): void; walk(s: { speed: number; grounded: boolean; airTime: number }, dt: number): void; drive(s: { forward: number; lateral: number; vx: number; vz: number; throttle: number; handbrake: boolean }, dt: number): void; listener(x: number, z: number, yaw: number, nearestTramStop: { x: number; z: number; dist: number } | null, dt: number): void; readonly station: StationId | null }`
  - `AudioMixerLike`/`RadioLike` = die von `GameAudio` genutzten Methoden von `AudioMixer`/`Radio` (für Tests).
  - `window.__nnState()` ergänzt um `radio: StationId | null` (aktuell gewählter Sender, `null` beim Laufen).

Verhalten `GameAudio`:
- `enterCar`: `doorOpen`, nach 0.35 s `doorClose`, `engineStart`, dann `VehicleSound.start()`; `mixer.setInCar(true)`; `radio.tune(tuner.enterCar())`; HUD-Flash `stationLabel(...)`.
- `exitCar`: `radio.tune(null)`, `tuner.exitCar()`, `VehicleSound.stop()`, `engineStop`, `doorOpen`+`doorClose`, `setInCar(false)`.
- `radioStep(dir)`: nur im Auto; `tuner.next()/prev()` → `radio.tune` → Flash Label. Radio-Callbacks: `onConnecting` startet `static`-Loop, `onPlaying`/`onUnreachable` stoppen ihn; `onUnreachable` flasht „Sender nicht erreichbar“.
- `toggleMute`: Mixer + Radio stumm, Flash „Ton aus“/„Ton an“.
- `setHidden(true)`: `radio.suspend()`, Mixer stumm (Kontext `suspend`); `false`: nur wenn im Auto `radio.resume()`; Mixer zurück auf vorherigen Mute-Zustand.
- `unlock`: `mixer.unlock()`, `radio.unlocked()`, Ambience-Loop starten (einmalig).
- `walk`: `StepClock` → zufälliger `step1..4` mit Rate `0.92 + 0.16·rand()`; `landed` → `land`.
- `drive`: `ImpactDetector(vx, vz)` → `impact1..3` nach Stärke (≥ 0.7 → `impact3`, ≥ 0.35 → `impact2`, sonst `impact1`), Gain = Stärke; `VehicleSound.update({ speed: forward, throttle, skid: skidAmount(forward, lateral, handbrake) })`.
- `listener`: `mixer.setListener`; `TramBell.update(dt, dist)` → `oneShot('tramBell', { at })`.

Änderungen in `Game`:
- Konstruktor nimmt optional `audio?: GameAudio` im `GameContext`.
- In `frame` (nicht im Flugmodus): `input.consume('KeyR')` → `audio.radioStep(1)`; `input.takeWheel()` → je Rastung `radioStep(±1)` **nur im Fahrmodus**, sonst verwerfen; `input.consume('KeyN')` → `toggleMute()` (auch im Flugmodus).
- `getIn`/`getOut` am Ende `audio.enterCar()`/`audio.exitCar()` (nur bei Erfolg, nicht bei „Erst anhalten“).
- In `render`: Laufmodus → `audio.walk({ speed, grounded: char.isGrounded(), airTime })` (Game führt `airTime`); Fahrmodus → Vorwärts-/Seitengeschwindigkeit aus `vehicle.chassis.linvel()` projiziert auf die Fahrzeugachsen (`headingOf(pose)`), `throttle = steer.forward`, `handbrake = input.brake()`. Danach `audio.listener(focus.x, focus.z, follow.yaw, nächste Haltestelle aus manifest.tramStops, dt)`.

`main.ts`: `AudioMixer`, `Radio` (Factory `() => new Audio()`), `RadioTuner`, `GameAudio` erzeugen; `mixer.load()` parallel zum Weltladen; `unlock` bei erstem `pointerdown` und erstem `keydown` (`{ once: true }` je); `document.visibilitychange` → `setHidden(document.hidden)`.

- [ ] **Step 1: Write the failing tests:**
  - `game-audio.test.ts` mit Fake-Mixer/Fake-Radio (zeichnen Aufrufe auf):
    - `entering starts Köllefornia and flashes its name`: `enterCar()` → `radio.tune('koellefornia')`, Flash „Radio Köllefornia“, OneShots enthalten `doorOpen`, `engineStart`.
    - `R cycles and flashes`: im Auto 4× `radioStep(1)` → Flashes `Radio Köln`, `1LIVE`, `Radio aus`, `Radio Köllefornia`; `radio.tune` zuletzt mit `'koellefornia'`.
    - `radio step on foot does nothing`: `radioStep(1)` ohne `enterCar` → kein `tune`, kein Flash.
    - `exit stops the radio`: `enterCar(); exitCar()` → letzter `tune(null)`, `station === null`.
    - `visibility resume only in car`: zu Fuß `setHidden(true); setHidden(false)` → kein `resume`; im Auto → `suspend` dann `resume`.
    - `mute toggles and flashes`: `toggleMute()` → Flash „Ton aus“, `radio.setMuted(true)`; nochmal → „Ton an“.
    - `unreachable flashes once`: Radio-Callback `onUnreachable` → Flash „Sender nicht erreichbar“, `static`-Stimme gestoppt.
  - `input.test.ts`: `takeWheel sums notches and resets`: `wheel(100); wheel(50); wheel(-30)` → `takeWheel() === 1`, danach `0`.
  - `hud.test.ts`: `CONTROLS_HINT` exakt wie in Global Constraints.
- [ ] **Step 2:** `npx vitest run apps/client/src` → neue Tests FAIL.
- [ ] **Step 3:** `GameAudio`, `Input.wheel/takeWheel`, `Character.isGrounded`, `CONTROLS_HINT`, Änderungen in `game.ts` und `main.ts` umsetzen.
- [ ] **Step 4:** `npm test` und `npm run typecheck` → alles grün.
- [ ] **Step 5: Commit** `feat(audio): car radio and game sounds wired into the game`

---

### Task 8: Prüfung im Browser

**Files:**
- Modify: `scripts/drive-check.mjs`

- [ ] **Step 1:** In `drive-check.mjs` nach dem Einsteigen prüfen: `window.__nnState().radio === 'koellefornia'`; `page.keyboard.press('KeyR')` → `'radiokoeln'`; nach dem Aussteigen `radio === null`. Chromium mit `--autoplay-policy=no-user-gesture-required` starten, damit `play()` nicht blockiert; zusätzlich prüfen, dass genau ein `<audio>`-Element mit nicht-leerem `src` existiert (`document.querySelectorAll` greift bei `new Audio()` nicht – stattdessen `__nnState` um `radioSrc` erweitern oder `Radio` legt Elemente unsichtbar in `document.body` ab; Builder wählt, Hauptsache prüfbar).
- [ ] **Step 2:** `npm run dev` im Hintergrund, dann `npm run drive-check` → PASS-Ausgabe inkl. Radio-Zeilen, keine Konsolenfehler/unbehandelten Rejections.
- [ ] **Step 3:** Manuelle Hörprobe dem Nutzer übergeben (Ton lässt sich nicht automatisch beurteilen): Checkliste – Einsteigen (Tür, Start, Köllefornia), R/Mausrad, Radio aus, N, Schritte gehen/rennen, Sprung, Vollgas/Bremsen/Handbremse, gegen Wand fahren, Haltestelle (Klingel kann bis 3 min dauern), Tab wechseln.
- [ ] **Step 4: Commit** `test(audio): drive-check covers the car radio`
