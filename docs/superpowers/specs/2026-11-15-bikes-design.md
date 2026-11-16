# Fahrräder und Fahrradständer – Design

Stand: 2026-11-15

## Absicht und Warum

Man soll in Nippes auch Rad fahren können – und das soll **richtig Spaß machen**, im Gefühl vergleichbar mit Rennradfahren in GTA 5 (Nutzer): schnell, direkt, deutliche Schräglage, kräftig antreten, Bordsteine mitnehmen, durch Lücken, wo kein Auto passt. Vorbild ist nur die Spielmechanik/das Gefühl; Optik, Modelle und Namen bleiben eigenständig (siehe Anti-Ziele des Hauptdesigns).

Dazu gehören Fahrradständer am Straßenrand, in denen Räder stehen, mehrere Radmodelle inklusive Lastenräder, und am Spawnpunkt steht immer ein Lastenrad bereit (Nutzer).

## Ziele

- Nutzbare Fahrräder: hingehen, **E** zum Aufsteigen, fahren, **E** zum Absteigen – wie beim Auto.
- Fünf Radtypen (Nutzer: „alle Rädertypen“), modelliert in Blender über den Blender MCP (Nutzer):
  1. **Hollandrad** (Stadtrad, aufrecht, Korb/Gepäckträger) – häufigstes Rad in den Ständern
  2. **Rennrad** – schnellstes Rad
  3. **Mountainbike**
  4. **Long John** (zweirädriges Lastenrad, Kiste vorn zwischen Lenker und kleinem Vorderrad)
  5. **Dreirad-Lastenrad** (Kiste vorn auf zwei Vorderrädern, Knicklenkung der Kiste)
- **Fahrradständer** an den echten Standorten aus OSM (`amenity=bicycle_parking`, in Nippes 205 Einträge, meist `stands`, Kapazität meist 4–16), teilweise mit Rädern belegt; jedes Rad im Ständer ist nutzbar.
- **Am Spawnpunkt steht immer ein Lastenrad** (Long John), fahrbereit, neben dem Spieler auf dem Gehweg.
- Fahrgefühl „macht Spaß“ steht über Realismus.

## Nicht-Ziele

- Radwege-KI, NPC-Radfahrer, Verkehr.
- Gangschaltung, Ausdauer/Erschöpfung, Diebstahl/Schlösser, Schaden am Rad.
- Fahrradverleih-Stationen, Fahrradboxen/-häuschen als begehbare Objekte (`lockers`, `shed` werden als einfache Kulisse oder gar nicht gebaut).
- Stunts über Sprünge hinaus (Wheelies, Tricks).
- Räder auf der Karte/Minimap anzeigen.

## Anti-Ziele (Fehlschlag, auch wenn es technisch läuft)

- Rad fühlt sich an wie ein schmales Auto oder wie schnelles Laufen.
- Rad bleibt an jedem Bordstein hängen oder zappelt/zittert auf unebenem Gelände.
- Räder sehen aus wie Klötzchen – die Modelle sollen als Hollandrad, Rennrad usw. erkennbar sein.
- Ständer und Räder kosten so viel Leistung, dass das ≥ 50-fps-Ziel des Hauptdesigns reißt.

## Rahmenbedingungen

- Physik liegt wie bei Auto und Figur im gemeinsamen Paket (`packages/shared/src/physics`), alle Zahlen in `TUNING` – damit später der Mehrspieler-Server dieselbe Radphysik rechnet.
- Rapier 0.21 (festgepinnt), fester Physiktakt 1/60 s.
- Modelle: glTF binär, Meshopt durch die Pipeline, Konventionen aus `data/models/README.md`; kein Größenbudget für Assets (Nutzer, generell).
- Nur offene Daten (OSM) für Ständer-Standorte.

## Ansätze (betrachtet)

- **A) Eigene Rad-Steuerung auf Basis des kinematischen Character Controllers.** Bordsteine über Autostep, kippt nie, Fahrgefühl voll steuerbar. Nachteil: Rad ist für Autos unverschiebbar (wie heute die Fußgänger). Von Claude empfohlen.
- **B) Dynamischer Physik-Körper, Kippachsen gesperrt, durch Kräfte angetrieben.** Autos schubsen Räder realistisch; Risiko: Bordsteine/Gelände machen es zappelig, Feintuning mühsam. Zuerst vom Nutzer gewählt.
- **A+B) Mischung: gefahrenes Rad kinematisch (A), unbesetztes Rad dynamisch (B).** Fahren voll steuerbar und ohne Zappeln an Bordsteinen; stehende Räder werden von Autos weggeschubst und rollen nach dem Absteigen aus. Nachteil: Ein *gefahrenes* Rad ist für Autos unverschiebbar wie heute die Fußgänger. **Gewählt (Nutzer), nachdem Claude die Mischung als Ausweg aus dem Zappel-Risiko von B vorgeschlagen hat.**
- **C) Auto-Physik mit schmaler Spur wiederverwenden.** Wenig neuer Code, fühlt sich aber wie ein schmales Auto an. Verworfen (Anti-Ziel).

## Entschiedenes zum Wie

### Vom Nutzer

- Mischung A+B: kinematisch beim Fahren, dynamisch wenn unbesetzt.
- Alle fünf Radtypen, gebaut mit dem Blender MCP.
- Fahrgefühl wie Rennradfahren in GTA 5.
- Am Spawnpunkt immer ein Lastenrad.

### Von Claude (korrigierbar)

**Radphysik (`packages/shared/src/physics/bike.ts`, Klasse `Bike`)**

- **Beim Fahren (A):** Das Rad mit Fahrer:in ist ein kinematischer Körper, bewegt von Rapiers `KinematicCharacterController` (wie die Spielfigur), aber mit eigener Radlogik: Kollider eine liegende Kapsel in Radlänge; Bordsteine bis ~0,2 m nimmt der Autostep (Bordsteine sind 0,12 m), `snapToGround` hält das Rad beim Herunterfahren am Boden; höhere Kanten wirken wie eine Wand. Die sichtbare Schräglage und das „Einfedern“ an Kanten sind reine Darstellung.
- **Antrieb arcade-artig:** Wunschgeschwindigkeit je Taste, Beschleunigen/Bremsen mit festen Raten je Radtyp; das Rad fährt, wohin es zeigt (kein seitliches Rutschen außer leichtem Driften bei Vollbremsung in Kurven). Drehrate aus Lenkung × Tempo / Radstand, Lenkeinschlag nimmt mit dem Tempo ab (wie beim Auto). Eigene Schwerkraft wie bei der Figur; in der Luft kein Antrieb, nur wenig Lenkwirkung. Gegen Wände/Pfosten gleitet das Rad ab bzw. stoppt (Sturz siehe unten).
- **Unbesetzt (B):** Ein dynamischer Rapier-Körper (~20 kg, Lastenräder ~45 kg) mit **gesperrter Roll- und Nickrotation** (`enabledRotations(false, true, false)`), Kollider leicht über dem Boden, so dass er auf Gehweg/Straße steht und nicht über Kanten hakt. Er kann umgeschubst/verschoben, aber nie umgeworfen werden (bleibt aufrecht).
- **Wechsel:** Beim Aufsteigen wird der dynamische Körper durch den kinematischen ersetzt (Pose übernommen); beim Absteigen umgekehrt, mit der aktuellen Geschwindigkeit, so dass das Rad ausrollt.
- **Kollisionsgruppe:** eigene Gruppe für Räder (Bit 3). Räder kollidieren mit Stadt, Straßenmöbeln, Autos, Figuren und anderen Rädern. Autos (1200 kg) schubsen unbesetzte Räder physikalisch weg; das gefahrene Rad schiebt unbesetzte Räder beiseite und stoppt an Autos.
- **Mehrspieler-tauglich:** Das Rad liegt im gemeinsamen Paket, rechnet nur im festen Physiktakt und hält seinen eigenen Zustand (Tempo, Lenkwinkel, Tretphase, Luft/Boden) so, dass er gespeichert und wiederhergestellt werden kann – damit Client-Vorhersage und Rückspulen später möglich sind. Der Server selbst ist nicht Teil dieser Arbeit (Claude).
- **Geparkte Räder** schlafen (wie geparkte Autos) und bekommen nur im Nahbereich der Spielerin/des Spielers einen Physik-Körper (gleiches Nah-/Fern-Schema wie `ParkedCars`). Ein stehendes, unbesetztes Rad kippt nicht, sondern bleibt aufrecht stehen bzw. wird angestoßen verschoben.

**Steuerung und Fahrgefühl**

| Taste | Wirkung |
|---|---|
| W / ↑ | treten (Reisetempo) |
| Shift halten | kräftig antreten (Sprint: schneller und stärkere Beschleunigung) |
| S / ↓ | bremsen; im Stand langsam rückwärts schieben |
| A/D | lenken |
| Leertaste | Hüpfer (Bunny Hop, ~0,4 m): über Bordsteine, kleine Hindernisse |
| E | auf-/absteigen |
| H | Klingel |

- Absteigen jederzeit möglich (anders als beim Auto); bei Tempo > 10 km/h springt man ab und landet laufend neben dem Rad, das Rad rollt aus.
- **Sturz:** Fährt man mit > 22 km/h frontal gegen Wand/Pfosten/Auto, fällt die Figur vom Rad (kurz hinfallen, nach ~1 s aufstehen), das Rad bleibt dort stehen. Kein Schaden, kein Blut. Hinfall-Pose, gesperrte Eingabe und Aufstehen gibt es im Code noch nicht und werden hier neu gebaut (Claude). Auslöser „von einem Auto getroffen“ kommt erst mit Mehrspieler – im Solo-Spiel fährt niemand sonst Auto (Claude).
- Kamera: Follow-Kamera wie beim Auto, etwas tiefer und näher, leichtes Mitneigen in Kurven.

**Werte je Typ (Startwerte, in `TUNING.bike`)**

| Typ | Reise km/h | Sprint km/h | Wendigkeit | Schräglage | Besonderheit |
|---|---|---|---|---|---|
| Rennrad | 30 | 45 | hoch | stark | schnellste Beschleunigung |
| Mountainbike | 25 | 38 | hoch | stark | höchster Hüpfer, federt Bordsteine weicher |
| Hollandrad | 20 | 30 | mittel | mittel | aufrechte Sitzhaltung |
| Long John | 22 | 28 | niedrig | mittel | E-Unterstützung: kräftiger Antritt, weicher Deckel bei 25–28 |
| Dreirad-Lastenrad | 18 | 25 | niedrig | keine (Kiste neigt sich nicht) | E-Unterstützung, breiter Kollider |

**Darstellung (Client)**

- Figur bekommt eine **Fahrhaltung** je Radtyp (sitzend; Rennrad vorgebeugt, Hollandrad aufrecht), Beine treten mit der Kurbel, Hände am Lenker.
- Am Rad animiert: Räder drehen sich mit dem Tempo, Kurbel mit dem Treten (Freilauf: steht beim Rollen still), Lenker/Gabel mit dem Lenkeinschlag (beim Dreirad dreht die ganze Kiste), Schräglage aus Tempo × Kurvenradius (auf ~35° begrenzt).
- **Licht bei Nacht:** Vorderlicht weiß, Rücklicht rot, wenn das Rad gefahren wird (emissiv; am gefahrenen Rad ein kleines echtes Spotlicht wie beim Auto, wenn es die Leistung erlaubt).
- **Ton:** Freilauf-Ticken beim Rollen, Kettengeräusch beim Treten, Reifen-Abrollen tempoabhängig, Klingel. Wie die bestehenden Sounds prozedural/über das vorhandene Audiosystem.
- Geparkte Räder als Instanzen (ein `InstancedMesh` je Modellteil und Typ), Rahmenfarbe je Instanz variiert; Sichtbarkeitsradius wie bei Autos, aber kleiner (Räder sind klein).

**Modelle (Blender MCP)**

- Je Typ ein Ordner `data/models/bikes/<typ>/` mit `build.py` (prozedural, erzeugt `.blend` und `.glb`, wie die Gebäudemodelle; gemeinsame Helfer in `nnmodel.py` bzw. einem neuen `bikeparts.py`: Rohr entlang Pfad, Speichenrad, Sattel, Lenker).
- Rad-Koordinaten lokal (nicht Weltkoordinaten): Ursprung am Boden zwischen den Rädern, Maßstab 1 = 1 m. Achsen wie im README (Blender Y = −Spiel-z, Z oben); das Rad zeigt in Blender nach **−Y**, damit es im Spiel ohne Drehung nach +z (Heading 0) zeigt. Die Weltkoordinaten-Prüfung der Pipeline (25 m zum LOD2-Gebäude) gilt nur für Gebäudemodelle, Radmodelle laufen über einen eigenen Pfad. (Claude)
- Benannte Knoten für die Animation: `frame`, `fork` (Drehpunkt auf der Lenkachse, inkl. Lenker und Vorderrad-Halter), `wheel_front`, `wheel_rear` (beim Dreirad `wheel_front_l`, `wheel_front_r`), `crank`, `pedal_l`, `pedal_r`, `light_front`, `light_rear`, plus Sitz- und Griffpunkte (`seat`, `grip_l`, `grip_r`, leere Objekte) für die Fahrhaltung.
- Rahmenfarbe als eigenes Material `paint` (Client färbt je Instanz um), Rest feste Materialien.
- Detailgrad: erkennbar und hübsch aus Spielkameraabstand (Rohre rund, Speichen angedeutet über Textur oder dünne Geometrie, Reifenprofil glatt), kein Wettbewerb mit Fotorealismus.
- Fahrradständer: Modell **Anlehnbügel** (Edelstahl, umgedrehtes U, ~0,8 m hoch, ~0,9 m breit), plus einfacher **Wandbügel/Poller** für `wall_loops`/`bollard`.
- Abnahme der Modelle: Nutzer sieht Screenshots (Solid + Texturfarbe, siehe lokale Blender-Eigenheiten) und eine Ingame-Ansicht.

**Ständer und Belegung (Pipeline)**

- `osm.ts` liest `amenity=bicycle_parking` (Knoten und Flächen) mit `bicycle_parking`-Art und `capacity` (fehlend → 6).
- Platzierung: Bügelreihe mit `ceil(capacity / 2)` Bügeln im Abstand 1 m (höchstens 12 Bügel je Reihe; größere Anlagen werden als mehrere parallele Reihen gelegt, Claude), Ausrichtung quer zur nächsten Straße (Räder stehen senkrecht zum Bordstein); bei Flächen entlang der Längsachse. Bügel, die in Gebäuden oder Gleisen landen würden, werden verworfen (`insideAnyFootprint`). **Ständer im Parkstreifen** (in Köln häufig: Bügel statt Autoparkplatz) bleiben dort auf Fahrbahnhöhe stehen, und geparkte Autos im Umkreis von 3 m um die Bügelreihe entfallen. Nur Ständer, die mitten in einer Fahrspur landen, werden auf den nächsten Gehwegrand verschoben (Claude).
- Belegung deterministisch (Seed wie bei Parkplätzen), ~50 %; Typverteilung: Hollandrad 45 %, Mountainbike 20 %, Rennrad 15 %, Long John 10 %, Dreirad 10 % (Lastenräder stehen neben dem Bügel statt dran).
- Manifest bekommt `bikeRacks: { x, z, heading, kind }[]` und `bikes: { x, z, heading, type, color }[]`; Kollision der Bügel als feste Straßenmöbel (wie Laternen, aber nicht umfahrbar).
- **Spawn-Lastenrad:** analog zu `withSpawnCar` wird ein Long John fest neben den Spawnpunkt gestellt (auf dem Gehweg, parallel zur Straße, ~2 m vom Spawn), immer, unabhängig vom Zufall.
- Ungenutzte, verschobene Räder werden – wie im Hauptdesign für Autos – nach längerer Zeit an ihren Ursprungsplatz zurückgesetzt (relevant erst mit Server; im Solo-Spiel beim Neuladen ohnehin).

## Dem Builder überlassen

- Genaue Feder-/Dämpfungs- und Antriebswerte, solange das Fahrgefühl die Ziele erfüllt; Tuning mit dem Nutzer im Browser.
- Ob die Sitz-/Griffpunkte per IK oder per fester Pose je Typ umgesetzt werden.
- Wie die Ständer-Kollision zusammengefasst wird (einzelne Bügel oder eine Box pro Reihe).
- Sichtbarkeits- und Physikradien für Räder, solange das Leistungsziel hält.
- Reihenfolge des Modellbaus (Vorschlag: Long John zuerst, wegen Spawn).
