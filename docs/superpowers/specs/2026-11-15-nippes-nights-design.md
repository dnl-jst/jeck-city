# Nippes Nights – Design (Version 1: Erkunden)

Stand: 2026-11-15

## Absicht und Warum

Ein eigenständiges Open-World-Browserspiel, das in Köln-Nippes spielt. Version 1 ist reines Erkunden: man läuft zu Fuß oder fährt Auto durch das Veedel. Es ist ein eigenes Spiel im Genre, kein Nachbau von GTA – keine Namen, Figuren, Logos, Musik oder Optik aus GTA.

Der Kern-Moment: Man startet auf der Neusser Straße und erkennt sie sofort wieder. Wiedererkennbarkeit des echten Ortes ist das Wichtigste; alles andere ordnet sich dem unter.

## Ziele

- 3D, läuft im Browser (Desktop), ohne Installation.
- Startpunkt auf der Neusser Straße in Nippes.
- Zu Fuß gehen und in ein Auto ein-/aussteigen und fahren.
- Gebäude mit echter Höhe und Dachform (NRW LoD2), Straßen, Gehwege, Straßenbahngleise, Bäume, Plätze aus OpenStreetMap.
- Neusser Straße bekommt die höchste Detailstufe: Ladenlokale im Erdgeschoss, Gründerzeit-Fassaden, Straßenbahn-Gleise und -Haltestellen, Laternen, Bäume, Straßenmöbel.

## Nicht-Ziele (Version 1)

- Missionen, Gegner, Polizei, Waffen, Geld, Story.
- Fußgänger- und Verkehrs-KI (eine fahrende Straßenbahn wäre ein Bonus, kein Muss).
- Innenräume.
- Mobile/Touch-Steuerung.
- Interaktion zwischen Spielern über Kollisionen hinaus (Schaden, Kämpfe, gemeinsam in einem Auto sitzen).
- Chat, Accounts, gespeicherte Spielstände.
- Ganz Köln. Nur Nippes.

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es technisch läuft)

- Sieht aus wie eine generische Klötzchen-Stadt, in der man die Neusser Straße nicht erkennt.
- Wirkt wie ein GTA-Klon (Optik, HUD, Namen, Logos).
- Ruckelt auf einem normalen Laptop so sehr, dass Fahren keinen Spaß macht.

## Rahmenbedingungen

- Nur offene Daten:
  - NRW 3D-Gebäudemodell LoD2 (CityGML, 1×1-km-Kacheln, EPSG:25832, Lizenz dl-de/zero-2.0), Quelle: `https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/`, z. B. `LoD2_32_356_5649_1_NW.gml`.
  - OpenStreetMap (ODbL → Namensnennung „© OpenStreetMap-Mitwirkende“ im Spiel sichtbar).
  - Keine Google-/kommerziellen 3D-Tiles.
- Spiel-Client und 3D-Daten werden als statische Dateien ausgeliefert; dazu ein eigener Node-Server für Mehrspieler (kein Cloudflare, kein Next.js – Nutzerentscheidung bzw. siehe Mehrspieler).
- Ausgelegt auf 100 gleichzeitige Besucher. Mehr Last wird über einen stärkeren Server gelöst, nicht über Umbau.

## Mehrspieler (Version 1)

- **Ablauf (Nutzer):** Seite öffnen → Namen eingeben → Spiel lädt → man spawnt auf der Neusser Straße. Alle anderen Besucher („Lück“) sind in der Welt sichtbar.
- **Echte Kollisionen (Nutzer):** Spieler kollidieren miteinander – zu Fuß wie im Auto –, und alle sehen dasselbe Ergebnis. Der Server ist Schiedsrichter.
- **Server (Nutzer: Option B):** Node.js + Colyseus, ein gemeinsamer Raum „Nippes“. Hosting auf eigenem VPS oder Fly.io; Claude wählt eines und dokumentiert das Deployment.
- **Claude entschieden:**
  - **Server-autoritative Physik:** Der Server lädt die Kollisionsgeometrie von Nippes (eigenes Asset aus der Datenaufbereitung) und simuliert alle Spieler und Autos mit Rapier in festem Takt (ca. 30 Hz). Clients senden nur Eingaben (Tasten, Blickrichtung) mit Sequenznummer.
  - **Eigene Figur sofort reaktionsschnell:** Der Client simuliert die eigene Figur/das eigene Auto mit derselben Rapier-Physik voraus (Client-Side Prediction) und gleicht sich mit dem Server-Stand ab (Reconciliation), ohne sichtbares Springen bei normaler Latenz (bis ~150 ms).
  - **Andere Spieler** werden aus Server-Snapshots (ca. 15–20 Hz) interpoliert dargestellt.
  - **Autos sind gemeinsame Objekte:** Geparkte Autos gehören dem Server. Steigt jemand ein, ist das Auto für andere belegt. Steigt jemand aus oder verlässt das Spiel, bleibt das Auto dort stehen. Angestoßene Autos bewegen sich für alle. Eine feste Anzahl Autos wird an Straßenrändern verteilt; Autos, die lange unbenutzt herumstehen, werden zurückgesetzt.
  - **Was bei Zusammenstößen passiert:** Fußgänger schubsen sich gegenseitig. Ein Auto, das einen Fußgänger trifft, stößt ihn weg; er fällt kurz hin und steht nach etwa einer Sekunde wieder auf. Kein Schaden, keine Verletzungen, kein Blut. Autos untereinander prallen physikalisch voneinander ab.
  - **Interessenbereich:** Jeder Client bekommt nur Spieler und Autos im Umkreis von einigen hundert Metern.
  - **Last:** Server-Physik für 100 Spieler plus Autos muss auf einem Server mit 2 vCPU flüssig laufen; ein Lasttest mit 100 simulierten Bots gehört zur Abnahme.
  - **Name** über dem Kopf/Auto. Name: 2–20 Zeichen, einfacher Schimpfwortfilter, Duplikate bekommen eine Nummer („Jupp 2“). Nichts wird gespeichert.
  - Automatische Wiederverbindung bei kurzem Verbindungsabbruch; bei endgültigem Abbruch verschwindet die Figur nach wenigen Sekunden.
  - Gemeinsamer Code (Physik-Regeln, Fahrzeug-Tuning, Nachrichtenformate) liegt in einem Paket, das Client und Server beide nutzen, damit Vorhersage und Server-Ergebnis übereinstimmen.

## Ansätze (betrachtet)

1. **Three.js + OSM, Gebäude aus OSM-Grundrissen extrudiert.** Schnell, klein. Aber OSM-Höhen in Nippes lückenhaft, nur Flachdächer → Klötzchen-Look. Verworfen wegen Anti-Ziel 1.
2. **Three.js + NRW-LoD2-Gebäude + OSM für alles andere.** Echte Höhen und Dachformen, Straßenraum aus OSM. Mehr Aufwand bei der einmaligen Datenaufbereitung. **Gewählt** (Entscheidung des Nutzers).
3. **Fotorealistische 3D-Tiles (Google/Cesium).** Sofort realistisch, aber kostenpflichtiger API-Key, Nutzungsbedingungen schließen Spiele aus, holprige Scan-Oberfläche nicht befahrbar. Verworfen.

## Entschiedenes zum Wie

- Vom Nutzer entschieden: 3D; Ansatz 2; Name „Nippes Nights“; Start auf der Neusser Straße.
- Von Claude entschieden (korrigierbar):
  - **Engine:** Three.js, TypeScript, Vite.
  - **Datenaufbereitung offline:** Ein Build-Skript lädt LoD2-Kacheln und OSM-Daten (Overpass) einmalig, wandelt sie in ein lokales Koordinatensystem (Meter, Ursprung nahe Startpunkt) und schreibt kompakte Spiel-Assets (z. B. glTF/Binär-Chunks). Das Spiel lädt nur diese Assets, keine Live-APIs. Rohdaten werden nicht ins Repo eingecheckt, die erzeugten Assets schon (oder reproduzierbar per Skript).
  - **Gelände:** Flach angenommen (Nippes ist nahezu eben). Gebäude-Sockel auf gemeinsame Bodenhöhe normalisiert.
  - **Fassaden:** LoD2 hat keine Fassadentexturen. Fassaden werden prozedural gestaltet (Fensterraster nach Geschosshöhe, Gründerzeit-Stil für Altbauten, Ladenzeilen im EG an Neusser Straße, Farbvariation je Gebäude). Dächer in Ziegel-/Schiefertönen.
  - **Straßenraum:** Fahrbahnen, Gehwege, Gleise, Grünflächen, Bäume, Laternen aus OSM-Geometrie und -Tags generiert.
  - **Steuerung:** Third-Person-Kamera. WASD/Pfeiltasten, Maus zum Umsehen, E zum Ein-/Aussteigen am nächstgelegenen geparkten Auto.
  - **Fahrphysik:** Arcade-Stil mit Rapier (läuft identisch im Browser und auf dem Server), Kollision mit Gebäuden und Bordsteinen; kein Schaden.
  - **Tag und Nacht (Nutzer):** Die Spielzeit folgt 1:1 der echten lokalen Zeit des Browsers. Sonnenstand (Höhe, Richtung, Farbe des Lichts) wird aus der aktuellen Uhrzeit und Datum für die Koordinaten von Köln-Nippes berechnet, inklusive Dämmerung. Nachts: Straßenlaternen, beleuchtete Schaufenster, Fenster mit zufälligem Licht. Beide Lichtstimmungen sind Pflicht und müssen gleich gut aussehen. (Claude:) Eine versteckte Entwickler-Taste/URL-Parameter erlaubt, die Uhrzeit zum Testen zu überschreiben.
  - **Läden (Nutzer):** Erfundene Ladennamen, gerne als Anspielung auf echte Läden der Neusser Straße (Wortspiel, kölsche Abwandlung). Keine echten Logos, keine Namen, die mit echten Marken verwechselbar sind. Die Position von Ladenlokalen darf sich an OSM-`shop`/`amenity`-Einträgen orientieren.
  - **Nur offene Daten (Nutzer):** Version 1 verwendet ausschließlich LoD2 + OSM + prozedurale Gestaltung; keine handmodellierten Landmarken, keine Fotos. Verfeinerung später möglich, die Architektur soll das Einfügen einzelner handgemachter Gebäude später erlauben (Gebäude per ID ersetzbar).
  - **Spielbereich:** Stadtteil Nippes laut OSM-Verwaltungsgrenze. Unsichtbare Grenze am Rand; Gebäude knapp außerhalb als Kulisse ohne Detail.
  - **Leistungsziel:** ≥ 50 fps auf dem Mac des Nutzers (Referenzgerät) in Chrome, bei Tag und bei Nacht; Ladezeit < 10 s bei normaler Leitung. Nachtlicht über günstige Mittel (Emissive-Materialien, wenige echte Lichtquellen nahe der Kamera), nicht hunderte dynamische Lichter.
  - **Vorbereitung für später:** Die Datenaufbereitung exportiert zusätzlich ein Straßen- und Gleisnetz als Graph (Fahrspuren, Richtungen, Haltestellen), damit Verkehr, fahrende Straßenbahn und Missionen später ohne Neuaufbau möglich sind. In Version 1 wird es nur gespeichert, nicht genutzt.
  - **Wiedererkennung prüfen:** Der Nutzer prüft im Browser, ob die Neusser Straße wiedererkannt wird; dazu Vergleich mit Kartenansicht/Street-Level-Fotos durch den Nutzer.
  - **Qualität:** Datenaufbereitung (Koordinatenumrechnung, Parsing) wird mit automatischen Tests abgesichert; das Spielgefühl wird manuell im Browser geprüft.

## Dem Builder überlassen

- Genaue Startkoordinate auf der Neusser Straße (Vorschlag: Höhe Wilhelmplatz) und Blickrichtung.
- Wahl der Bibliotheken für CityGML-Parsing, Triangulierung, Physik.
- Chunking/LOD-Strategie, um das Leistungsziel zu erreichen.
- Fahrzeug- und Spielerfigur-Modelle (einfach, eigenständig gestaltet, keine fremden Assets mit unklarer Lizenz).
- Konkrete Fassaden-Regeln und Farbpaletten.
