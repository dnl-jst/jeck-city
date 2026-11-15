# Minimap und Nippes-Karte – Design

## Absicht

Spieler sollen sich in Nippes zurechtfinden: wissen, wo sie sind, auf welcher Straße, und wie sie zu einer
bestimmten Straße, einem Platz oder einer Haltestelle kommen. Straßennamen sind dafür zentral.

## Ziele

- **Minimap oben rechts**, immer sichtbar (zu Fuß und im Auto), dreht sich mit der Blickrichtung
  (oben = dorthin, wohin die Kamera schaut). Spielerpfeil in der Mitte.
- **Name der aktuellen Straße** unter der Minimap.
- **Große Karte auf Taste M**: ganz Nippes, nach Norden ausgerichtet, Straßennamen entlang der Straßen,
  Plätze und Tramhaltestellen beschriftet, Spielerpfeil mit Blickrichtung. Zoom per Mausrad, verschieben per
  Maus, beim Öffnen auf den Spieler zentriert. M oder Esc schließt.

## Nicht-Ziele (jetzt)

Wegpunkte/Navigation, Läden als Symbole, andere Spieler, Pause-Funktion. Das Datenformat soll Läden später
aufnehmen können, ohne es umzubauen.

## Anti-Ziele

- Unlesbare Beschriftung (gedrehte, verwaschene oder sich überlappende Straßennamen).
- Konflikte mit dem parallelen Terrain-Branch (`terrain-dgm1`): keine Änderung an Manifest, Chunks,
  `collision.bin`, `osm.ts` oder anderen Weltdateien außer der neuen `map.json`.
- Spürbarer Frame-Einbruch durch die Minimap.

## Rahmenbedingungen

- Koordinaten: lokal, x Osten, z Süden (Meter), wie überall im Projekt. Heading-Konvention: Blick entlang
  (sin yaw, cos yaw).
- Der Terrain-Branch baut `pipeline/src/main.ts`, `osm.ts` (mehr Grünflächen), das Manifest (v2), Client
  `main.ts`/`game.ts` und alle Dateien in `public/world/` um. Die Karte ist 2D und vom Gelände unabhängig.
  Deshalb sollen die Berührungspunkte klein bleiben: eine neue Datei je Paket plus wenige Zeilen in
  `main.ts`/`game.ts`/`hud.ts`.
- Es gibt kein Größenbudget für Assets; Lesbarkeit geht vor.
- HUD-Stil: DOM/CSS, dunkler Grund, Akzent `#f2c46b`, `system-ui`.

## Ansätze

1. **Vektordaten aus der Pipeline, im Client per Canvas 2D gezeichnet** – *gewählt.* Beschriftung bleibt bei
   Zoom und Drehung lesbar, nur eine neue Datei `world/map.json`, profitiert automatisch von mehr Grün aus
   dem Terrain-Branch.
2. Fertiges PNG aus der Pipeline – verworfen: neue Render-Abhängigkeit, Schrift dreht sich in der Minimap
   mit und wird beim Zoomen unscharf.
3. 3D-Welt von oben abfilmen – verworfen: keine Namen, nachts zu dunkel, zeigt nur geladene Chunks.

## Entscheidungen

### Daten: `world/map.json` (neu)

Erzeugt von `packages/pipeline/src/map.ts` (reine Funktion `buildMapData(f, buildings, graph)`), aufgerufen
in `pipeline/src/main.ts` mit wenigen Zeilen. Typ `MapData` und ein Leser/Validator in
`packages/shared/src/assets/map.ts` (analog zu `manifest.ts`), damit Client und Pipeline dasselbe Format
teilen. Koordinaten auf 0,1 m gerundet (wie `r2` bzw. gröber). Inhalt:

- `version: 1`
- `bounds` (minX, minZ, maxX, maxZ), `boundary` (Stadtteilgrenze)
- `roads`: Polyline, `kind` (OSM highway), `name?`, `width` – alle Straßen inkl. Fuß-/Radwege, damit die
  Karte auch zu Fuß stimmt; Zeichenreihenfolge/-stil nach `kind`.
- `buildings`: Grundrisse. Quelle sind die behaltenen LOD2-Gebäude (`buildings` in `main.ts`); der Grundriss
  ergibt sich aus den Dachdreiecken (kind = 1) in xz-Projektion. Format nach Wahl des Umsetzers (z. B.
  Dreiecke oder vereinigte Polygone); wichtig ist nur, dass die gefüllte Fläche dem Grundriss entspricht.
- `greens`, `squares` (mit Name), `tram` (Gleis-Polylines), `tramStops` (Name + Position).

`map.json` darf nicht an `manifest.json` hängen (eigener Fetch im Client).

Behaltene Gebäude inkl. Backdrop-Gebäude (Flag 2) kommen auf die Karte; Gebäude, die durch Ersatzmodelle
(Overrides) ersetzt sind, ebenfalls mit ihrem LOD2-Grundriss. Straßen werden nicht an der Grenze
abgeschnitten (die Karte zeigt, was auch in 3D da ist).

**Erzeugen (Entscheidung Claude):** Die Worktree hat kein `data/raw`; es wird aus dem Haupt-Checkout
verlinkt (`/home/dj/projects/nippes-nights/data/raw`). Volle Pipeline laufen lassen, **nur `map.json`
committen**, alle anderen geänderten Dateien in `public/world/` zurücksetzen. Nach dem Merge von
`terrain-dgm1` die Pipeline einmal neu laufen lassen, damit die zusätzlichen Grünflächen in `map.json`
landen. Der Export in `packages/shared/src/index.ts` wird mit dem Terrain-Branch trivial kollidieren.

### Client

- Neues Modul `apps/client/src/map/` (z. B. `map-render.ts` für das Zeichnen, `minimap.ts`, `big-map.ts`,
  `street-label.ts`). Kartenlogik ohne DOM testbar (Projektion, Labelplatzierung, nächste Straße).
- Basiskarte ohne Beschriftung einmal in ein Offscreen-Canvas rendern (hoch genug aufgelöst für die
  Minimap). Minimap: pro Frame Ausschnitt gedreht blitten, dann Pfeil. Große Karte: bei Zoom/Pan neu
  zeichnen (Vektoren direkt), Beschriftung immer aufrecht und waagerecht bzw. entlang der Straße, nie
  kopfüber; Kollisionsvermeidung zwischen Labels; bei kleinem Zoom nur wichtige Straßen beschriften.
- **Aktuelle Straße:** nächstgelegene benannte Straße zur Spielerposition (zu Fuß Fußwege eingeschlossen,
  aber nur wenn benannt), mit kleiner Hysterese, damit der Name an Kreuzungen nicht flackert. Kein Name in
  der Nähe → Zeile leer.
- **Drehung der Minimap:** nach der Kamera-Yaw (`follow.yaw`), damit „oben“ dem Bild entspricht – im Auto
  folgt die Kamera ohnehin dem Fahrzeug.
- **Taste M** in `Input`/`game.ts` (`consume('KeyM')`), zu Fuß und im Auto, unabhängig von der
  Geschwindigkeit. Bei offener Karte: keine Steuereingaben (zu Fuß steht man; im Auto kein Gas, keine
  Lenkung, keine Bremse/Handbremse – **das Auto rollt einfach weiter und aus**, so entschieden). Maus-dx/dy
  verschiebt die Karte, Mausrad zoomt (nicht Radio); E/R/Space wirken nicht. Esc schließt: unter Pointer Lock
  kommt Esc nur als Lock-Verlust an, also auf `pointerlockchange` schließen. `CONTROLS_HINT` um „M Karte“
  ergänzen.
- Fly-Modus (Debug): Minimap folgt der Fly-Kamera; sonst keine Sonderbehandlung.
- Ladefehler von `map.json`: Spiel läuft ohne Karte weiter, Minimap ausgeblendet.

### Darstellung (Vorschlag, beim Bauen abstimmbar)

Nachtstil: dunkelblau-grauer Grund, Gebäude etwas heller, Grün gedämpft, Straßen hell bis bernsteinfarben
nach Wichtigkeit, Tram als feine Linie, Spielerpfeil `#f2c46b`. Minimap rund, ca. 180 px, ca. 250 m
Durchmesser, Nordmarker „N“ am Rand, der mitwandert.

## Dem Umsetzer überlassen

Genaue Farben/Strichstärken, Format der Gebäudegrundrisse in `map.json`, Auflösung des Offscreen-Canvas,
Zoomgrenzen, Labelalgorithmus im Detail, Dateiaufteilung im Client.
