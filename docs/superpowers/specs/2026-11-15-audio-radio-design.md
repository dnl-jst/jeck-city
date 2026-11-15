# Ton & Autoradio – Design

Stand: 2026-11-15

## Absicht

Nippes Nights ist bisher stumm. Die Stadt soll hörbar werden: Wer in ein Auto steigt, hat sofort Radio wie bei GTA – mit echten Kölner Live-Sendern –, und Laufen wie Fahren klingen nach etwas. Lokalkolorit (kölsche Musik im Auto) ist der Kern; die Geräusche machen die Welt glaubwürdig.

## Ziele

1. **Autoradio** mit drei Live-Streams, startet automatisch beim Einsteigen, Standardsender Radio Köllefornia, durchschaltbar, ausschaltbar.
2. **Geräusche beim Laufen:** Schritte (Gehen/Rennen unterschiedlich schnell), Sprung/Landung.
3. **Geräusche beim Fahren:** Motor (Leerlauf bis hohe Drehzahl, folgt Gas und Tempo), Reifenquietschen, Türen beim Ein-/Aussteigen, Motorstart, Aufprall.
4. **Stadt-Atmosphäre:** nächtliche Hintergrundkulisse, gelegentlich Straßenbahn-Klingel in der Nähe von Gleisen/Haltestellen.
5. Ausschließlich **freie Aufnahmen (CC0)**, Quellen dokumentiert.

## Nicht-Ziele

- Anzeige des gerade laufenden Songs (der Now-Playing-Endpunkt von Köllefornia liefert 404; für die anderen Sender gäbe es nur uneinheitliche Wege).
- Radio für andere Spieler hörbar / Multiplayer-Sync (es gibt noch keinen Multiplayer).
- Eigene Musik, Lautstärke-Menü, Einstellungsseite.
- Echte Straßenbahnen (es fahren keine; nur Klingel als Atmosphäre).

## Anti-Ziele (wäre ein Fehlschlag, auch wenn es „funktioniert“)

- Künstlich/piepsig klingender Motor (deshalb echte Aufnahmen statt Synthese).
- Radio läuft nach dem Aussteigen weiter oder doppelt (zwei Streams gleichzeitig).
- Ton, der beim Laden ohne Interaktion losplärrt oder vom Browser blockiert wird und dann nie mehr startet.
- Lizenzunklare Audiodateien im Repo.

## Rahmenbedingungen

- Browser spielen Ton erst nach einer Nutzeraktion. Der erste Klick (Pointer-Lock) bzw. erste Taste entsperrt Audio; vorher ist das Spiel einfach stumm.
- **Streams (getestet, alle HTTPS):**
  - Radio Köllefornia: `https://stream.radio-koellefornia.de/listen/radio_koellefornia/radio.mp3` (192 kbit/s, **kein CORS-Header**)
  - Radio Köln: `https://stream.lokalradio.nrw/444z7j4` (Redirect, 192 kbit/s)
  - 1LIVE: `https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3` (Redirect, 128 kbit/s)
- Weil Köllefornia kein CORS sendet, darf das Radio **nicht** über die Web Audio API (MediaElementSource) laufen – das ergäbe Stille. Radio = schlichtes `HTMLAudioElement`, Lautstärke über `.volume`.
- Download-Größe spielt keine Rolle (Nutzerwunsch); Qualität geht vor.
- Bestehende Struktur: Ein-/Aussteigen in `apps/client/src/game.ts` (`getIn`/`getOut`), Tasten in `input.ts` (E = ein/aus, F = Debug-Fly), Einblendungen via `hud.flash()`, Steuerungshinweis in `hud.ts` (`CONTROLS_HINT`).

## Ansätze

| Ansatz | Pro | Contra |
|---|---|---|
| A: Geräusche komplett im Code synthetisieren (Oszillatoren, Rauschen) | keine Dateien, keine Lizenzfragen | klingt künstlich, v. a. der Motor |
| **B: Freie CC0-Aufnahmen, Motor als gepitchte Loops (gewählt)** | klingt echt, Standard in Spielen | Dateien suchen, Lizenzen dokumentieren |
| C: Fertige Audio-Engine-Bibliothek (z. B. Howler) | Komfort | unnötige Abhängigkeit; Web Audio reicht |

Gewählt: **B**, vom Nutzer bestätigt („nimm gerne freie Aufnahmen“). Umsetzung mit der nativen Web Audio API (Three.js' `AudioListener`/`PositionalAudio` darf genutzt werden, wenn es passt – Entscheidung des Builders).

## Entscheidungen des Nutzers

- Sender: Radio Köllefornia (Standard), Radio Köln, 1LIVE; Live-Streams.
- Radio startet automatisch beim Einsteigen, kann ausgeschaltet werden.
- Alle vorgeschlagenen Geräusche: Schritte, Motor, Reifen, Türen, Aufprall, Straßenbahn-Klingel, Stadtkulisse.
- Freie Aufnahmen statt Synthese.

## Verhalten im Detail (Claudes Vorschläge, vom Nutzer korrigierbar)

### Radio
- **Taste R** schaltet durch: Köllefornia → Radio Köln → 1LIVE → Radio aus → Köllefornia … Zusätzlich Mausrad (vor/zurück). Nur im Auto aktiv. *(Nutzerentscheidung: R statt Q, damit es nicht mit dem Debug-Flugmodus kollidiert.)*
- Beim Wechsel: kurze HUD-Einblendung mit dem Sendernamen bzw. „Radio aus“.
- Beim ersten Einsteigen läuft Köllefornia. Danach merkt sich das Spiel (für die Sitzung) den zuletzt gewählten Zustand – auch „aus“: Wer das Radio bewusst ausgemacht hat, steigt beim nächsten Auto ohne Radio ein. *(Claudes Wahl, wie bei GTA.)*
- Beim Aussteigen: Stream sofort stoppen und Verbindung trennen (`src` leeren), nicht nur pausieren – live gibt es nichts nachzuholen, und es spart Bandbreite.
- Kurzes Rauschen/Tuning-Geräusch beim Senderwechsel überbrückt die 1–2 s Verbindungsaufbau. *(Claudes Wahl; M bleibt für die spätere Karte frei.)*
- Stream-Fehler/Abbruch: einmal neu verbinden; scheitert das, HUD „Sender nicht erreichbar“ und Rauschen aus. Der gewählte Sender bleibt trotzdem gemerkt (nächster Einstieg versucht ihn erneut).
- Tab im Hintergrund: Radio und Geräusche stummschalten, beim Zurückkehren weiter (Radio neu verbinden).

### Laufen
- Schrittgeräusch an die Schrittfrequenz gekoppelt (Gehen langsamer, Rennen schneller), nur bei Bodenkontakt; mehrere Varianten zufällig, leichte Tonhöhenvariation.
- Untergrund: Pflaster/Asphalt als Standard; Gras/Erde auf Grünflächen, wenn der Untergrund sich billig bestimmen lässt (Builder entscheidet, ggf. weglassen).
- Landung nach Sprung: dumpfer Schritt.

### Fahren
- Einsteigen: Tür auf/zu, Motorstart, dann Leerlauf. Aussteigen: Motor aus, Tür.
- Motor: Loops (Leerlauf, mittlere, hohe Drehzahl) überblendet und gepitcht nach einer simulierten Drehzahl aus Tempo + Gas mit angedeuteten Gangwechseln.
- Reifenquietschen bei Handbremse in Fahrt und starkem Querrutschen/Vollbremsung, Lautstärke nach Schlupf.
- Aufprall: dumpfer Schlag, Lautstärke nach plötzlicher Geschwindigkeitsänderung; Mindestabstand, damit Kratzen an Wänden nicht dauerknattert.
- Fahrzeuggeräusche (Motor, Reifen, Aufprall) werden pro Fahrzeug aus dessen Zustand (Tempo, Gas, Schlupf) gespeist, nicht direkt aus der Tastatur – so können später im Multiplayer andere Autos dieselben Geräusche positional bekommen. Jetzt gibt es nur das eigene Auto. *(Claudes Entscheidung nach Builder-Check.)*
- Im Auto: Stadtkulisse gedämpft (Tiefpass + leiser), Radio im Vordergrund.

### Atmosphäre
- Durchgehender Loop: nächtliche Stadt (fernes Verkehrsrauschen).
- Straßenbahn-Klingel gelegentlich (zufällige Pausen von einigen Minuten), nur wenn man im Umkreis von ca. 80 m einer Haltestelle (`manifest.tramStops`) ist, positional aus deren Richtung.

### Allgemein
- **Taste N**: gesamter Ton an/aus (inkl. Radio), HUD-Einblendung. Stumm = Radio-Element nur stummgeschaltet (`muted`), Stream läuft weiter, damit das Wiedereinschalten sofort klingt. *(Claudes Wahl; M bleibt für die spätere Karte frei.)*
- `CONTROLS_HINT` um „R Radio · N Ton“ ergänzen.
- Lautstärkemix fest im Code (Konstanten an einer Stelle), kein Menü.

## Dateien & Lizenzen

- Aufnahmen unter `apps/client/public/audio/` (OGG oder MP3, kurz geschnitten, Loops nahtlos).
- Strikt CC0 (Freesound mit CC0-Filter, Kenney, OpenGameArt CC0). Keine "royalty-free"-Pakete mit eigener Lizenz (z. B. Sonniss). Jede Datei in `apps/client/public/audio/CREDITS.md` mit Quelle, Autor, Lizenz. *(Claudes Entscheidung nach Builder-Check.)*
- Beschaffung ohne Nutzerbeteiligung: direkte Downloads (Kenney, OpenGameArt) und Freesounds hochwertige MP3-Vorschauen (kein Login nötig). Reicht die Qualität einer Vorschau nicht, wird eine andere Aufnahme gesucht. *(Claudes Entscheidung.)*
- Motor-Rückfall: Gibt es unter CC0 kein passendes Set aus Leerlauf/mittel/hoch vom selben Auto, sind ein oder zwei gepitchte Loops in Ordnung – Synthese bleibt ausgeschlossen. *(Claudes Entscheidung.)*
- Senderliste mit URLs an einer Stelle im Code.

## Testbarkeit

- Reine Logik testbar mit vitest (wie bisher): Senderwechsel/Zustand inkl. „aus“-Merken, Drehzahl-/Gangmodell, Schrittkadenz, Aufprall-Schwelle, Klingel-Timer.
- Audio-Ausgabe hinter einer dünnen Schicht, damit Tests ohne Browser laufen.
- Manuelle Prüfung im Browser durch den Nutzer (Ton kann automatisiert nicht beurteilt werden); Playwright kann prüfen, dass beim Einsteigen das Radio-Element die Köllefornia-URL bekommt.

## Dem Builder überlassen

- Modulaufteilung (z. B. `apps/client/src/audio/`), Three.js-Audio oder rohe Web Audio API.
- Konkrete Aufnahmen und Schnitt, Mixwerte.
- Ob Untergrund-Erkennung für Schritte billig genug ist.

## Nachtrag 2026-11-15 (Nutzerwünsche während der Umsetzung)

- **Motorstart zuerst:** Beim Einsteigen Tür auf/zu, dann Anlasser. Erst wenn der Motor hörbar läuft, nimmt das Auto Gas an und das Radio startet. Lenken, Bremsen und Aussteigen gehen schon vorher. Aussteigen während des Anlassens bricht ab (kein Motor, kein Radio).
- **Lichter:** Scheinwerfer/Rücklichter sind vor dem Anlassen aus, flackern beim Anlassen leicht (Batterie-Einbruch) und gehen an, wenn der Motor läuft.
- **Motor klingt zu hochtourig:** Bei ~50 km/h soll der Motor nach Stadtverkehr klingen (≈ 2500–3200 U/min), nicht nach Drehzahlbegrenzer. Höchsttempo bleibt 60 km/h; das Drehzahlmodell wird niedriger abgestimmt (früher schalten, tiefere Drehzahlen). *(Claudes Wahl: Modell statt Tempo ändern – Fahrphysik bleibt unberührt.)*
- **Radio-Rad wie bei GTA:** R gedrückt halten öffnet ein Rad in der Bildmitte mit vier Feldern (oben Köllefornia, rechts Radio Köln, unten 1LIVE, links Aus); Maus zeigt auf ein Feld (Kamera steht so lange still), Loslassen von R schaltet ein. R kurz antippen = nächster Sender wie bisher; Mausrad bleibt. Spiel läuft weiter (keine Zeitlupe, wegen späterem Multiplayer). Aktueller Sender hervorgehoben.
- **Logos:** Fantasie-Logos (eigene SVGs, keine echten Senderlogos), je eines pro Sender plus Symbol für „Aus“.
