# Echtes Kölner Wetter – Design

## Absicht

Nippes soll sich anfühlen wie Nippes gerade jetzt. Die Sonne steht schon heute dort, wo sie draußen steht
(`packages/shared/src/sun.ts`). Jetzt kommt das Wetter dazu: Regnet es draußen in Köln, regnet es auch im Spiel,
und zwar für alle Spieler gleich. Das Wetter ist rein optisch und akustisch. Es ändert nichts am Spiel selbst.

## Ziele

- **Der Server holt das aktuelle Kölner Wetter** regelmäßig, aber sparsam: alle 15 Minuten (so oft aktualisiert
  die Quelle ihre Werte). Er legt es in den gemeinsamen Raum-Zustand, damit alle Clients dasselbe Wetter sehen.
- **Stimmung:** Bewölkung macht den Himmel grauer, die Sonne schwächer und die Schatten weicher. Dunst und Nebel
  verkürzen die Sichtweite.
- **Niederschlag:** Regen- oder Schneepartikel um die Kamera. Ihre Dichte richtet sich nach der gemessenen Menge,
  ein leichter Schrägfall nach dem Wind.
- **Ton:** Bei Regen läuft ein Regengeräusch, dessen Lautstärke sich nach der Regenmenge richtet.
- **HUD:** Eine schlichte Wetteranzeige, z. B. `☂ 7 °C · leichter Regen`. Sie wird als eigenes Bauteil gebaut,
  damit sie beim späteren HUD-Redesign einfach umziehen kann.
- **Weiche Übergänge:** Ändert sich das Wetter, blendet der Client über einige Sekunden über, es springt nicht.

## Nicht-Ziele (jetzt)

- Keine Änderung an der Physik: keine Rutschigkeit, kein Einfluss auf Fahrzeuge oder Figuren. Der Wetterzustand
  geht nicht in `WorldSim` oder `packages/shared/src/physics` ein.
- Keine nassen oder spiegelnden Straßen, keine Pfützen, kein Gewitter mit Blitz und Donner. Das ist ein mögliches
  späteres Feature.
- Keine Vorhersage, nur das aktuelle Wetter.
- Kein HUD-Redesign. Das kommt danach in einer eigenen Runde.

## Anti-Ziele

- Das Spiel darf nie am Wetterdienst hängen: kein langsamerer Start, keine Fehler, kein Absturz, wenn Open-Meteo
  langsam, falsch oder weg ist.
- Kein spürbarer Frame-Einbruch, besonders nicht auf der Grafikstufe „Niedrig“ (Standard).
- Kein Regen in Innenräumen bzw. kein Regen, der durch das Autodach sichtbar „hineinfällt“, wenn das stört (siehe
  „Dem Builder überlassen“).
- Wetter, das nicht zu Köln passt, weil Spieler unterschiedliche Zustände sehen.

## Rahmenbedingungen

- Server: Colyseus, ein Raum `nippes` (`apps/server/src/room.ts`). Der langsame Zustand ist `NippesState`
  (`apps/server/src/state.ts`, Colyseus-Schema).
- Datenschutz: Die Abfrage an Open-Meteo enthält nur feste Kölner Koordinaten, keine Spielerdaten. Der Server
  schickt keinen identifizierenden User-Agent.
- Grafikstufen: `apps/client/src/quality.ts` (low/medium/high, live umschaltbar mit G). Die Partikelmenge hängt
  an der Stufe.
- Licht: `apps/client/src/lighting.ts` mischt Himmel, Sonne, Hemisphere-Licht und Nebel aus dem Sonnenstand
  (`moodAt`). Das Wetter setzt auf dieses Ergebnis auf.
- Audio: neue Klänge sind CC0 und werden in `apps/client/public/audio/CREDITS.md` eingetragen, im selben Format
  wie die übrigen (48 kHz Ogg Vorbis, nahtlose Schleife).
- Offline-Modus (`?offline=1`) gibt es weiterhin ohne Server.

## Ansätze

- **A – Wetter im Raum-Zustand (gewählt).** Ein neues Schema-Feld `weather` in `NippesState`. Colyseus
  synchronisiert es beim Beitritt, nach einem Reconnect und bei jeder Änderung von selbst. Auf dem Server gibt es
  nur einen Abruf-Timer.
- **B – eigene Nachricht `weather`.** Gleich machbar, aber Beitritt und Reconnect müsste man von Hand abdecken,
  was A von selbst erledigt.
- **C – jeder Client fragt selbst (verworfen).** Viele Abfragen an Open-Meteo, Spieler sähen eventuell
  unterschiedliches Wetter, und der Nutzer wollte ausdrücklich, dass der Server das macht.

Der Nutzer hat A gewählt.

## Entscheidungen

### Quelle und Abruf (Server)

- **Quelle: Open-Meteo** (`api.open-meteo.com/v1/forecast`), kostenlos und ohne Schlüssel. Abgefragt werden die
  `current`-Werte für den Wilhelmplatz (`SUN_LAT`/`SUN_LNG` aus `sun.ts`): `temperature_2m`, `weather_code`,
  `cloud_cover`, `precipitation`, `rain`, `showers`, `snowfall`, `visibility`, `wind_speed_10m`,
  `wind_direction_10m`.
- **Takt:** Der erste Abruf läuft beim Serverstart, ohne den Start zu blockieren, danach alle 15 Minuten. Zeitlimit
  pro Abruf: 10 s.
- **Fehler:** Das letzte gültige Wetter bleibt stehen. Gab es noch keins, gilt „unbekannt“: klares Wetter ohne
  HUD-Anzeige. Bei einem Fehler wird nach 5 Minuten erneut versucht, statt erst nach 15. Fehler landen mit
  `warn` im Log, aber nur einmal pro Fehlerserie, damit das Log nicht vollläuft. Antworten werden auf Plausibilität
  geprüft (Zahlen, Wertebereiche), unsinnige Werte werden verworfen.
- **Abschaltbar** per Umgebungsvariable, z. B. für Tests oder Betrieb ohne Internet. Kommt in die README-Tabelle.
- **Dev-Override (Entscheidung Claude):** zwei Ebenen. Eine Server-Umgebungsvariable legt im Entwicklungsmodus ein
  festes Wetter für den ganzen Raum fest, statt abzufragen. Das ist für Prüfskripte wie „alle Spieler sehen dasselbe
  Wetter“. Unabhängig davon überschreibt `?weather=` im Client nur lokal (siehe Client).
- **Einheiten:** Open-Meteos `current.precipitation` ist die Summe der letzten 15 Minuten. Der Server rechnet sie
  in mm/h um, bevor sie in `precip` landet.

### Was synchronisiert wird

Ein kleines, bereits aufbereitetes Wetter-Schema, keine Rohdaten. Damit liegt die Deutung an einer Stelle:

- `known` (gibt es überhaupt Wetter)
- `kind`: klar / bewölkt / Nebel / Niesel / Regen / Schnee (aus `weather_code`)
- `cloud` 0–1, `precip` mm/h, `snow` (Schnee statt Regen), `visibility` m, `windSpeed`, `windDir`,
  `temperature` °C
- `label`: der deutsche Kurztext für das HUD (z. B. „leichter Regen“), aus `weather_code` übersetzt
- `updatedAt`

Die Übersetzung von `weather_code` (WMO-Codes) in `kind` und `label` liegt in `packages/shared`, damit Server,
Offline-Client und Tests dieselbe Tabelle nutzen.

### Client

- **Licht:** Auf `moodAt` kommt ein Wetter-Mix. Bewölkung entsättigt und dunkelt Himmel und Horizont Richtung
  Grau, senkt die Sonnenstärke und erhöht den Anteil des Hemisphere-Lichts (weichere Schatten). Sichtweite unter
  der jeweiligen `viewDistance` zieht den Nebel heran. Nachts wirkt das Wetter nur gedämpft: Ein bewölkter
  Nachthimmel ist kaum anders als ein klarer.
- **Partikel:** ein Volumen um die Kamera, das mitwandert. Regen als Striche, Schnee als langsamere Flocken. Die
  Menge pro Grafikstufe kommt in `QUALITY` als neuer Wert. Bei 0 mm/h wird nichts gezeichnet.
- **Ton:** neue CC0-Regenschleife über den vorhandenen Mixer. Die Lautstärke richtet sich nach `precip`, bei
  Schnee ist sie stumm.
- **HUD:** eigenes Bauteil (eigene Datei, eigenes CSS) im Stil des bestehenden HUD (dunkler Grund, Akzent
  `#f2c46b`, `system-ui`). Es ist ausgeblendet, solange `known` falsch ist.
- **Beitritt:** Wer neu dazukommt, sieht sofort das aktuelle Wetter, ohne Überblendung von „klar“ aus. Überblendet
  wird nur bei Änderungen während des Spiels.
- **Offline-Modus:** klares Wetter. Der Dev-Parameter `?weather=` ersetzt das Wetter nur im eigenen Client, wie
  `?time=` (online nur, wenn der Server im Entwicklungsmodus läuft, über `devAllowed`).

## Dem Builder überlassen

- Genaue Farben, Mischkurven und Partikelzahlen. Maßstab ist ein Screenshot-Vergleich klar, bewölkt, Regen,
  Schnee, Nebel bei Tag und Nacht.
- Wie Partikel unter Dächern oder im Auto behandelt werden. Einfachste Lösung: Im Auto keine Partikel im
  Innenraum, dafür eventuell ein gedämpftes Regengeräusch.
- Name und Format der Umgebungsvariable und des Dev-Overrides.
- Welche Regenaufnahme verwendet wird (CC0, nahtlos).
- Die genaue Stelle der Wetteranzeige im HUD, solange sie nicht mit Minimap, Hinweiszeile oder Verbindungsstatus
  kollidiert.
