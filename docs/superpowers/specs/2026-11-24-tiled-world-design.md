# Kachelweise Welt – Design (Teil 2)

## Absicht

Die Spielwelt soll auf ganz Köln wachsen können und später darüber hinaus. Heute ist fast alles „eine Welt = ein
Stück“: Die Pipeline hält die ganze Stadt im Speicher, der Client lädt Gelände, Kollision und alle Objektlisten
komplett vor dem Start, und der Server baut die ganze Kollisionswelt und läuft in jedem Tick über alle Autos, Räder
und Laternen. Ein Versuch, zwei Stadtteile dazuzunehmen, ist am Speicher der Pipeline gescheitert.

Dieses Design baut das um: Nichts hält mehr die ganze Welt. Die Pipeline baut Kachel für Kachel, das Weltformat
besteht aus Kacheln, und Client und Server laden sie nach Position.

**Das Gebiet bleibt dabei, wie es ist.** Der Umbau wird so ausgelegt, dass er für ganz Köln trägt; bewiesen wird er
an der heutigen Welt, weil sich alt und neu dort direkt vergleichen lassen. Teil 1 (Auslieferung über Objektspeicher,
`index.json`, Welt-Hash) ist die Grundlage: `docs/superpowers/specs/2026-11-24-world-delivery-restart-design.md`.

## Ausgangslage (gemessen am 24.11.2026, Gebiet ≈ 37 km², 1015 Chunks)

| | heute |
|---|---|
| Spitzen-RAM der Pipeline | 7,3 GB (wächst linear mit der Fläche; Heap-Grenze 10 GB) |
| Größter Posten | 73 Mio. gedrapte Dreiecke gleichzeitig im Speicher (Straße 20,9 Mio., Grün 20,4 Mio. …) |
| `collision.bin` / `terrain.bin` | 100 MB / 75 MB, je eine Datei für die ganze Welt |
| `manifest.json` / `map.json` | 2,9 MB / 15,7 MB, je eine Datei |
| Server im Leerlauf | 1,9 GB RAM |
| IDs von Autos, Rädern, Laternen | Index ins Manifest; `int16` im Raum-Zustand (max. 32 767), `u16` im Snapshot |
| Räder in der Welt | 10 814 – bei dreifacher Fläche reißt `int16` |

Die vollständige Liste der Stellen, die heute die ganze Welt voraussetzen, steht im Anhang.

## Ziele

- **Pipeline mit begrenztem Speicher:** Der Speicherbedarf der Kachel-Stufe hängt nicht von der Fläche ab. Für das
  heutige Gebiet bleibt der ganze Lauf unter **4 GB** Spitzen-RAM (heute 7,3 GB).
- **Kachelformat:** Gelände, Kollision, Objekte und Karte liegen pro Kachel vor. Es gibt keine Datei mehr, deren
  Größe mit der Fläche wächst – außer den unter „Was global bleibt“ genannten.
- **Client lädt nach Position:** Vor dem Start lädt er nur, was er am Startpunkt braucht. Startzeit und Speicher
  hängen nicht von der Weltgröße ab.
- **Server lädt nach Spielern:** Kollision, Gelände und Objekte nur um Spieler herum; keine Schleife mehr über alle
  Objekte der Welt pro Tick. Speicher und Tick-Zeit hängen von der Spielerzahl ab, nicht von der Fläche.
- **Breitere IDs:** Autos, Räder und Laternen bekommen IDs, die für ganz Köln reichen.
- **Rohdaten im Bucket:** Die Pipeline hängt nicht mehr von Overpass und den Landesservern ab, und ein
  festgehaltener Rohdatenstand ergibt immer dieselbe Welt.
- **Nur Geändertes bauen:** Ein zweiter Lauf mit unveränderten Eingaben baut keine Kachel neu.
- **Bau auf dem GitHub-Runner:** Die CI baut die Welt weiterhin selbst (Entscheidung Daniel). Der Ablauf muss mit
  dessen Grenzen auskommen (≈ 14 GB Platte, 16 GB RAM, 4 Kerne, 6 h je Job, 10 GB Cache).
- **Spiel unverändert:** Wer spielt, merkt vom Umbau nichts – gleiche Stadt, gleiche Physik, gleiche Bedienung.

## Nicht-Ziele (jetzt)

- **Kein größeres Gebiet.** Ehrenfeld, Ossendorf und ganz Köln kommen danach, als eigene Schritte.
- **Kein Geometrie-Budget:** Das 1-m-Draping und die Download-Größe pro km² (≈ 40 MB) bleiben. Das ist der nächste
  große Hebel, aber ein eigenes Projekt.
- **Kein wandernder Ursprung:** Koordinaten bleiben float32 um den festen Ursprung. Für Köln (≤ ≈ 20 km) reicht das;
  für NRW nicht.
- **Kein Aufteilen auf mehrere Server:** Es bleibt bei einem Prozess und einem Raum.
- **Kein gekacheltes Bahnnetz, keine Fernstufen (LOD) für die Darstellung, kein hierarchischer Index.**
- Kein Erhalt des Spielzustands über einen Neustart.

## Anti-Ziele

- Client und Server dürfen aus denselben Kacheln nie Unterschiedliches berechnen (Vorhersage und Wiederholung
  vergleichen auf 1 cm).
- An Kachelgrenzen darf man nichts spüren: kein Ruck beim Gehen oder Fahren, kein Loch im Boden, kein Objekt doppelt
  oder gar nicht.
- Zugangsdaten dürfen für lokales Entwickeln und für ein volles Image nicht Pflicht werden: Ohne sie baut die
  Pipeline lokal eine vollständige Welt. Die Rohdaten liest sie dann aus dem öffentlich lesbaren Spiegel.
- Ein abgebrochener Lauf darf nie eine Welt hinterlassen, die als fertig gilt.

## Ansätze

**Umfang.** (A) Nur die Pipeline umbauen, Ausgabe bleibt wie heute: schnell, aber bei zwei- bis dreifacher Fläche
ist Schluss, weil Client und Server die großen Dateien weiter komplett laden. (B) Pipeline und Weltformat samt
Client und Server. **Gewählt: B** (Daniel). A ist dabei die erste Baustufe von B, siehe „Baustufen“.

**Wo wird gebaut.** (1) Lokal bauen und veröffentlichen, CI holt die Server-Dateien aus dem Bucket; (2) eigener
Build-Rechner; (3) GitHub-Runner. **Gewählt: 3** (Daniel). Folge: Für ganz Köln muss die Pipeline Kachel für Kachel
durchreichen (laden, bauen, hochladen, löschen) und sich im Bucket merken, was schon gebaut ist. Für das heutige
Gebiet ist das eine Beschleunigung, keine Voraussetzung.

**Rohdaten.** (1) Wie heute von Overpass und den Landesservern, mit Monats-Cache in der CI; (2) Spiegel im Bucket.
**Gewählt: 2** (Vorschlag Daniel), einschließlich des KVB-Fahrplans.

**Einheit der Kachel.** (1) Der 200-m-Chunk, den die Darstellung schon benutzt, auch für Gelände, Kollision und
Objekte; (2) gröbere Kacheln (z. B. 1 km) für die Simulationsdaten. **Gewählt: 1** – ein Raster, eine Zuordnung,
und Client und Server laden um einen Spieler nur wenige hundert Meter. *(Mein Vorschlag.)*

## Der Rohdaten-Spiegel

- Eigenes Verzeichnis **`raw/`** im Bucket, getrennt von `objects/` und `worlds/`. `world:prune` fasst es nie an.
- Inhalt: LoD2-Kacheln, DGM1-Kacheln, OSM-Auszug, Linien-Relationen, KVB-Fahrplan (GTFS). Komprimiert abgelegt
  (die Gebäudedaten sind XML und schrumpfen stark).
- **Rohdatenstand im Repository:** Eine Datei (Vorschlag `data/raw.lock.json`) nennt jede Rohdatei mit Inhalts-Hash.
  Die Pipeline arbeitet nur mit Dateien, deren Hash dazu passt. Ein neuer OSM-Stand ist ein eigener Befehl, der die
  Datei ändert, und ein eigener Commit – kein stiller Monatswechsel mehr.
- **Ein normaler Lauf holt nie frische Daten.** Er sucht jede Rohdatei erst lokal (`data/raw`), dann im Spiegel
  (ohne Zugangsdaten über dessen öffentliche Adresse) und prüft sie gegen den Hash im Rohdatenstand. Fehlt eine Datei
  an beiden Orten oder passt der Hash nicht, bricht er mit einer Meldung ab, die den Aktualisieren-Befehl nennt.
  *(Mein Vorschlag: Overpass liefert nie zweimal dasselbe; ein stiller Rückfall auf den Originalserver würde den
  festgehaltenen Stand unterlaufen.)*
- **Aktualisieren ist ein eigener Befehl** (Vorschlag `npm run raw:update`): holt von den Originalservern, legt die
  Dateien im Spiegel ab (braucht Schreibrecht) und schreibt den Rohdatenstand neu. Er ersetzt den Monats-Cache und
  den „Refresh OSM“-Schritt im Workflow.
- **Erstbefüllung** gehört zu Baustufe 1: Die heute lokal vorhandenen Rohdaten (der Stand, aus dem die Welt
  `43d9e34a3f1e` entstand) werden hochgeladen und als erster Rohdatenstand festgehalten.
- **Fahrplan:** Der KVB-Fahrplan wird gespiegelt (Entscheidung Daniel) und damit Pflichteingabe; ein Lauf ohne ihn
  bricht ab, statt still einen Behelfstakt zu bauen. Die Stichtage, aus denen die Fahrten gezogen werden, richten
  sich heute nach dem Tagesdatum; künftig stehen sie im Rohdatenstand, damit derselbe Stand immer dieselbe Welt
  ergibt und ein abgelaufener Feed keinen Bau bricht.
- **Lizenzhinweis** als Datei in `raw/`: Geobasis NRW (dl-de/zero-2.0), OpenStreetMap (ODbL, Namensnennung), KVB/VRS
  (Lizenztext des Feeds, soweit auffindbar). Das Verzeichnis ist öffentlich lesbar. Untersagen die Bedingungen des
  Feeds die Weitergabe ausdrücklich, wird das Daniel vor dem Hochladen gemeldet.

## Die Pipeline

Fünf Stufen. Jede schreibt ihr Ergebnis auf die Platte und gibt den Speicher frei. Die Reihenfolge ist logisch,
nicht zeitlich: Planen und Gelände greifen ineinander (siehe „Gelände in Durchgängen“).

1. **Rohdaten** bereitstellen (Spiegel, siehe oben).
2. **Planen** – global, aber nur auf leichten Daten: OSM lesen; Gebäude­grundrisse aus den LoD2-Kacheln ziehen
   (Kachel für Kachel, Ergebnis pro Rohkachel zwischengespeichert); Straßenflächen flach erzeugen; Gehwegbreiten;
   Wasser, Brücken, Geländeeingriffe (Einschnitte unter Modellen, Flussbett, Rampen hinter Widerlagern) als
   Vektordaten; Stadtbahn; Platzierung von Laternen, Bäumen, Rädern, Autos, Läden. Kein gedraptes Netz, kein
   Gebäude-Netz und kein vollständiges Geländeraster liegt hier je im Speicher.
3. **Gelände** – pro Kachel mit Rand zur Nachbarkachel: DGM lesen, glätten, Eingriffe anwenden, auf 1 cm runden,
   ablegen. Globale Stufen, die Geländehöhen brauchen, fragen sie über eine Quelle ab, die Kacheln bei Bedarf lädt
   und nur wenige im Speicher hält.
4. **Kacheln bauen** – pro 200-m-Chunk, mehrere gleichzeitig: Gebäude-Netze der beteiligten LoD2-Kacheln, Draping
   der Straßenflächen dieses Chunks, Bodennetz, Kollision, Objekte mit ihren Höhen, Darstellungs-GLB. Schreiben,
   freigeben.
5. **Abschluss** – Manifest, Karte, `index.json` (wie in Teil 1 als letzte Datei).

**Gelände in Durchgängen.** Die heutige Pipeline benutzt nacheinander vier Fassungen des Geländes, und jede spätere
Stufe hängt an einer bestimmten: Gebäude stehen auf dem geglätteten Gelände *vor* den Einschnitten; Wasser wird
*nach* den Einschnitten gefunden; Brücken werden *nach* dem Ausheben des Flussbetts geplant; alles Weitere benutzt
das Gelände *nach* den Rampen hinter den Widerlagern. Diese Abhängigkeiten bleiben genau so. Jeder Durchgang ist für
sich kachelweise mit Rand berechenbar; die Planungsschritte dazwischen fragen die jeweils passende Fassung über die
nachladende Quelle ab.

**Rundung ohne Blick auf die ganze Welt.** Heute werden Höhen relativ zum tiefsten Punkt der ganzen Welt auf 1 cm
gerundet, und dieser Punkt ändert sich zwischen den Durchgängen. Künftig wird auf ganze Zentimeter absolut gerundet,
sodass eine Kachel nicht von der übrigen Welt abhängt. Rechnerisch ist das fast überall dasselbe; wo nicht, weicht
eine Höhe um höchstens 1 cm ab.

**Was vom Ganzen abhängen darf.** Der Wasserspiegel des Rheins wird je Rasterzeile über den ganzen Flussstreifen
gemittelt. Das bleibt so und ist ein Ergebnis der Planung; Flusskacheln können sich deshalb ändern, wenn das Gebiet
wächst. Für alle anderen Kacheln gilt: gleiche Eingaben, gleiche Datei.

**Nur Geändertes bauen.** Jede Kachel und jede zwischengespeicherte Zwischenstufe wird unter dem Hash ihrer
Eingaben vermerkt: Rohdateien, die für sie relevanten Plandaten, und der Stand des Pipeline-Codes. Stimmt der Hash,
wird sie nicht neu gebaut. Der Vermerk liegt lokal unter `data/cache/` und – mit Zugangsdaten – im Bucket unter
`builds/`. Eine Änderung am Pipeline-Code baut alles neu; das ist gewollt.

**Zwei Betriebsarten.**
- *Lokal* (ohne Zugangsdaten): vollständige Welt nach `apps/client/public/world`, wie heute.
- *Mit Bucket*: Fertige Kacheln werden sofort hochgeladen (nach den Regeln aus Teil 1: Inhalts-Hash,
  `worlds/<hash>.json` zuletzt); lokal bleiben nur die Dateien, die der Server braucht. Bereits gebaute Kacheln werden
  nicht heruntergeladen, außer den Server-Dateien.

**`--transit-only`** bleibt als schneller Weg erhalten, solange der normale Lauf mit unveränderten Eingaben länger
als eine Minute braucht; danach entfällt die Sonderform.

## Das Weltformat

Pro 200-m-Chunk `(ix, iz)`:

| Datei | Inhalt | Wer lädt sie |
|---|---|---|
| `chunk_ix_iz.glb` | Darstellung, unverändert | Client |
| `sim_ix_iz.bin` | Gelände, Kollision, Objekte | Client und Server |

Dazu Kartenkacheln in gröberem Raster (Vorschlag 1 km) plus eine Übersicht für die herausgezoomte große Karte, die
Modelle (Autos, Räder, Figuren, Ersatzgebäude, Stadtbahn) wie heute, `manifest.json` und `index.json`.

**`sim_ix_iz.bin`** (versioniert, Abschnitte überspringbar):
- **Gelände:** Höhen des Chunks im 1-m-Raster einschließlich der gemeinsamen Randzeile und -spalte, auf 1 cm
  quantisiert. Die dekodierten Höhen sind dieselben wie heute in `terrain.bin`.
- **Kollision:** die Dreiecke dieses Chunks, fertig aufbereitet (ohne flächenlose Dreiecke, große unterteilt, in
  Stücke bis höchstens 1500 Dreiecke zerlegt – das erledigt heute `createPhysicsWorld` beim Laden für die ganze
  Stadt). Die Kollision der Stadtbahn ist enthalten; `transit-collision.bin` entfällt.
  Bordsteine und Gehwege werden heute für die ganze Welt in einem Zug verfeinert, und die Verfeinerung kann sich
  über Chunk-Grenzen fortpflanzen. Pro Chunk gerechnet darf an den Grenzen keine spürbare Stufe entstehen: Die
  Abweichung der Kollisionsfläche vom gedrapten Gelände bleibt innerhalb der heutigen Werte (2 cm Toleranz; heute
  gemessen p99 ≈ 2 cm, Maximum ≈ 11 cm), und der Naht-Test (unten) gilt auch für Bordsteine. Wie das erreicht wird
  (Rechnen mit Rand, oder die Verfeinerung als leichter globaler Schritt in der Planung), entscheidet der
  Umsetzende.
- **Objekte:** Laternen, Bäume, geparkte Autos, Räder und Roller, Fahrradbügel, Läden mit Schildern, Haltestellen –
  jeweils mit **fertiger Höhe und Lage**. Heute berechnen Client und Server diese beim Laden für die ganze Welt
  (teils per Strahl gegen die Kollision), und der Client kommt dabei für Räder außerhalb seiner geladenen Umgebung
  zu einem anderen Ergebnis als der Server. Das entfällt.

**`manifest.json`** enthält nur noch Weltweites: Ursprung, Chunk-Größe, Startpunkt, Grenzverlauf (mit Höhen),
Modell-Listen, das Bahnnetz, Quellenangabe – und das **Chunk-Verzeichnis**: je Chunk Schlüssel, Dateigröße und die
Anzahl seiner Autos, Räder und Laternen.

**IDs.** Die ID eines Autos, Rads oder einer Laterne ist „Summe der Anzahlen aller Chunks davor + Index im Chunk“.
Das Verzeichnis im Manifest erlaubt beiden Seiten, von der ID auf den Chunk zu schließen und umgekehrt, ohne die
Kachel zu laden. Auf der Leitung und im Raum-Zustand werden die IDs 32 Bit breit. IDs gelten nur innerhalb eines
Weltstands (der Welt-Hash sichert das ab). Kartenpositionen der Spieler im Raum-Zustand werden ebenfalls 32 Bit.

**`index.json`** bleibt flach und nennt jede Datei. Für ganz Köln wären das rund 25 000 Einträge und gut 2 MB; das
ist vertretbar. Ein gestufter Index ist ein späterer Schritt.

## Was global bleibt (bewusst)

- Das **Bahnnetz** im Manifest samt Fahrplan, und die Züge als Körper für alle Abschnitte.
- Der **Grenzverlauf**. Wände und Leuchten an der Grenze entstehen nur noch nahe an Spielern.
- Die **Kartenübersicht**.
- `roadgraph.json` wird heute geschrieben, aber von niemandem gelesen; es bleibt unverändert.

Diese Daten wachsen mit der Fläche, aber langsam. Sie sind bei ganz Köln zu messen und gegebenenfalls ein eigener
Schritt.

## Gemeinsame Zugriffsschicht (`packages/shared`)

Eine Schicht, die Client und Server gleich benutzen, ersetzt `WorldAssets` (Manifest + ganze Kollision + ganzes
Gelände):

- **Kachelquelle:** liefert `sim`-Kacheln nach Chunk (Server: von der Platte; Client: über `WorldFiles`).
- **Aktive Menge:** die Chunks, die um eine Liste von Punkten (Spieler, Kamera) gebraucht werden, mit Abständen zum
  Laden und Freigeben (Hysterese wie heute bei `CityTiles`: nötig 160 m, gewünscht 260 m, freigeben 400 m).
- **Geländeabfrage** (`heightAt`, Normale) über die geladenen Kacheln. Eine Abfrage außerhalb der geladenen Menge ist
  ein Programmierfehler und wird als solcher gemeldet, nicht still geklemmt.
- **Physik:** je geladenem Chunk ein Höhenfeld und seine Kollisionsstücke; beim Freigeben werden sie entfernt.
  Stellen, die heute von genau einem Höhenfeld ausgehen (Ausnahme in Treppenschächten, Ragdoll-Kopie), arbeiten mit
  mehreren.
- **Objekte:** Laternen-, Baum- und Bügel-Collider sowie die Listen für Autos und Räder entstehen und verschwinden
  mit ihrem Chunk.

**Nahtlosigkeit ist die zentrale technische Unsicherheit.** Zwei benachbarte Höhenfelder teilen eine Kante; ob
Figur, Rad und Auto darüber ohne Ruck laufen, ist vor dem Rest zu klären: Ein Versuch am Anfang von Baustufe 2
fährt und geht aufgezeichnete Eingaben über Kachelgrenzen und vergleicht mit der heutigen Welt aus einem Höhenfeld.
Abweichung höchstens die Toleranz der Vorhersage (1 cm, 0,002 rad). Trägt die einfache Lösung nicht, entscheidet der
Umsetzende zwischen überlappenden Feldern und einem mitwandernden Fenster und hält das Ergebnis hier fest.

## Client

- Lädt vor dem Start: `index.json`, `manifest.json`, die `sim`- und Darstellungs-Chunks um den Startpunkt, die
  Kartenübersicht. Nicht mehr: ganze Kollision, ganzes Gelände, alle Objektlisten, ganze Karte.
- Darstellung der Objekte (Laternen, Bäume, Autos, Räder, Bügel, Schilder) entsteht pro geladenem Chunk; kein
  Puffer ist mehr nach der Weltzahl bemessen, kein Schild-Atlas für die ganze Welt.
- Die Chunk-Planung und alle Abfragen „in der Nähe“ laufen über ein räumliches Raster, nicht über alle Einträge.
- Dekodieren der `sim`-Kacheln und GLBs blockiert die Darstellung nicht spürbar (Worker oder Zeitscheiben –
  dem Umsetzenden überlassen; Maß: kein Einzelbild über 50 ms durch Laden, gemessen auf dem Entwicklungsrechner).
- Die Karte lädt Kacheln für den sichtbaren Ausschnitt; herausgezoomt zeigt sie die Übersicht.

## Server

- Beim Start: `index.json`, `manifest.json`, sonst nichts.
- **Aktive Menge** um alle verbundenen Spieler; Kacheln werden von der Platte geladen und in Zeitscheiben zu
  Collidern, sodass ein Tick dadurch nicht über sein Budget gerät.
- **Verstellte Objekte** (bewegte oder besetzte Autos und Räder, liegende Laternen) stehen wie heute dünn besetzt im
  Raum-Zustand – unabhängig davon, ob ihr Chunk geladen ist. Alles andere steht an seinem Platz aus der Kachel und
  kostet nichts, solange kein Spieler in der Nähe ist.
- **Keine Schleife über die Welt:** Zündung, Nähe-Prüfung, Rücksetz-Uhren, Abgleich des Raum-Zustands und
  Snapshot-Runde laufen über aktive oder verstellte Objekte. „Nächstes Auto/Rad“ bei Tastendruck fragt das Raster.
- Ein Spieler, der an eine beliebige Stelle gesetzt wird (Beitritt, Teleport im Entwicklungsmodus), wartet, bis
  seine Umgebung geladen ist, bevor er simuliert wird.
- **Niemand überholt das Laden.** Die Umgebung im „nötig“-Abstand eines Spielers wird sofort und vollständig
  geladen, auch wenn ein Tick dadurch länger dauert; nur der Bereich bis „gewünscht“ wird in Zeitscheiben vorgeladen.
  So arbeitet der Client heute schon, und beide Seiten tun dasselbe, damit die Vorhersage stimmt. Der schnellste
  Fall ist der Hubschrauber (38 m/s); der Lasttest muss zeigen, dass das Nachladen dabei im Tick-Budget bleibt, sonst
  werden die Abstände mit der Geschwindigkeit vergrößert. *(Mein Vorschlag.)*
- Ein verstelltes Objekt, dessen Chunk nicht geladen ist, hat keinen Körper und bleibt in seiner letzten Lage
  stehen – so wie heute schon Autos außerhalb von 200 m um jeden Spieler.

## Baustufen

Jede Stufe ist ein eigener Plan und ein eigener Pull Request, und nach jeder ist das Spiel lauffähig.

**Stufe 1 – Pipeline und Rohdaten-Spiegel, Ausgabe unverändert.**
Die schweren Daten (Gebäude-Netze, gedrapte Straßenflächen, Bodennetze) entstehen Chunk für Chunk und werden nach
dem Schreiben freigegeben; geplant wird global auf leichten Daten. Rohdaten kommen aus dem festgehaltenen Stand.
**Prüfstein: Die erzeugte Welt ist Datei für Datei bytegleich mit der Referenzwelt** – das ist die heutige Welt,
gebaut aus demselben Rohdatenstand, ergänzt um den Fahrplan mit festen Stichtagen. Spitzen-RAM unter 4 GB. Client
und Server ändern sich nicht. „Nur Geändertes bauen“ gehört noch nicht dazu (Stufe 3); `--transit-only` bleibt bis
dahin.

*Beim Planen geändert (24.11.2026):* In dieser Stufe bleiben das Gelände ein Raster im Speicher (152 MB beim
heutigen Gebiet) und die Kollision ein globaler Schritt. Die kachelweise Erzeugung des Geländes („Gelände in
Durchgängen“, „Rundung ohne Blick auf die ganze Welt“) ist der riskanteste Teil des Pipeline-Umbaus und bringt beim
heutigen Gebiet keinen messbaren Gewinn; sie wird **ein eigener Schritt vor der Gebietserweiterung** (unten
„Stufe 4“). Die übrigen Abhängigkeiten vom Ganzen (tiefster Punkt für die Rundung, Reihenfolge der Markierungsarten)
bleiben als ausdrückliche globale Vorberechnung erhalten, sodass Bytegleichheit ohne Änderung der Ergebnisse möglich
ist.

**Stufe 2 – Kachelformat, Zugriffsschicht, breitere IDs; Client lädt nach Position.**
Die Pipeline schreibt das neue Format; die alten Sammeldateien entfallen. Client und Server benutzen die gemeinsame
Schicht. Der Server lädt in dieser Stufe noch alle Kacheln beim Start (aktive Menge = alles) – so ändert sich sein
Verhalten nicht, und der Vergleich mit vorher bleibt möglich. Der Versuch zur Nahtlosigkeit steht am Anfang.

**Stufe 3 – Server lädt nach Spielern; nur Geändertes bauen.**
Aktive Menge um Spieler, keine Schleifen über die Welt, Laden in Zeitscheiben. Die Pipeline überspringt Gebautes
anhand der Vermerke (lokal und im Bucket) und lädt Kacheln beim Bau hoch; die CI nutzt das, wenn `WORLD_URL`
gesetzt ist.

**Stufe 4 – Gelände kachelweise erzeugen (vor der Gebietserweiterung).**
Gelände in Durchgängen pro Kachel mit Rand, nachladende Quelle für die globalen Schritte, Wasser und Brücken auf
Fenstern, absolute Rundung. Erst damit hängt der Speicherbedarf der ganzen Pipeline nicht mehr von der Fläche ab. Bis
dahin schneiden die Stufen 2 und 3 das Gelände der `sim`-Kacheln aus dem Raster im Speicher.

## Prüfungen und Budgets

- **Parität (Stufe 1):** Bytevergleich alt gegen neu, als Befehl im Repository, solange die alte Pipeline existiert.
  Die alte Pipeline wird am Ende von Stufe 1 entfernt.
- **Speicher:** Spitzen-RAM des Pipeline-Laufs wird gemessen und in der CI gegen 4 GB geprüft.
- **Unabhängigkeit von der Fläche:** Ein Test baut dieselbe Kachel einmal in einer kleinen und einmal in einer
  großen Welt und erhält dieselbe Datei.
- **Nichts doppelt, nichts verloren:** Summe der Objekte über alle Kacheln = Zahl in der Planung; jedes Dreieck der
  Kollision liegt in genau einer Kachel.
- **Nahtlosigkeit:** der Versuch aus „Gemeinsame Zugriffsschicht“ als bleibender Test.
- **Gleichheit von Client und Server:** bestehende Vorhersage- und Wiederholungstests laufen auf dem Kachelformat.
- **Server-Budget (Stufe 3):** Leerlauf-RAM und Tick-Zeit mit dem bestehenden Lasttest; Leerlauf-RAM deutlich unter
  den heutigen 1,9 GB, und ein Test belegt, dass kein Schritt pro Tick über alle Objekte der Welt läuft.
- **Bestehende Browser-Prüfungen** (`drive-check`, `ride-check`, `mp-check`, `transit-check`, `restart-check`,
  `chat-check` …) laufen nach jeder Stufe.

## Dem Umsetzenden überlassen

- Das Binärformat der `sim`-Kachel im Einzelnen, Raster und Inhalt der Kartenkacheln und der Übersicht.
- Wie die Kachel-Stufe parallelisiert (Prozesse oder Threads) und wie Zwischenstände auf der Platte liegen.
- Wie der Stand des Pipeline-Codes in den Eingabe-Hash eingeht.
- Worker oder Zeitscheiben im Client.
- Die Lösung für nahtlose Höhenfelder, innerhalb der genannten Toleranz.

## Offen bei Daniel

- **CORS am Bucket.** Für das heutige Gebiet nicht nötig; für ein Köln-Image (nur noch schlank sinnvoll)
  Voraussetzung.
- **GitHub-Secrets `S3_*`** werden erst für Stufe 3 gebraucht (Hochladen beim Bau, Vermerke im Bucket). Die
  Rohdaten liest die CI ohne Zugangsdaten aus dem öffentlichen Spiegel.

## Anhang: Was heute die ganze Welt voraussetzt

*(Bestandsaufnahme vom 24.11.2026; Zeilenangaben können sich verschieben.)*

**Gelände.** Ein `TerrainGrid` und genau ein Rapier-Höhenfeld (`packages/shared/src/physics/world.ts`). Beim Laden
für die ganze Welt: Höhe jeder Laterne und jedes Baums (`physics/props.ts`), Lage jedes geparkten Autos
(`sim/cars.ts`, `sim/rules.ts`), Höhe jedes Rads und jedes Bügels per Strahl (`physics/parkedbikes.ts`), Wände entlang
der ganzen Grenze (`world.ts`), Leuchten entlang der ganzen Grenze (Client). Ein einzelner Höhenfeld-Verweis wird in
Treppenschächten ausgenommen (`character.ts`, `bike.ts`, `vehicle.ts`, Client-Kamera); die Ragdoll-Welt kopiert das
Höhenfeld.

**Kollision.** `createPhysicsWorld` bereitet das ganze Netz auf (flächenlose Dreiecke entfernen, große unterteilen,
100-m-Kacheln, dichte Kacheln teilen). Der Server baut alle Stücke; der Client nur nahe am Spieler, hält aber alle
Daten und durchsucht nach 8 m Bewegung alle Stücke.

**Objekte.** Feste Listen und Rapier-Collider für alle Laternen, Bäume und Bügel; Felder für alle Autos und Räder;
im Client `InstancedMesh`-Puffer nach Weltzahl und ein Schild-Atlas für alle Läden. Schleifen über alle: Zündung
(jeder Tick), Nähe-Prüfung (alle 30 Ticks), Rücksetz-Uhren (alle 60), Abgleich des Raum-Zustands (alle 3),
Snapshot-Runde, „nächstes Auto/Rad“ bei Tastendruck; im Client pro Bild u. a. `ParkedCars.always()` und die
Chunk-Planung über alle Chunks, alle 10–20 m die nächsten Laternen, Bäume, Autos, Räder.

**IDs und Breiten.** Index ins Manifest für Autos, Räder, Laternen; `u16` im Snapshot, `int16` im Raum-Zustand
(`carId`, `bikeId`, `driver`, `rider`), Kartenposition `int16` Meter. Das Kennzeichen eines Autos leitet sich aus
seiner ID ab. Positionen im Snapshot ±83 km, Höhe ±327 m, Geländespanne 655 m – bleiben unverändert.

**Sonstiges.** `map.json` wird ganz geladen und indiziert; Bahnnetz und Züge entstehen ganz; die Kommentarzeile in
`sim/assets.ts` nennt noch `manifest.json` als Quelle des Welt-Hashs.

**Tests und Skripte am Weltformat.** `packages/shared/src/sim/fixture.test-util.ts` und seine Nutzer,
`physics/physics.test.ts` (Höhenfeld gegen `heightAt`), `physics/tiles.test.ts`, `packages/pipeline/src/spawn.test.ts`,
`apps/server/src/room.test.ts`, der Lasttest; Skripte, die `spawn`, `parked`, `bikes`, `transit` aus dem Manifest
lesen (`drive-check`, `ride-check`, `mp-check`, `ride-along-check`, `heli-check`, `board-shots`, `car-shots`,
`transit-check`, `make-announcements`); `SERVER_WORLD_FILES`, das Dockerfile, `downloads.ts`, das README.
