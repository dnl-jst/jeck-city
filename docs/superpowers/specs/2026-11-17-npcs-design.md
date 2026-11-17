# NPCs: Leben in der Stadt – Design

Stand: 2026-11-17 · Basis: `main` @ `5cfc80e` · Branch `worktree-npcs`

## Absicht

Die Stadt wirkt leer, sobald wenige Spieler online sind. Der **Server** soll Leben erzeugen, für alle Spieler gleich:

- **Passanten**, die über Gehwege, Fußwege und Plätze laufen,
- **Radfahrer** und **Autofahrer** auf Radwegen und Fahrbahnen,
- **Gruppen in Parks**, die auf Bänken oder in der Wiese sitzen und sich unterhalten.

NPCs sind Kulisse mit ein bisschen Charakter. Hindert man sie daran, ihren Weg fortzusetzen, schimpfen sie mit einem
kölschen Spruch (Sprechblase) und warten dann, bis der Weg frei ist, oder gehen außen herum, wenn genug Platz ist.

## Bereits entschieden (Nutzer)

- NPCs werden **vom Server** erzeugt und sind für alle Spieler dieselben.
- Sie **reagieren**, wenn man ihnen im Weg steht: Spruch, dann warten oder ausweichen (wenn Platz ist).
- Sprüche zuerst **nur als Sprechblase**; synthetische Stimmen (Piper-Test lief, siehe unten) kommen später.
- Bauweise **B: Pläne statt Positionen** (siehe „Ansätze“).

## Ziele

1. Rund um jeden Spieler ist sichtbar etwas los: Passanten, Radfahrer, Autos, Parkgruppen.
2. Alle Spieler sehen dieselben NPCs an denselben Orten.
3. NPCs reagieren auf Spieler, die ihnen im Weg stehen (zu Fuß, im Auto, auf dem Rad).
4. Die NPCs kosten den Server fast nichts: Der Lasttest mit 60 Spielern bleibt grün.
5. Die Bewegung ist ruckelfrei, auch bei Paketverlust.

## Nicht-Ziele (diese Version)

- Keine gesprochenen Stimmen (später, Abschnitt „Später: Stimmen“).
- Keine Ampeln, keine Verkehrsregeln jenseits von „rechts fahren, Abstand halten, an Kreuzungen langsam, wer zuerst
  kommt, fährt zuerst“.
- Keine Straßenbahn, keine Busse.
- NPCs steigen nicht in geparkte Autos oder auf abgestellte Räder; NPC-Fahrzeuge sind eigene Fahrzeuge, die mit dem NPC
  entstehen und verschwinden.
- Spieler können keine NPC-Autos oder -Räder übernehmen.
- Kein Tagesrhythmus (der Tag/Nacht-Wechsel ist clientseitig, der Server kennt keine Spielerzeit) und keine
  Wetterabhängigkeit.
- Keine Gespräche mit NPCs, kein Ansprechen, keine Aufträge.

## Anti-Ziele (Fehlschlag, auch wenn es „funktioniert“)

- Der Server-Tick wird mit 60 Spielern merklich langsamer (Lasttest fällt durch) oder die Bandbreite pro Spieler steigt
  um mehr als einige KB/s.
- NPCs ruckeln, teleportieren sichtbar, laufen durch Wände, Häuser oder geparkte Autos, laufen auf der Fahrbahn
  entlang oder fahren auf dem Gehweg.
- NPCs tauchen sichtbar vor dem Spieler auf oder verschwinden vor seinen Augen.
- Spieler sehen unterschiedliche NPCs oder NPCs an verschiedenen Orten.
- Die Bildrate auf der Grafikstufe „Niedrig“ (Standard) bricht spürbar ein.
- Ein NPC wiederholt ständig denselben Spruch (Spam), oder alle NPCs in der Nähe schimpfen gleichzeitig.

## Ausgangslage im Code

- **Server-Simulation** `packages/shared/src/sim/world-sim.ts` (`WorldSim`, 60 Hz, deterministisch, kein
  `Math.random`). Der Lasttest (`docs/superpowers/notes/2026-11-15-multiplayer-loadtest.md`) liegt mit 60 Spielern bei
  Tick p95 16,26 ms von 16,7 ms: **Es ist praktisch keine Rechenzeit übrig, wenn der Server voll ist.**
- **Snapshots** 20 Hz pro Client mit Interessenbereich 250 m (`INTEREST_RADIUS`, Hysterese 270 m), Bandbreite p95
  23 KB/s pro Client (Budget 50 KB/s). Raum: `apps/server/src/room.ts`, Kodierung `packages/shared/src/net/codec.ts`,
  `snapshot.ts`.
- **Client-Vorhersage** hat fremde Entitäten als kinematische Stellvertreter in der Physik (`sim/proxies.ts`):
  Fußgänger als Kapseln, Autos/Räder kinematisch auf ihrer Pose.
- **Zusammenstöße mit Personen** laufen nicht über den Rapier-Solver, sondern über Box-Tests (`sim/collisions.ts`,
  `carHitsPeople`, `KNOCKDOWN_KMH` = 8).
- **Darstellung fremder Spieler** `apps/client/src/remote/remote-players.ts` (Figuren-Pool, Figur-Varianten `man`/
  `woman`, Fahrer-Rigs auf Rädern, Namensschilder `name-label.ts`); Autos in `apps/client/src/car.ts`; Radmodelle
  `bike_<typ>.glb`.
- **Wegedaten:** Die Pipeline baut einen Straßengraphen mit Fahrspuren je Richtung und Einbahnstraßen
  (`packages/pipeline/src/roadgraph.ts`) und kennt Querschnitte mit Gehwegbreiten (`crosssection.ts`,
  `sidewalkwidth.ts`). OSM enthält u. a. ~4500 Fußwege, ~2500 Pfade, ~160 Radwege, ~400 Fußgängerzonen, ~1800
  Querungen, ~2100 Bänke, ~100 Parks, ~240 Spielplätze. **Nichts davon wird heute an Server oder Client ausgeliefert.**
  `map.json` enthält Grünflächen (`greens`) und Plätze (`squares`) als Umrisse.
- Die Welt ist etwa 3,6 × 6,5 km groß (Innenstadt-Erweiterung in Arbeit).

## Ansätze (betrachtet)

- **A: Positionen streamen wie bei Spielern.** Der Server bewegt NPCs jeden Tick und schickt sie mit den Snapshots.
  Einfach und nutzt die vorhandene Interpolation, aber kostet grob 15–20 KB/s pro Spieler bei ~80 NPCs in der Nähe
  und zusätzliche Tick-Zeit, die es bei vollem Server nicht gibt. Verworfen.
- **B: Pläne statt Positionen. Gewählt (Nutzer).** Der Server schickt pro NPC einen *Plan* (Wegstück als Linienzug,
  Start-Tick, Tempo, Zustand). Server und Client werten ihn mit derselben Funktion aus. Nachrichten gibt es nur bei
  Änderungen. Fast keine Bandbreite, sehr wenig Server-Zeit, ruckelfrei.
- **C: Jeder Client erfindet seine eigenen NPCs.** Widerspricht „vom Server, für alle gleich“. Verworfen.

## Design

### 1. Wegenetz (Pipeline → `npc.bin` bzw. `npc.json` in `apps/client/public/world/`)

Die Pipeline erzeugt ein eigenes Wegenetz für NPCs und trägt es ins Manifest ein (`npc: { file, bytes }`, fehlt in
älteren Manifesten → keine NPCs). Es enthält drei Graphen und Sitzplätze:

- **Fußgänger-Graph:** Gehwege links und rechts jeder Straße mit Gehweg (Mittellinie des Gehwegs aus Querschnitt und
  Gehwegbreite, gegen Gebäude und geparkte Autos freigehalten), dazu OSM-Fußwege, Pfade, Fußgängerzonen (als Wege über
  den Platz) und **Querungen** (OSM `crossing`, sonst an Kreuzungen), die beide Straßenseiten verbinden. Kanten tragen
  die nutzbare Breite (für das Ausweichen).
- **Fahrspur-Graph:** pro Fahrtrichtung eine Spur auf der rechten Fahrbahnhälfte (Mehrspur: rechte Spur genügt),
  Einbahnstraßen nur in Fahrtrichtung, Kreuzungsknoten mit Abbiegeverbindungen (Bögen statt Ecken). Basis:
  `buildRoadGraph`. Nur Straßenarten, auf denen Autos sinnvoll fahren (keine `service`-Stummel unter ~30 m, keine
  Fußgängerzonen).
- **Rad-Graph:** OSM-Radwege, dazu die Fahrspuren mit einem Versatz an den rechten Fahrbahnrand.
- **Sitzplätze:** OSM-Bänke innerhalb von Grünflächen und Plätzen, dazu erzeugte Plätze in der Wiese (Grünflächen ab
  einer Mindestgröße, mit Abstand zu Bäumen, Wegen und Wasser). Jeder Sitzplatz ist eine kleine Runde (2–4 Plätze mit
  Position und Blickrichtung zur Mitte).
- **Höhen:** Jeder Punkt trägt die Höhe der Oberfläche (Gehweg, Fahrbahn oder Gelände; aus Terrain und Querschnitt),
  damit NPCs ohne Raycast auf dem Boden stehen.

Das Netz wird nur vom Server gelesen. Clients brauchen es nicht, weil die Pläne ihre Linienzüge mitbringen (Abschnitt 3).

### 2. NPC-Typen und Verhalten

| Typ | Weg | Tempo | Aussehen |
|---|---|---|---|
| Passant | Fußgänger-Graph | 1,1–1,6 m/s, gestreut | Figur `man`/`woman`, Kleidungsfarben gestreut |
| Radfahrer | Rad-Graph | 3,5–6 m/s | Figur auf einem Rad aus `BIKE_TYPES` (ohne Soundjohn) |
| Autofahrer | Fahrspur-Graph | bis Tempo der Straßenart, max. 50 km/h, in Kreuzungen 15 km/h | Auto aus `CAR_TYPES`, gestreute Farbe |
| Parkgruppe | Sitzplatz | sitzt | 2–4 Figuren, sitzend, mit Gesten |

- **Routen:** Ein bewegter NPC wählt an jedem Knoten zufällig (geseedeter PRNG) eine Fortsetzung, ohne direkt
  umzukehren. Passanten queren Straßen nur an Querungen bzw. Kreuzungen.
- **Abstand:** NPC-Autos und -Räder halten Abstand zum Vordermann auf derselben Spur (Bremsen statt Auffahren). An
  Kreuzungen fährt zuerst, wer zuerst ankommt (Reservierung des Kreuzungsknotens). NPC-Autos halten für Passanten auf
  Querungen an.
- **Parkgruppen:** sitzen, bewegen Kopf und Hände abwechselnd, als würden sie reden. Kommt ein Spieler auf ≤ 4 m
  heran, schauen sie zu ihm. Gelegentlich zeigt einer eine kurze Sprechblase mit kölschem Smalltalk (Liste in
  Abschnitt 5).

### 3. Pläne (die Kernidee)

Ein **Plan** beschreibt, wo ein NPC ab einem Tick ist, als reine Funktion der Zeit:

```
Plan = { npc: id, kind, look, startTick, path: Punkte (x, y, z), speed, action }
action: 'move' | 'wait' | 'sit' | 'down' (liegt nach einem Treffer) | 'getup'
```

- Position zum Tick t: Strecke `speed × (t − startTick) / 60` entlang `path`; am Ende steht der NPC am letzten Punkt.
  Blickrichtung: Richtung des aktuellen Abschnitts (an Knicken weich überblendet). Fahrzeuge: Heading aus dem Pfad,
  Neigung aus der Höhe.
- `planAt(plan, tick)` liegt in `@nn/shared` und ist die **einzige** Auswertung, auf Server und Client.
- Der Server legt Pläne einige Sekunden im Voraus fest (z. B. bis zum nächsten Knoten plus die Abbiegung danach) und
  schickt den Folgeplan, **bevor** der aktuelle endet, damit der Client nie ohne Plan dasteht.
- Ändert sich etwas (blockiert, ausweichen, getroffen), ersetzt der Server den Plan mit einem neuen ab dem aktuellen
  Tick und der aktuellen Position. Der Client blendet von der alten zur neuen Position kurz über, falls er wegen der
  Laufzeit schon weitergerechnet hat.
- Tempo-Änderungen (Bremsen, Anfahren, Kurven) werden im Plan als Abschnitte mit eigenem Tempo dargestellt; einfache
  lineare Rampen genügen.

### 4. Erzeugen und Auflösen (Server)

- NPCs gibt es nur rund um Spieler: Der Server hält um jeden Spieler eine Ziel-Dichte (Startwerte: 40 Passanten,
  10 Radfahrer, 20 Autos, bis zu 6 Parkgruppen in 250 m; als Konstanten, zum Feintunen).
- **Neue NPCs entstehen außerhalb der Sichtweite** (180–250 m vom nächsten Spieler, nicht im Sichtfeld eines Spielers,
  wo möglich hinter Häuserecken) oder laufen aus einem Hauseingang/einer Seitenstraße herein. Beim allerersten Beitritt
  in eine leere Gegend dürfen sie überall außer in unmittelbarer Nähe (> 40 m) entstehen, damit nicht erst alles leer ist.
- **Aufgelöst** werden NPCs, die weiter als 300 m von *jedem* Spieler weg sind (also außerhalb jedes
  Interessenbereichs).
- **Einblenden (Claudes Entscheidung, Builder-Check):** Der Server kennt keine Kamera, nur die Blickrichtung der
  Eingabe; „außer Sicht“ ist also eine Näherung. Als Rückfall blendet der Client neu erscheinende NPCs über ~1 s ein
  (Auto: Deckkraft/Skalierung, Figur: Deckkraft). Sichtbares Auftauchen nah vor dem Spieler bleibt ein Fehler.
- **Karte (Claudes Entscheidung):** Das Wegenetz wird aus der Karte erzeugt, die beim Bauen in `main` ist; die
  Innenstadt-Erweiterung bekommt NPCs automatisch beim nächsten Pipeline-Lauf. Sichtprüfung an den Orten, die es dann
  gibt.
- Gesamtobergrenze auf dem Server (Startwert 400 NPCs). Treffen sich viele Spieler an einem Ort, teilen sie sich die
  NPCs dort (Dichte zählt pro Gebiet, nicht pro Spieler).
- **Spielergrenze (Nutzer, 2026-11-17):** NPCs müssen auch bei vollem Server da sein. Dafür sinkt der Standard von
  `MAX_PLAYERS` von 60 auf **40** (so ist das Live-System schon eingestellt, die CPU-Last dort ist gering). README,
  `constants.ts`, `config.ts` und der Lasttest-Standard (`--bots`) ziehen mit.
- **Last-Bremse (Sicherheitsnetz):** Steigt der Server-Tick (gleitendes p95, gemessen auf der Maschine, auf der der
  Server läuft) über 14 ms, sinkt die Ziel-Dichte schrittweise, bei < 10 ms steigt sie wieder. Im Lasttest mit 40
  Spielern darf sie die NPC-Zahl nicht unter die Mindestzahl (Abschnitt 8) drücken.
- Alle Zufallsentscheidungen über einen geseedeten PRNG (wie die Bots); keine Wanduhr.

### 5. Reaktion auf Spieler

**Blockiert:** Der Server prüft für jeden bewegten NPC **nur in der Nähe von Spielern** (Spieler ≤ 30 m) alle 0,25 s
einen Korridor voraus (Passant ~1,5 m, Radfahrer ~4 m, Auto Bremsweg + 3 m, Breite der Figur bzw. des Fahrzeugs):

- Liegt ein Spieler (zu Fuß, im Auto, auf dem Rad) oder ein von Spielern verschobenes Auto/Rad darin, hält der NPC an
  (Plan `wait`).
- Nach ~0,7 s Stillstand: **Sprechblase** mit einem Spruch (zufällig aus der Liste für den NPC-Typ), höchstens einmal je
  Blockade und mit Abkühlzeit (≥ 8 s) pro NPC. In der Nähe eines Spielers schimpft höchstens ein NPC gleichzeitig.
- Dann: **Ausweichen**, wenn genug Platz ist. Passanten auf breitem Gehweg/Platz seitlich vorbei (Kante breit genug für
  Hindernis + 0,6 m), Radfahrer auf die Fahrbahn bzw. Gegenfahrbahn, wenn frei, Autos auf die Gegenspur, wenn sie über
  die Länge des Hindernisses frei ist. Sonst **warten**, bis der Korridor frei ist.
- Wartet ein NPC länger als 20 s, dreht er um bzw. biegt ab und nimmt einen anderen Weg.
- Autos hupen beim Blockieren kurz (vorhandener Hupen-Ton für fremde Autos); das ist kein Sprach-Asset.

**Getroffen:** Ein Spieler-Auto (oder -Rad) trifft einen Passanten oder NPC-Radfahrer schneller als `KNOCKDOWN_KMH`
→ der NPC wird weggestoßen (kurzer Flugbogen im Plan), liegt wie ein Spieler ~1 s (`action: 'down'`), steht auf
(`getup`), zeigt „Bes do jeck?!“ und geht danach weiter (manchmal mit „Et hätt noch immer jot jejange.“ beim
Aufstehen). Langsamer schiebt das Auto den NPC zur Seite (wie bei Spielern). Prüfung wie `carHitsPeople`, aber gegen
die NPC-Positionen aus den Plänen, nur für NPCs in der Nähe von schnellen Spieler-Fahrzeugen.

**Gegen NPC-Autos fahren:** NPC-Autos sind in der Physik **kinematische Körper** auf ihrer Plan-Pose (Server und
Client-Vorhersage, wie `Proxies`), aber nur in der Nähe von Spielern (≤ 60 m). Ein Spieler-Auto prallt daran ab; das
NPC-Auto bleibt stehen (blockiert) und reagiert wie oben. Passanten werden als kinematische Kapseln für Spieler zu Fuß
fest (man läuft nicht durch sie hindurch), ebenfalls nur in der Nähe von Spielern. NPCs untereinander kollidieren nicht
physikalisch; Abstand halten sie über ihre Pläne.

**NPCs treffen nie Spieler (Claudes Entscheidung, Builder-Check):** Ein NPC fügt einem Spieler keinen Knockdown zu.
NPCs mit einem Spieler ≤ 30 m prüfen ihren Korridor **jeden Tick** (statt alle 0,25 s), damit sie auch vor einem
Spieler halten, der plötzlich zwischen parkenden Autos hervortritt. Kommt es trotzdem zur Berührung, schiebt der
kinematische Körper den Spieler nur leicht (wie heute ein langsames Auto) und der NPC hält sofort an.

**Autos und Radfahrer (Claudes Entscheidung):** Fahren NPC-Radfahrer auf der Fahrbahn, sind sie für NPC-Autos ein
Vordermann. Autos überholen sie, wenn die Gegenspur über die Überholstrecke frei ist (gleiche Logik wie beim Ausweichen),
sonst fahren sie hinterher.

**Sprüche** (Kölsch, ohne Übersetzung in der Blase):

| Anlass | Sprüche |
|---|---|
| Passant/Radfahrer blockiert | „Jank mer us de Föß!“ · „Wat steihs do eröm wie ne Ölljötz?“ · „Maach ens Plaatz, ich han et ielich!“ |
| Autofahrer blockiert | „Fahr doch, do Dröömdüppe!“ (plus Hupe) |
| angefahren | „Bes do jeck?!“ |
| beim Aufstehen (manchmal) | „Et hätt noch immer jot jejange.“ |
| Parkgruppe, Smalltalk (Claudes Vorschlag) | z. B. „Wie et kütt, kütt et.“ · „Et es wie et es.“ · „Drinks de ene met?“ |

Die Liste liegt in `@nn/shared` (Spruch-IDs im Protokoll, Text im Client), damit Stimmen später je ID eine Tondatei
bekommen. Schreibweise vor dem Merge von jemandem prüfen lassen, der Kölsch spricht (Nutzer).

### 6. Protokoll

- `PROTOCOL_VERSION` → 3.
- Neue zuverlässige Binärnachricht `n` vom Server an jeden Client, nur für NPCs in dessen Interessenbereich
  (250/270 m wie Spieler), gebündelt einmal pro Snapshot-Runde:
  - `plan` (neuer/ersetzter Plan; beim Eintritt in den Bereich der aktuelle Plan des NPCs),
  - `gone` (NPC verlässt den Bereich oder wird aufgelöst),
  - `say` (NPC-ID, Spruch-ID),
  - `honk` (NPC-ID).
- Punkte im Pfad cm-quantisiert relativ zum ersten Punkt; `look` ist ein kleiner Satz Zahlen (Variante, Farben,
  Fahrzeugtyp), der aus einem Seed abgeleitet werden darf.
- **Zeitbasis (Claudes Entscheidung, Builder-Check):** Der Client wertet `planAt` am **vorhergesagten Tick** der eigenen
  Figur aus, nicht mit Interpolationsverzögerung. Weil Pläne im Voraus bekannt sind, stimmen damit Darstellung,
  Kollision in der Vorhersage und Server überein (keine Korrektursprünge beim Streifen eines NPC-Autos). Der Server
  schickt Folgepläne mindestens 1 s vor Ablauf. Nur Planänderungen durch Reaktionen (blockiert, getroffen) kommen um die
  Laufzeit zu spät; der Client blendet dann über ~150 ms zur neuen Position über.
- **NPCs in `WorldSim` (Claudes Entscheidung):** Die NPC-Körper (kinematisch, nur nahe Spielern) gehören zur
  gemeinsamen Simulation; `replay` setzt sie in jedem wiederholten Tick per `planAt` neu. Das ist billig (reine
  Auswertung, keine Physik-Integration).
- Bandbreiten-Ziel: im Mittel < 2 KB/s pro Client bei voller Dichte.

### 7. Darstellung (Client)

- **Passanten** nutzen die Figuren und die Laufanimation fremder Spieler (`RemotePlayers`), aber ohne Namensschild.
  Abwechslung über gestreute Kleidungsfarben (Material-Tönung) und leicht gestreute Größe (±5 %).
- **Radfahrer** nutzen die Fahrer-Rigs der fremden Radfahrer.
- **Autos** nutzen die Automodelle samt LOD und Licht wie fremde Spieler-Autos (Scheinwerfer nachts nach der lokalen
  Uhrzeit, Bremslicht beim Bremsen im Plan).
- **Sitzen:** neue Sitzhaltung (prozedural aus der Ruhepose, wie die Fahrhaltung) mit kleinen Kopf-/Armbewegungen.
- **Liegen/Aufstehen:** wie bei fremden Spielern.
- **Sprechblase:** über dem Kopf (bei Autos über dem Fahrerfenster), weißer Kasten mit Zipfel, sichtbar bis ~30 m,
  ~3 s, ein- und ausgeblendet. Gebaut wie das Namensschild.
- **Leistung:** Figuren- und Rig-Pool, Animation in der Ferne seltener (z. B. ab 60 m nur jedes zweite Bild), ab
  ~150 m nur Autos. Auf der Grafikstufe „Niedrig“ keine Figuren-Schatten für NPCs. Ziel: höchstens wenige ms pro Bild
  mehr bei voller Dichte (gemessen mit `drive-check`/Playwright mit GPU).

### 8. Prüfung / Abnahme

1. **Unit-Tests** (`@nn/shared`): `planAt` (Position, Richtung, Rampen, Ende), Kodierung Rundlauf, Korridor-Test,
   Ausweichen nur bei genug Breite, Spruch-Abkühlung, Erzeugen außerhalb der Sicht, Auflösen.
2. **Pipeline-Tests:** Gehwege liegen nicht auf der Fahrbahn und nicht in Gebäuden; Fahrspuren rechts; Einbahnstraßen
   nur in Fahrtrichtung; Querungen verbinden beide Seiten; Sitzplätze in Grünflächen.
3. **Server-Integrationstest:** ein Test-Client bekommt NPCs in seiner Nähe; steht er einem Passanten im Weg, bekommt er
   `say` und der Passant wartet bzw. weicht aus; ein Spieler-Auto trifft einen Passanten → `down`, danach `getup`.
4. **Lasttest** (`npm run loadtest`, **40 Bots**, Aufstellung wie im Lasttest-Protokoll: Server auf 2 Kernen) **mit
   NPCs**: gleiche Kriterien wie bisher (Tick p95 < 16,7 ms, < 1 % verworfene Ticks, Bandbreite p95 < 50 KB/s,
   Speicher stabil) und **mindestens 150 aktive NPCs** über den ganzen Lauf (Startwert, die Bots stehen alle in 300 m
   um den Spawn). Das Protokoll nennt NPC-Zahl, NPC-Anteil an der Tick-Zeit und den Eingriff der Last-Bremse.
5. **Sichtprüfung:** Screenshots/Playwright mit GPU an mehreren Orten (Neusser Straße, ein Park, eine Kreuzung,
   Domplatte): NPCs auf Gehwegen, Autos auf der rechten Spur, Parkgruppe sitzend, Sprechblase beim Blockieren.
6. Bestehende Checks bleiben grün: `npm test`, `npm run typecheck`, `npm run drive-check`, `npm run mp-check`.

## Später: Stimmen

Ein Test mit Piper (lokal, Open Source; 11 deutsche Stimmen, u. a. `thorsten_emotional` mit „angry“/„drunk“) lief am
2026-11-17. Später: je Spruch-ID und Stimme eine Tondatei, räumlich abgespielt; Kandidaten Piper (lokal, frei) oder
ElevenLabs (natürlicher, kostenpflichtig). Nicht Teil dieser Version.

## Dem Umsetzer überlassen

- Genaues Format von `npc.bin`/`npc.json` und der Nachricht `n`.
- Wie Gehweg-Mittellinien aus Querschnitten abgeleitet und an Kreuzungen verbunden werden.
- Genaue Korridor-Maße, Tempo-Rampen, Abstandsregel, Kreuzungsreservierung.
- Wie die Sitzhaltung und das „Reden“ animiert werden (einfach genügt).
- Wie die Sprechblase genau aussieht (lesbar bei Tag und Nacht, passend zum Namensschild).
- Feinwerte der Dichte und der Last-Bremse (nach Lasttest und Sichtprüfung).
