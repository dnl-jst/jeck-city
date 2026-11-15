# Nippes Nights — Echtes Gelände (DGM1)

Stand: 2026-11-15 · Branch `terrain-dgm1`

## Absicht

Die Spielwelt ist bisher komplett flach (y = 0 überall; Design-Spec: „Gelände flach angenommen“). Das stimmt nicht:
Nippes liegt zwischen ~43 und ~50 m NHN, mit einer deutlichen Geländestufe von 3–4 m nach Osten Richtung Rhein
(≈ 300–500 m östlich des Spawns). Wer Nippes kennt, soll die echten Steigungen und Kanten wiedererkennen.

## Ziele

- Boden, Straßen, Gehwege, Bordsteine, Grünflächen, Plätze und Gleise folgen dem echten Gelände.
- Gebäude stehen auf ihrer echten Höhe (LoD2-Koordinaten sind bereits absolute NHN-Höhen).
- Laternen, Bäume, Haltestellen, Ladenschilder, geparkte Autos, Spawn, Spieler und Fahrzeug stehen auf dem Gelände.
- Physik (Laufen, Fahren, Raycasts) nutzt dasselbe Gelände wie die Darstellung.

## Nicht-Ziele

- **Keine Brücken** (Entscheidung des Nutzers). Straßen auf Brücken (im Spielgebiet: Kempener Straße, Frohngasse;
  Stadtbahnbrücke am Niehler Gürtel) folgen dem Boden darunter. Unterführungen unter Bahndämmen erscheinen als
  Kerbe im Damm, ohne Brückenkörper darüber. Bekannte, akzeptierte Schwäche.
- Keine DB-Gleise auf dem Bahndamm (der Damm selbst ist im Gelände enthalten, als begrünter Hügel).
- Keine Tunnel/Unterführungen als begehbare Röhren; die Stadtbahn-Tunnelstrecken bleiben weggelassen wie bisher.

## Anti-Ziele (wäre ein Misserfolg, auch wenn es technisch läuft)

- Straßen, Gehwege oder Gleise, die über dem Boden schweben, darin versinken oder flackern (z-fighting).
- Gebäude mit sichtbarem Spalt unter der Wand oder die sichtbar „im Hang stecken“ ohne Sockel.
- Physik-Boden, der vom sichtbaren Boden abweicht (Füße/Räder schweben oder sinken ein).
- Treppenstufen- oder Rauschmuster im Boden (Raster-Artefakte des DGM).

## Datenquelle

NRW DGM1 (digitales Geländemodell, 1-m-Raster, nur Boden ohne Bebauung/Vegetation/Brücken), GeoTIFF,
Lizenz dl-de/zero-2.0:
`https://www.opengeodata.nrw.de/produkte/geobasis/hm/dgm1_tiff/dgm1_tiff/dgm1_32_<E>_<N>_1_nw_<Jahr>.tif`

- Dieselben 12 Kacheln wie LoD2 (E 355–357, N 5646–5649); aktuell Jahrgang 2022. Der Jahrgang steckt im
  Dateinamen → den Namen aus dem Verzeichnis-Listing ermitteln oder als Konstante führen (Builder-Entscheidung),
  Download nach `data/raw/dgm1/`, gecacht wie LoD2.
- Format geprüft: 1000×1000 Float32, LZW, Ursprung = NW-Ecke der Kachel, Auflösung 1 m, NoData −9999 (in der
  Probekachel keine). ~1,9 MB je Kachel. Lesbar in Node mit dem npm-Paket `geotiff`.
- Plausibilität geprüft: DGM-Höhen decken sich mit den LoD2-Sockelhöhen (West ~48 m, Ost ~44–45 m).
- Die Kacheln decken die Weltfläche (Boundary-BBox + 200 m) vollständig ab.
- Attribution erweitern: „3D-Gebäude und Gelände: Geobasis NRW (dl-de/zero-2.0)“.

## Gewählter Ansatz

Betrachtete Wege:

- **A. Alles in der Pipeline backen, Physik als Höhenfeld (gewählt).** Pipeline baut das Bodennetz und legt alle
  Straßengeometrie exakt darauf; liefert zusätzlich eine Höhendatei, aus der der Client Props platziert und die
  Physik ein natives Rapier-Höhenfeld baut. Exakt und schnell zur Laufzeit; größerer Pipeline-Umbau, größere Chunks.
- B. Nur Höhendatei ausliefern, Client verformt die flachen Meshes beim Laden. Verworfen: die flach gebackenen
  Straßenbänder haben zu wenige Stützpunkte und würden schweben/flackern (Anti-Ziel).
- C. Wie A, Kollision als ein großes Dreiecksnetz. Verworfen: Millionen Dreiecke, langsam beim Laden und in der
  Physik; bringt gegenüber dem Höhenfeld nichts, da beide aus demselben Raster kommen.

## Design

### Ein Geländeraster für alles

- Pipeline liest die 12 DGM-Kacheln, schneidet auf die Weltfläche (`worldRect`) zu und glättet mit einem Gauß-Filter.
  **Glättung σ = 1 m als Startwert** (Nutzer: „eher schwach, 1–2 m“), als Konstante; endgültiger Wert nach
  Screenshot-Vergleich, höchstens 2 m. Messung an der Spawn-Kachel: σ = 1 m ändert 99 % der Punkte um < 18 cm,
  σ = 2 m um < 39 cm; große Abweichungen nur an senkrechten Kanten (Stützmauern, Dammböschungen).
- **Ein** Raster mit **1 m Abstand** ist die einzige Wahrheit für: das sichtbare Bodennetz, das Physik-Höhenfeld
  und Höhenabfragen im Client. Alle drei triangulieren jede Rasterzelle mit derselben Diagonale, sodass Darstellung
  und Physik exakt übereinstimmen. (Die Diagonalrichtung von Rapiers Höhenfeld ist maßgeblich; Bodennetz und
  Client-Abfrage richten sich danach.)
- **Bezugshöhe (Claude-Entscheidung):** y = NHN − `datum`, `datum` = geglättete Geländehöhe am Ursprung, auf 0,1 m
  gerundet, steht im Manifest. So bleibt die Gegend um den Spawn nahe y = 0.

### Ausgeliefert

- `terrain.bin` (neu): Kopf (Rastergröße, Ursprung x/z, Abstand 1 m, `datum`, Höhenbasis) + Höhen als Uint16 in
  Zentimetern über der Höhenbasis (Spanne ~26 m passt). Bei ~2,4 × 2,6 km ≈ 6 Mio Werte ≈ 12 MB; kein Größenbudget
  (Nutzer: Optik vor Downloadgröße). Format/Kompression ist Builder-Entscheidung, solange das Raster verlustfrei auf
  1 cm ist.
- Manifest: `datum`; Version erhöhen.
- Chunk-GLBs: neues Mesh `ground` je Chunk (1-m-Raster, ~80 000 Dreiecke je 200-m-Chunk), mit Normalen.
- **Keine Detailstufen für ferne Chunks (Claude-Entscheidung):** zunächst überall das volle 1-m-Netz (~28 geladene
  Chunks ≈ 2,3 Mio Boden-Dreiecke plus Schattenpass). Erst wenn die Bildrate im echten Browser spürbar einbricht,
  werden gröbere Stufen für die Ferne nachgerüstet — als eigener Folgeschritt.

### Straßenraum auf dem Gelände („Drapieren“)

- Alle Straßen-Meshes (`road`, `sidewalk`, `curb`, `tram`, `green`, `squares`) werden an den Rasterlinien und der
  Zellendiagonale zerschnitten, sodass jedes Teildreieck in genau einem Geländedreieck liegt. Jeder Eckpunkt bekommt
  Geländehöhe + sein bisheriger kleiner Versatz (ROAD_Y, GREEN_Y, RANK_STEP …). Dadurch liegen die Flächen exakt
  parallel zum Boden, die bestehenden Millimeter-Versätze gegen z-fighting bleiben wirksam.
- Bordsteinkanten (senkrechte Flächen) und erhöhte Gehwege (0,12 m) behalten ihre Höhe relativ zum Gelände.
- Das Client-Gleisbett (`trackbed.ts`, bisher fest `BED_Y = 0.016`) übernimmt die Höhe aus den Gleis-Vertices
  (Schienenhöhe − Differenz), statt eines festen Werts.
- Die Kollision enthält weiterhin Bordsteine und Gehwege (drapiert), dazu das Höhenfeld statt des bisherigen
  Boden-Rechtecks bei y = 0.

### Gebäude

- Gebäude-Vertices bekommen y = LoD2-NHN − `datum` (statt − eigenes minZ). Das ist die echte Höhe.
- Fassaden-UV (Höhe über Grund, steuert Geschossraster und Ladenzone) bleibt relativ zum LoD2-Sockel des Gebäudes,
  damit sich das Fassadenbild nicht ändert.
- **Sockel (Claude-Entscheidung):** Wo das geglättete Gelände unter einer Wand tiefer liegt als der LoD2-Sockel,
  werden die Wände nach unten verlängert bis unter das Gelände (z. B. bis Gelände-Minimum unter der Grundfläche
  − 0,3 m). Diese Verlängerung (Fassaden-v < 0) zeigt der Fassaden-Shader als schlichten Sockel. Hangseitig
  verschwindet der Wandfuß im Boden, das ist gewollt.
- Handgebaute Ersatzmodelle (`data/building-overrides.json`, Weltkoordinaten mit Boden bei y = 0) werden um die
  LoD2-Sockelhöhe ihres Gebäudes (− `datum`) nach oben verschoben, ebenso ihre Kollisionsdreiecke. Ersetzt ein Modell
  mehrere LoD2-Gebäude (`wilhelmplatz-tribuene`: 3, `neusser-florastrasse`: 4), gilt der **niedrigste** Sockel dieser
  Gebäude (Claude-Entscheidung); per Screenshot prüfen.

### Aussehen des freien Bodens

Alles außerhalb von Straße, Gehweg und kartierten Grünflächen (Hinterhöfe, Brachen, Bahndamm) ist bisher graues
Pflaster (`street.ground`, `0x8a877f`). Mit Gelände wäre der Bahndamm ein gepflasterter Hügel. **Nutzer-Entscheidung:
beides kombinieren:**

- **Grün aus der Karte (Pipeline):** Die Grünflächen aus OSM (`osm.ts`, bisher `landuse=grass/village_green/
  recreation_ground`, `leisure=park/garden`) werden um Bahn- und Böschungsflächen erweitert, mindestens
  `landuse=railway`; weitere passende Tags (z. B. `landuse=meadow`, `natural=scrub/grassland`, `man_made=embankment`)
  wählt der Builder anhand der tatsächlichen Daten im Spielgebiet. Sie werden wie die übrigen Grünflächen drapiert.
- **Steiles wird grün (Client):** Der Boden-Shader des `ground`-Meshes blendet nach Neigung von Pflaster zu Gras,
  sodass auch unkartierte Böschungen grün werden; flache Flächen bleiben wie heute. Schwellwerte (Startidee: ab
  ~15° beginnend, ab ~25° voll Gras) per Screenshot abstimmen. Dafür braucht das `ground`-Mesh Normalen.

### Client

- Neue Höhenabfrage `heightAt(x, z)` aus `terrain.bin` (in `@nn/shared`, von Pipeline-Tests und Client genutzt),
  exakt gleiche Triangulation wie das Höhenfeld.
- Physik: Rapier-Höhenfeld-Collider aus `terrain.bin` zusätzlich zum bestehenden Trimesh (Gebäude, Bordsteine,
  Gehwege). Die unsichtbaren Grenzwände (`addBoundaryWalls`) reichen vom Gelände aus nach oben (Höhe je Segment aus
  dem Gelände bestimmen).
- Ladenschilder sitzen im Schilderband der Fassade (3,15–3,88 m über dem LoD2-Sockel) → ihre Höhe kommt aus der
  Sockelhöhe ihres Gebäudes, nicht aus `heightAt` (Claude-Entscheidung; die Pipeline schreibt sie ins Manifest).
- Laternen, Bäume, Haltestellen, geparkte Autos: y aus `heightAt` (+ bisheriger Versatz; Laternen und
  Bäume stehen auf dem Gehweg → + Gehweghöhe wo zutreffend, Builder prüft das gegen die Kollision/den Raycast).
  Geparkte Autos zusätzlich an die Geländeneigung ausrichten (geringe Neigung, aber sichtbar an der Geländestufe).
- Spawn: nutzt schon `surfaceY` per Raycast — bleibt so.
- Ferner Boden: Die 6000-m-Bodenebene in `main.ts` liegt bisher bei y = 0. Sie wird auf die niedrigste Randhöhe
  des Geländes (− kleiner Versatz) gesenkt, damit am Rand der Weltfläche keine Lücke entsteht.

### Doku

- Design-Spec `2026-11-15-nippes-nights-design.md`: Abschnitt „Gelände: flach angenommen“ auf diese Spec verweisen.

## Verbleibende Builder-Entscheidungen

- Wie das DGM-Jahr im Dateinamen ermittelt wird (Listing vs. Konstante).
- Exaktes Dateiformat von `terrain.bin` und ob das Raster pro Chunk oder als Ganzes geladen wird.
- Algorithmus für das Zerschneiden der Straßen-Meshes am Raster (Sutherland-Hodgman pro Zelle o. Ä.).
- Endgültiges σ (1–2 m) nach Screenshots.
- Ob Bodennetz-Normalen aus dem Raster (zentrale Differenzen) oder aus den Dreiecken kommen.

## Prüfung

- Unit-Tests für: DGM-Lesen/Zuschnitt, Glättung, `heightAt` (gleiche Triangulation wie Höhenfeld), Drapieren (jeder
  Vertex auf Geländehöhe + Versatz, kein Dreieck über eine Rasterzelle hinaus), Gebäudehöhe und Sockel.
- Pipeline läuft durch, `npm run typecheck`, `npm test`.
- Screenshots (`npm run screenshot`) an: Spawn, Geländestufe nach Osten, Bahndamm im Westen, Kempener Straße
  (bekannte Schwäche dokumentieren), ein Gebäude am Hang (Sockel), Tag und Nacht.
- `npm run drive-check` / `npm run accept` laufen weiter: Fahren über die Geländestufe ohne Hängenbleiben, Laufen
  ohne Schweben/Einsinken.
