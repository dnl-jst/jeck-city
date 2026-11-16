# Nippes Nights – Mehrspieler (Plan 2) – Design

Stand: 2026-11-15 · Basis: `main` @ `e96e2b2` (Plan 1 + Korrekturrunde 1 + Ton/Radio, Scheinwerfer, Requisiten-Kollision, handgemachte Gebäude).
Umsetzung: später durch einen anderen Agenten auf einem anderen Rechner. Dieses Dokument ist dafür in sich geschlossen; es verweist auf Code im Repo, nicht auf Gesprächsverlauf.

Pflichtlektüre vor dem Planen:
- `docs/superpowers/specs/2026-11-15-nippes-nights-design.md` (Gesamtvision, Abschnitt „Mehrspieler (Version 1)“ = Nutzerentscheidungen)
- `docs/superpowers/notes/2026-11-15-plan-1-followups.md` (Abschnitt „Für Plan 2 beachten“)
- `docs/superpowers/specs/2026-11-15-audio-radio-design.md` (Motorstart, Radio, Radio-Rad)
- `apps/client/src/game.ts` (heutige Spielschleife), `packages/shared/src/physics/*` (gemeinsame Physik)

---

## 1. Absicht

Alle Besucher der Seite („Lück“) sind gleichzeitig in Nippes. Man gibt einen Namen ein, spawnt auf der Neusser Straße und sieht alle anderen – zu Fuß und in Autos. Man kann sich anrempeln, mit Autos zusammenstoßen, Laternen umfahren; alle sehen dasselbe Ergebnis. Die eigene Figur und das eigene Auto reagieren trotzdem sofort auf die Tasten.

## 2. Bereits entschieden (Nutzer, verbindlich)

- Ablauf: Seite öffnen → Namen eingeben → Spiel lädt → Spawn auf der Neusser Straße.
- Echte Kollisionen zwischen Spielern (zu Fuß und im Auto); **der Server ist Schiedsrichter**.
- Eigener Node-Server mit **Colyseus**, **kein Cloudflare, kein Next.js**. Ein gemeinsamer Raum „Nippes“.
- Ausgelegt auf **100 gleichzeitige Spieler**; mehr Last wird durch einen stärkeren Server gelöst, nicht durch Umbau. Der Nutzer stellt den Server bereit.
  - **Nachtrag 2026-11-16:** Ziel 60 Spieler pro Server auf 2 vCPU; 100 benötigen einen schnelleren Einzelkern, die Physik läuft single-threaded (Lasttest: `docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md`). Standard `MAX_PLAYERS` = 60, per Umgebungsvariable bis 100.
- Bezeichnung „Lück“/„Besucher“, keine Accounts, nichts wird gespeichert.
- Tag/Nacht folgt der lokalen Uhrzeit des jeweiligen Besuchers (bleibt clientseitig, wird nicht synchronisiert).

## 3. Ziele / Nicht-Ziele / Anti-Ziele

**Ziele**
- Namenseingabe, Beitreten, Verlassen, kurze Verbindungsabbrüche überstehen.
- Andere Spieler zu Fuß (Figur + Name) und im Auto (Auto + Name, Licht, Motorzustand) sehen, flüssig interpoliert.
- Server-autoritative Physik für Spieler, alle Autos (auch geparkte) und Laternen; Client-Vorhersage für die eigene Figur / das eigene Auto mit Abgleich.
- Zusammenstöße: Fußgänger schubsen sich; Auto trifft Fußgänger → er wird weggestoßen, fällt kurz hin, steht nach ~1 s wieder auf; Autos prallen voneinander ab; umgefahrene Laternen liegen für alle.
- 100 Spieler auf einem 2-vCPU-Server, nachgewiesen per Bot-Lasttest.
  - **Nachtrag 2026-11-16:** Ziel 60 Spieler pro Server auf 2 vCPU; 100 benötigen einen schnelleren Einzelkern, die Physik läuft single-threaded.
- Ein Deployment-Artefakt (Docker-Image) + Anleitung.

**Nicht-Ziele (diese Version)**
- Chat, Emotes, Accounts, Bestenlisten, gespeicherte Spielstände.
- Mehrere Räume/Instanzen, Server-Sharding, Matchmaking über mehrere Server.
- Beifahrer (ein Auto = ein Fahrer).
- Schaden, Verletzungen, Waffen, Polizei.
- Mobile/Touch.
- Anti-Cheat über Plausibilität hinaus.

**Anti-Ziele (Fehlschlag, auch wenn es „funktioniert“)**
- Eigene Figur/eigenes Auto fühlt sich träge an oder springt sichtbar bei normaler Latenz (≤ 150 ms RTT).
- Andere Spieler ruckeln oder teleportieren regelmäßig.
- Ein Spieler kann andere per manipuliertem Client teleportieren, unsichtbar machen oder den Server abstürzen lassen.
- Die Einzelspieler-Qualität (Optik, Ton, Fahrgefühl) wird schlechter.

## 4. Ausgangslage im Code (main @ e96e2b2) – was Plan 2 vorfindet

- **Gemeinsame Physik** (`packages/shared/src/physics`): `createPhysicsWorld(collision)` (Rapier 0.21.0, genau eine Kopie, Versionsprüfung), `Character` (kinematischer Character-Controller, Eingabe `{forward,right,run,yaw,jump}`, `teleport`, `setEnabled`, `dispose`), `Vehicle` (Raycast-Fahrzeug, Eingabe `{throttle,steer,brake}`, `pose()`, `setOccupied`, `dispose`, `chassis`), `StreetProps` (Bäume fest, Laternen kippen bei schnellem Aufprall, `takeFallen`, `lampPose`), `FixedStepper` (1/60 s, max. 5 Schritte), `TUNING`, `staticWorldFilter`, Kollisionsgruppen `PROP_GROUPS`/`CAR_GROUPS`. DOM-frei, läuft in Node. Fester Zeitschritt `TUNING.world.dt = 1/60`; `applyInput` nimmt **keinen** dt-Parameter.
- **Spielschleife** (`apps/client/src/game.ts`, Klasse `Game`): mischt heute Simulation (Eingabe → `stepper.advance` → `pw.step()`), Darstellung (Figur, Auto, Kamera, Glare), Ton (`GameAudio`), Zündung (`Ignition`: Tür → Anlasser → läuft; Gas/Radio/Licht erst bei „running“), Radio-Rad.
- **Geparkte Autos** (`apps/client/src/car.ts`, `ParkedCars`): ~2600 aus `manifest.parked`, instanziert gerendert (Distanz-Culling 250 m), Physik-Fahrzeuge nur ≤ 150 m um den Spieler, verschobene Posen in `poses[]` clientseitig gemerkt.
- **Requisiten**: Bäume (`manifest.trees`, ~3300) und Laternen (`manifest.lamps`, ~2640) haben in `StreetProps` Rapier-Körper; die Darstellung (`apps/client/src/props.ts`) cullt nur das Rendern.
- **Assets**: `apps/client/public/world/manifest.json`, `collision.bin` (NNC2, quantisiert), Chunk-GLBs, `model_*.glb` (handgemachte Gebäude, deren `*_col`-Knoten in `collision.bin` eingeflossen sind).
- **Bekannte Plan-2-Hinweise** aus den Follow-ups: Determinismus nur bei gleicher Erzeugungsreihenfolge (nicht der `-deterministic`-Build von Rapier; `Math.sin/cos` können zwischen JS-Engines im letzten Bit abweichen) → Abgleich nötig, keine Bit-Gleichheit annehmen. Auto bleibt heute an einer Person „stehen“ (kinematische Figur) → in Plan 2 lösen (siehe 8.4). Dev-Hooks (`?cam`, `?time`, `?date`, `window.__nn*`) sind ohne `?debug=1` aktiv → im Mehrspieler sperren (siehe 12).

## 5. Gelände-Höhen (läuft parallel, anderer Agent)

Ein anderer Agent setzt gerade **Geländehöhen** um (Nippes ist nicht mehr flach). Dessen Ergebnis ist zum Zeitpunkt dieses Dokuments nicht im Repo. Plan 2 muss darauf aufbauen und darf **keine flache Welt annehmen**.

**Vorgehen für den Umsetzer:**
1. Vor dem Planen prüfen, ob die Gelände-Arbeit in `main` gelandet ist (Commits/Spec zu „terrain“/„Gelände“). Falls ja: auf diesem Stand planen und die dort definierten Schnittstellen nutzen. Falls nein: mit dem Nutzer klären, ob gewartet oder auf flachem Stand begonnen wird; die unten genannten Stellen dann trotzdem höhenneutral bauen.
2. **Vertrag, den Plan 2 voraussetzt** (vom Umsetzer gegen den tatsächlichen Gelände-Stand zu verifizieren):
   - Die Bodenfläche ist Teil der statischen Kollision, die `createPhysicsWorld` aus den ausgelieferten Assets baut (Trimesh in `collision.bin` oder ein zusätzliches Heightfield-Asset). Server und Client bauen die Welt aus **denselben Dateien** mit **derselben Funktion**.
   - Die Höhe an einem Punkt ergibt sich aus der Kollision (`surfaceY` per Raycast) oder aus manifest-Feldern; nie aus Konstanten.
3. **Heute flache Annahmen, die Plan 2 nicht übernehmen darf** (falls die Gelände-Arbeit sie nicht schon behebt):
   - `StreetProps`: Bäume/Laternen bei `setTranslation(x, 0, z)`.
   - `ParkedCars`/`Vehicle`: Spawn bei `y = VEHICLE_REST_Y` (über y = 0).
   - `Game.exitFree`: `car.y - VEHICLE_REST_Y` als Bodenhöhe.
   - Spawn-Höhe: heute `surfaceY(..., 3)` – Startstrahl ggf. höher legen.
   Die Server-Simulation (Abschnitt 6) erzeugt Requisiten und Autos mit Bodenhöhe aus Manifest oder Raycast, identisch auf Server und Client.

## 6. Architektur

### 6.1 Pakete

```
packages/shared/src/sim/      NEU – Simulation ohne Darstellung (Server + Client-Vorhersage)
packages/shared/src/net/      NEU – Protokoll: Nachrichtentypen, Konstanten, Quantisierung, Namensregeln
apps/server/                  NEU – @nn/server: Colyseus-Server, statische Auslieferung, Bots, Lasttest
apps/client/                  angepasst: Lobby/Namensdialog, Netzwerk-Client, Vorhersage, entfernte Entitäten
```

- **`@nn/shared/sim`**: Klasse `WorldSim` besitzt die `PhysicsWorld`, alle Spieler-Charaktere, alle Fahrzeuge (geparkte = Entitäten mit Zustand), `StreetProps`, Spielregeln (Ein-/Aussteigen, Zündungs-Zeitplan, Knockdown, Laternen) und einen `step(inputs: Map<PlayerId, PlayerInput>)` im festen Takt. Kein Three.js, kein DOM, kein `Math.random` (Zufall nur über geseedeten PRNG), keine Wanduhr. Die heutige Logik aus `Game` (Ein-/Aussteigen mit `nearestEnterableCar`, `canGetOut`, `exitSpot`/`exitFree`, Zündungs-Zeitplan aus `Ignition` ohne Tonereignisse) wandert hierher; `Game` im Client wird zur Darstellungs-/Eingabeschicht über `WorldSim` (Einzelspieler = lokale `WorldSim` ohne Netz).
- **`@nn/shared/net`**: Nachrichtenschemata, Protokollversion, Quantisierung, Namensvalidierung/-filter, Konstanten (Tick, Snapshot-Rate, Interessenradien).
- **`@nn/server`**: Node 24, Colyseus (aktuelle stabile Version, exakt gepinnt), lädt dieselben Assets aus `apps/client/public/world/` bzw. dem Build, führt die autoritative `WorldSim`, liefert den gebauten Client statisch aus (gleiche Origin, gleicher Port), Gesundheits-Endpunkt `/healthz`.

### 6.2 Takt

- Server-Simulation **60 Hz** (`TUNING.world.dt`, unverändert – das Fahrgefühl ist darauf abgestimmt; die „ca. 30 Hz“ der alten Spec werden hiermit ersetzt).
- Snapshots an Clients **20 Hz**, Client-Eingaben **60 Hz** (gebündelt bis zu 3 pro Paket).
- Client rendert mit beliebiger Bildrate; eigene Vorhersage 60 Hz über `FixedStepper`.

### 6.3 Zustand und Nachrichten (Vorschlag; Encoding dem Umsetzer überlassen, Felder verbindlich)

**Langsamer Zustand** (Colyseus-Schema mit pro-Client-Sicht/StateView, Delta-kodiert):
- Spielerliste: `id`, `name`, `mode` (walk/drive/down), `carId | null`.
- Autos (nur abweichend vom Manifest): `id` (= Index in `manifest.parked`), `driverId | null`, `engine` (off/starting/running), `lights` (0..1 Leistung), `radio` (Sender-ID oder null, siehe offene Frage 1).
- Laternen: gefallene Indizes mit Endpose, sobald in Ruhe.

**Schneller Zustand** (eigene Binärnachricht `snapshot`, 20 Hz, nur Entitäten im Interessenbereich):
- `serverTick`, `ackSeq` (letzte verarbeitete Eingabe dieses Clients).
- Eigener Spieler: volle Physik-Zustandsdaten für den Abgleich (Position, Geschwindigkeit, ggf. Bodenkontakt/Knockdown-Zeit; im Auto: Chassis-Pose, lineare und Winkelgeschwindigkeit).
- Andere Spieler zu Fuß: Position (cm-quantisiert), Blickrichtung (16 bit), Bewegungsgeschwindigkeit (für Laufanimation), Zustand (stehend/laufend/gefallen).
- Bewegte Autos (fahrend oder durch Stoß wach): Pose (Position cm, Quaternion 16 bit/Komponente oder „smallest three“), Geschwindigkeit, Lenkwinkel, Bremslicht.
- Kippende Laternen: Pose, bis sie ruhen.

**Client → Server**: `input { seq, tick, forward, right, run, yaw, jump, brake, use(E), radioCmd? }` (Werte geklemmt/quantisiert), `join { name, protocolVersion, buildId }`.

### 6.4 Interessenbereich

- Spieler und bewegte Autos ≤ **250 m** (gleich Render-Radius) mit Hysterese 270 m.
- Ruhende geparkte Autos werden nie gestreamt – sie kommen aus dem Manifest; nur „verschobene“ (Pose ≠ Manifest) werden beim Eintritt in den Bereich einmal mit Endpose übertragen.
- Ziel-Bandbreite: ≤ 50 KB/s pro Client bei 100 Spielern auf engem Raum.

## 7. Client-Vorhersage und Abgleich

- **Eigene Figur**: Client simuliert mit derselben `Character`-Logik voraus; behält Ringpuffer der unbestätigten Eingaben. Bei Snapshot: eigenen Zustand auf Server-Stand bei `ackSeq` setzen (`teleport` + Geschwindigkeit), unbestätigte Eingaben erneut anwenden (nur eigene Figur; andere Entitäten als kinematische Hindernisse auf ihrer zuletzt bekannten/interpolierten Pose). Rest-Fehler sichtbar über ~100 ms ausblenden (Render-Offset), nicht springen; ab > 2 m Fehler hart setzen.
- **Eigenes Auto**: gleiches Prinzip mit `Vehicle` (Chassis-Pose + Geschwindigkeiten setzen, Eingaben wiederholen). Wiederholung höchstens 20 Schritte; sonst hart setzen.
- **Zustand sichern/wiederherstellen (Claudes Entscheidung, Builder-Check):** Heute fehlt dafür API: `Character.teleport` setzt die Vertikalgeschwindigkeit auf 0 und es gibt keinen Geschwindigkeits-Setter; der Lenkwinkel von `Vehicle` ist privat, und Rapiers Raycast-Fahrzeug hat Federungszustand, der sich nicht direkt setzen lässt. Plan 2 ergänzt in `@nn/shared/physics` je ein `saveState()`/`restoreState(s)` für `Character` (Position, Geschwindigkeit inkl. vertikal, Bodenkontakt, Knockdown-Restzeit) und `Vehicle` (Chassis-Pose, lineare/Winkelgeschwindigkeit, Lenkwinkel; Federung wird nach dem Setzen durch einen Raycast-Durchlauf ohne Integration neu bestimmt oder in Kauf genommen – Toleranztest in 13.3). Der Snapshot des eigenen Autos enthält den Lenkwinkel.
- **Vorhersage-Welt**: eine Client-`WorldSim` mit statischer Welt + Requisiten + eigener Entität (dynamisch) + nahe fremde Entitäten (kinematisch, auf interpolierter Pose). Kein Rollback der ganzen Welt.
- **Fremde Entitäten**: Interpolation zwischen Snapshots mit ~100 ms Puffer; kurze Extrapolation (≤ 150 ms) bei Paketverlust; danach einfrieren.
- **Zündung/Radio/Licht**: Zustände kommen vom Server; die eigene Zündung startet beim Einsteigen sofort lokal (Ton), der Server bestätigt; Gas ist erst nach serverseitigem `running` wirksam (gleicher Zeitplan in `sim`, daher deckungsgleich).
- **Ton** bleibt clientseitig: eigene Ereignisse lokal; fremde Autos bekommen positionsbezogene Motorstimmen (bestehende Per-Fahrzeug-Engine-Voice) für die nächsten **6** Autos, Aufprall-/Knockdown-Geräusche aus Server-Ereignissen.
- **Radio fremder Autos (Nutzer):** hörbar, aber nur ein bisschen – leise und dumpf, wie aus einem geschlossenen Auto. Nur das nächste Auto mit laufendem Radio ≤ 25 m (ein zusätzlicher Stream höchstens); räumlich (Panner), Tiefpass ca. 800 Hz, Pegel deutlich unter dem eigenen Radio (Startwert −18 dB relativ), mit der Entfernung abfallend. Sender-ID kommt aus dem Autozustand (6.3).

## 8. Spielregeln im Mehrspieler

### 8.1 Beitreten
- Namensdialog vor dem Laden (Overlay über Ladebildschirm, Enter bestätigt). Name 2–20 Zeichen nach Trimmen, Buchstaben/Ziffern/Leerzeichen/`-_.'`, einfacher Schimpfwortfilter (kleine deutsch+englisch Liste in `@nn/shared/net`, Normalisierung von Leetspeak/Umlauten), Dubletten → „Jupp 2“. Server prüft verbindlich, Client vorab für Fehlermeldung.
- Protokoll-/Build-Abgleich beim Join; bei Abweichung: „Neue Version – bitte Seite neu laden.“
- Voll (`MAX_PLAYERS`, Standard 60): „Nippes ist gerade voll – versuch es gleich nochmal.“
- Spawn: nächster freier Punkt (Kapsel ohne Überlappung) auf dem Spawn-Gehweg in 1.5-m-Schritten entlang der Straße, max. 60 m vom Manifest-Spawn.

### 8.2 Autos
- Alle `manifest.parked`-Autos sind Server-Entitäten (schlafend/fixiert bis berührt). Einsteigen: Server prüft Nähe (≤ 3 m, `nearestEnterableCar`) und dass das Auto frei ist; belegt es (`driverId`). Gleichzeitige Versuche: wer zuerst beim Server ankommt.
- Aussteigen: wie heute (`canGetOut` < 2 m/s, `exitSpot`), serverseitig geprüft. Verlässt ein Fahrer das Spiel, steht das Auto mit Motor aus dort.
- Verschobene Autos (Pose ≠ Manifest) ohne Fahrer, > 10 min unbenutzt und kein Spieler ≤ 100 m → zurück auf Manifest-Platz.

### 8.3 Laternen
- Umfahren wie heute (`StreetProps`), aber nur der Server entscheidet. Gefallene Laternen liegen für alle; Rückstellung nach 10 min, wenn kein Spieler ≤ 100 m.

### 8.4 Zusammenstöße mit Personen
- Fußgänger ↔ Fußgänger: Kapseln schieben sich (Server löst Überlappung; einfache Trennung pro Schritt, keine Physik-Kraftübertragung nötig).
- Auto ↔ Fußgänger: Server erkennt Kontakt (Muster wie `StreetProps.checkHits`: Box um bewegtes Auto, schneller als ~8 km/h). Fußgänger bekommt Knockback-Geschwindigkeit in Fahrtrichtung + etwas nach oben, Zustand `down` für 1.0 s (keine Eingabe, Figur liegt), dann steht er auf. Das Auto verliert nur wenig Tempo (kein „Stehenbleiben an einer Person“ mehr – bekannte Plan-1-Einschränkung wird hier behoben). Unter ~8 km/h schiebt das Auto die Person einfach weg.
- Auto ↔ Auto: Rapier-Starrkörper, wie heute.
- Keine Verletzungen, kein Blut, keine Punkte.

### 8.5 Verbindungsabbruch
- Colyseus-Reconnect-Fenster 15 s mit demselben Spieler (Figur bleibt stehen, Auto bleibt belegt). Danach: Figur verschwindet, Auto wird frei.

## 9. Schutz des Servers

- Eingaben klemmen (Achsen −1..1, yaw endlich), Rate-Limit (≤ 90 Eingaben/s, Überschuss verwerfen), Paketgröße begrenzen, Nachrichten unbekannten Typs → Verbindung trennen.
- Server vertraut nie Client-Positionen; nur Eingaben.
- Join-Rate pro IP begrenzen (z. B. 5/min).
- Server-Tick überwacht: wenn ein Tick > 3 Schritte im Rückstand ist, Rückstand verwerfen (wie `FixedStepper`) und loggen.

## 10. Betrieb

- **Ein Docker-Image** (`apps/server/Dockerfile`, Multi-Stage): baut Client + Server, liefert den Client statisch aus (gzip/brotli vorkomprimiert, lange Cache-Header für Assets mit Hash) und Colyseus-WebSockets auf **einem Port**.
- TLS über vorgeschalteten Reverse-Proxy (Beispielkonfiguration für Caddy im Repo). Anbieter frei (Nutzer stellt Server); Mindestgröße 2 vCPU / 2 GB RAM. **Nutzer: Docker-Image + Beispielkonfiguration genügen**; keine konkrete Plattform/Domain einrichten.
- Konfiguration per Umgebungsvariablen: `PORT`, `MAX_PLAYERS` (60, höchstens 100), `PUBLIC_URL`, `LOG_LEVEL`.
- `/healthz` (200 + Spielerzahl, Tick-Dauer p95).
- Logs: Join/Leave (ohne IP im Klartext), Tick-Überläufe, Fehler.
- Lokale Entwicklung: `npm run dev` startet Client (Vite) + Server parallel; Client verbindet per Vite-Proxy auf denselben Origin.
- `README`-Abschnitt „Mehrspieler betreiben“: Build, Start, Proxy, Update.

## 11. Einzelspieler / Offline

- **Kein Offline-Fallback für Spieler (Nutzer).** Ist der Server nicht erreichbar, zeigt der Namensdialog „Nippes ist gerade nicht erreichbar – versuch es später nochmal.“ mit automatischem Neuversuch alle 10 s.
- (Claudes Entscheidung) Eine lokale `WorldSim` ohne Netz bleibt nur für Entwicklung und Tests erhalten (`?offline=1` nur mit Dev-Server bzw. `?debug=1`), damit `drive-check` und Einzeltests weiterlaufen.

## 12. Dev-Hooks

- Im Mehrspieler: `?cam`, Flugmodus (F) und `window.__nn*`-Schreibzugriffe nur, wenn der Server im Dev-Modus läuft (`NODE_ENV !== 'production'`). `?time`/`?date` bleiben (nur Optik, lokal).
- `?debug=1`-Overlay zeigt zusätzlich RTT, Snapshot-Alter, Vorhersagefehler, Spielerzahl.

## 13. Abnahme

1. **Unit-Tests** (`@nn/shared/sim`, `net`): Ein-/Aussteigen, Belegung, Knockdown, Laternen, Namensregeln, Quantisierung (Rundlauf), Interessenbereich (rein funktional).
2. **Server-Integrationstest** (Node, echte Assets): zwei Test-Clients treten bei, sehen sich, einer steigt ein und fährt den anderen an → der wird `down` und steht nach ~1 s auf; Auto-Belegung exklusiv; Reconnect innerhalb 15 s behält Zustand.
3. **Determinismus-Toleranz**: Client-Vorhersage vs. Server bei 0 ms Latenz → Positionsfehler nach 10 s geradeaus laufen/fahren < 1 cm.
4. **Latenz-Test** (Playwright, 2 Browser, künstlich 150 ms RTT + 1 % Paketverlust): eigene Figur zeigt beim Laufen/Fahren keine Korrektursprünge > 0.2 m (p95), fremde Figur bewegt sich ohne Teleports.
5. **Lasttest**: `npm run loadtest` startet 100 Bots (Node, Colyseus-Client) – 60 % laufen, 40 % fahren, alle in einem Radius von 300 m um den Spawn, 10 min. Auf einer 2-vCPU-Maschine: Tick p95 < 8 ms, < 1 % verworfene Ticks, Bandbreite p95 < 50 KB/s pro Client, Speicher stabil.
   - **Nachtrag 2026-11-16:** Ziel 60 Spieler pro Server auf 2 vCPU; 100 benötigen einen schnelleren Einzelkern, die Physik läuft single-threaded. Der Lasttest läuft deshalb mit 60 Bots (gleiche Anteile) und prüft Tick p95 < 16,7 ms (das 60-Hz-Budget; die 8 ms entfallen), < 1 % verworfene Ticks, Bandbreite p95 < 50 KB/s pro Client und < 10 % RSS-Anstieg zwischen Minute 2 und 10.
6. **Bestehende Checks** bleiben grün: `npm test`, `npm run typecheck`, `npm run drive-check` (Einzelspieler-Modus) und ein neuer `npm run mp-check` (zwei Headless-Clients gegen lokalen Server: beide spawnen, sehen sich, einer fährt 30 m).
7. Nutzer prüft manuell mit zwei Rechnern (Mac + Linux-PC), ob es sich flüssig anfühlt.

## 14. Ansätze (betrachtet)

1. **Client-autoritativ (Positionen senden)** – einfach, aber Kollisionen sehen unterschiedlich aus, Cheats trivial. Vom Nutzer verworfen („echte Kollisionen“).
2. **Server-autoritativ mit Vorhersage nur der eigenen Entität + Interpolation der anderen** – Standard für Fahr-/Laufspiele, nutzt die bestehende gemeinsame Rapier-Physik. **Gewählt.**
3. **Volle Lockstep-/Rollback-Simulation der ganzen Welt** – braucht bitgleiche Physik (Rapier-`-deterministic`-Build, keine `Math.sin`-Unterschiede) und viel Client-CPU bei 2600 Autos. Verworfen.

## 15. Dem Umsetzer überlassen

- Genaues Binärformat, Colyseus-Schema-Aufteilung, Bibliothek für Bots.
- Wie `Game` in Darstellung + `WorldSim` aufgeteilt wird (Hauptsache: eine gemeinsame Sim für Server, Vorhersage und Einzelspieler).
- Knockdown-Animation der Figur (einfaches Umkippen + Aufstehen genügt).
- Konkrete Schimpfwortliste.

## 16. Offene Fragen an den Nutzer (vor der Umsetzung klären)

0. ~~Auf die Gelände-Höhen warten oder flach starten?~~ **Erledigt:** Das Gelände (DGM1) ist in `main` (PR #10); Plan 2 baut darauf auf (siehe `docs/superpowers/plans/2026-11-15-multiplayer.md`). Ursprüngliche Frage: Vorschlag: warten, bis die Gelände-Arbeit in `main` ist, und darauf aufbauen – sonst werden alle Höhen-Stellen (Requisiten, Autos, Aussteigen, Spawn) doppelt umgebaut und der Server/Client-Abgleich muss nach dem Gelände-Merge erneut geprüft werden. Falls doch flach begonnen wird: Höhe ausschließlich per Raycast gegen die statische Kollision (`surfaceY`) abfragen, keine eigenen Manifest-Felder einführen.
1. ~~Radio für andere hörbar?~~ **Entschieden:** ja, leise und dumpf (siehe 7).
2. ~~Offline-Fallback?~~ **Entschieden:** nein (siehe 11).
3. ~~Hosting?~~ **Entschieden:** Docker-Image + Caddy-Beispiel genügen (siehe 10).

## 17. Fahrräder im Mehrspieler (Nachtrag 2026-11-16)

Nutzerentscheidung: Fahrräder gehören voll zum Mehrspieler. Andere sehen dich fahren, geschobene oder umgefallene Räder sind für alle gleich.

- **Server-autoritativ wie Autos:** Der Server simuliert Fahrer und abgestellte Räder (`WorldSim`, `riding` überall an). Der Client sagt das eigene Rad vorher und gleicht es ab wie das eigene Auto (`replay`, Abweichung < 1 cm nach 10 s bei 0 ms Latenz).
- **Ein Fahrer pro Rad,** beliebig viele Räder gleichzeitig. Aufsteigen auf ein Rad, das jemand anderes fährt, wird abgelehnt (Ereignis `mountDenied`, Hinweis „Das Fahrrad ist besetzt“). Drücken zwei im selben Tick E, gewinnt, wer zuerst beim Server ankommt; der Client nimmt das vorhergesagte Aufsteigen zurück.
- **Auto trifft Radfahrer:** schneller als `KNOCKDOWN_KMH` → Sturz wie im Einzelspieler (Fahrer fällt ab, liegt und steht auf, das Rad bleibt liegen bzw. wird weggeschoben) plus `knock`. Langsamer → das Auto schiebt das Rad samt Fahrer vor sich her.
- **Rückstellung:** Verschobene Räder ohne Fahrer gehen nach `RESET_AFTER_S` ohne Bewegung auf ihren Manifest-Platz zurück, wenn kein Spieler ≤ `RESET_CLEAR_RADIUS` entfernt ist.
- **Protokoll (Version 2):** Eigener Block mit Modus `ride`, Rad-Id und vollem Radzustand; Snapshot mit Fahrern (Slot, Rad, Pose, Tempo, Lenkung, Treten, Sprung) und bewegten abgestellten Rädern (Id, Pose) im Interessenbereich. Hupe als gehaltenes Eingabe-Bit und Bit im Auto-Datensatz, Klingel als Eingabe-Puls und positionsgebundenes Ereignis `bell` (Abspielen fremder Hupen/Klingeln: Task 12). Budget bleibt ≤ 50 KB/s pro Client bei 100 Spielern in der Nähe.
- **Langsamer Zustand:** Spieler mit Modus `ride`, `bikeId` und Figur-Variante (`variant`, beim Beitritt gewählt, mit C änderbar, vom Server geprüft); Karte `bikes` für Räder mit Fahrer oder abseits ihres Manifest-Platzes (Fahrer, Ruhepose).
- **Darstellung:** Fremde Fahrer sitzen mit ihrer eigenen Figur-Variante und der Fahrhaltung aus dem Einzelspieler auf dem richtigen Radmodell, Name darüber; das abgestellte Rad ist dabei ausgeblendet. Bewegte abgestellte Räder folgen den Snapshot-Posen.
