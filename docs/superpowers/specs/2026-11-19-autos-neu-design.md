# Autos neu: realistischere Modelle, Innenraum, Einsteigen, Mitfahren – Design

Stand: 2026-11-19

Hinter jedem Punkt steht, woher er kommt: **(Nutzer)** = so gesagt oder bestätigt, **(Vorschlag)** = von mir
festgelegt, kann korrigiert werden.

## Absicht und Warum

Die Autos sollen **realistischer aussehen** (Nutzer). Heute sind sie eine glatte Hülle mit dunklen, undurchsichtigen
Scheibenflächen, ohne Innenraum; wer einsteigt, verschwindet, und das Auto fährt scheinbar leer. Künftig haben die
Autos einen Innenraum hinter durchsichtigen Scheiben, und Spieler **setzen sich sichtbar hinein** (Nutzer) – als
Fahrer und als Mitfahrende (Nutzer).

Gefahren wird weiterhin in der Sicht von hinten/außen (Nutzer). Der Innenraum muss also **von außen** überzeugen,
nicht aus der Ego-Sicht.

## Ziele

- Alle vier Typen (`kleinwagen`, `mittelklasse`, `transporter`, `smart`) neu gebaut: realistischere Karosserie,
  Innenraum, durchsichtige Scheiben, Türen, die sich öffnen (Nutzer).
- Die Modelle werden **selbst gebaut**, weiter als Blender-Skripte (Nutzer; siehe Ansätze).
- Einsteigen mit Tür: zur Tür gehen, **E**, Tür schwingt auf, Figur setzt sich, Tür zu; Aussteigen umgekehrt (Nutzer).
- Die Figur sitzt sichtbar im Auto; Fahrer mit den Händen am Lenkrad, das Lenkrad dreht mit (Nutzer).
- **Mitfahren:** mehrere Spieler im selben Auto, Sitzplätze verwaltet der Server (Nutzer).
- Andere Spieler sehen alle Insassen durch die Scheiben (Nutzer).

## Nicht-Ziele

- Cockpit-/Ego-Sicht (Nutzer: 3rd Person bleibt).
- Details, die man nur von innen sieht: Tacho-Anzeigen, Schalter, Pedale im Detail (Vorschlag).
- Fotorealismus. Ziel ist „sauberes, glaubwürdiges Spielauto“, deutlich besser als heute; dem Nutzer ist diese
  Grenze des Selbstbauens bekannt.
- Kofferraum/Motorhaube öffnen, Schiebetür des Transporters, Laderaum betreten, Fenster herunterlassen,
  Innenbeleuchtung, Schaden am Auto (Vorschlag).
- Durchrutschen von Sitz zu Sitz im Auto (Nutzer bestätigt).
- Neue Autotypen, geänderte Fahrphysik. `CAR_SPECS` (Maße, Radstand, Spur, Radradius) bleiben, wie sie sind.

## Anti-Ziele

- Nachbauten echter Marken/Modelle (wie im Hauptdesign): generische Formen, keine Logos.
- Geschlechterbezüge in Texten, Namen, Kommentaren (Projektregel).
- Eine Größen- oder Dreiecksgrenze, die die Optik beschneidet: es gibt **kein Download-Budget** (Projektregel).
  Grenze ist nur die Bildrate (siehe Darstellung).

## Ansätze

1. **Gekauftes Paket generischer Autos herrichten** – größter Realismus-Sprung, kostet Geld, Auswahl beim Nutzer.
2. **Selbst neu bauen (gewählt, Nutzer)** – `carparts.py` neu mit echten Fensteröffnungen, Türen, Innenraum.
   Kostenlos, passt genau zur Physik und zu den Namenskonventionen, ein einheitlicher Stil; Realismus begrenzt
   (kein Foto-Look).
3. **Freie Modelle (Sketchfab CC-BY/CC0)** – kostenlos, aber uneinheitlich, viel Nacharbeit, oft Marken-Nachbauten;
   CC0 gibt es praktisch nur als Low-Poly/Comic. Verworfen.

Weil der Realismus bei Ansatz 2 das Risiko ist: **Der Kleinwagen wird zuerst komplett gebaut und dem Nutzer als
Bilder gezeigt** (Standbilder aus Blender und aus dem Spiel, mit sitzender Figur). Erst nach seinem Okay folgen die
drei anderen Typen (Vorschlag).

## Die Modelle

Weiter ein `build.py` je Typ plus gemeinsames `data/models/cars/carparts.py`, headless gebaut, mit Review-Bildern
nach `shots/cars/` und `CAR_REPORT`. Koordinaten, Ursprung und Blickrichtung wie in `data/models/cars/README.md`.

### Außen (Vorschlag)

- **Scheiben sind echte Öffnungen** in der Hülle; darin sitzen dünne Glasflächen (Material `glass`, im Spiel
  durchsichtig). Rahmen, Säulen und Dach haben Wandstärke – man darf nirgends durch eine Scheibe „ins Nichts“ oder
  auf Rückseiten schauen.
- **Türen sind eigene Objekte**, aus der Hülle geschnitten, mit sichtbarer Fuge zur Karosserie, Türinnenverkleidung
  und Scheibe. Griff, Außenspiegel und Zierleisten einer Tür gehören zur Tür und schwingen mit.
- Mehr Tiefe statt aufgeklebter Flächen, wo es am meisten bringt: Scheinwerfer und Rückleuchten als Gehäuse hinter
  klarer Abdeckung, Kühlergrill und Lufteinlässe als Geometrie, abgesetzte Stoßfänger, Radhäuser mit Innenseite,
  detailliertere Felgen mit Bremsscheibe, Kennzeichen, Wischer, Antenne, Auspuff.
- Karosserieform: sauberere Linien als heute (Schulterlinie, Radlauf, Sicke in der Flanke). Der Loft-Ansatz aus
  `carparts.py` darf bleiben oder ersetzt werden – Sache der Umsetzung.

### Innen (Vorschlag)

Sichtbar von außen: Boden/Wanne, Armaturenbrett mit Lenksäule, **Lenkrad** (eigener Knoten), Vordersitze mit
Kopfstützen, Rückbank (Kleinwagen, Mittelklasse), Mittelkonsole mit Schalthebel, Innenspiegel, Hutablage bzw.
Kofferraumabdeckung, Dachhimmel, Säulenverkleidung. Transporter: Fahrersitz und Doppelsitzbank, dahinter eine
Trennwand; der Laderaum hat keine Fenster und bleibt leer. Smart: zwei Sitze.

### Sitzplätze und Türen je Typ (Nutzer bestätigt)

| Typ | Türen | Sitze |
|---|---|---|
| `smart` | 2 | 2: Fahrer, Beifahrer |
| `kleinwagen` | 4 (+ Heckklappe, fest) | 5: vorn 2, hinten 3 |
| `mittelklasse` | 4 | 5: vorn 2, hinten 3 |
| `transporter` | 2 vorn (Schiebetür fest) | 3: Fahrer + Doppelbank |

Der Fahrer sitzt links (Sitz 0). Die mittleren Plätze (hinten Mitte; im Transporter Bankmitte) haben keine eigene
Tür und werden über die Tür ihrer Seite erreicht – hinten Mitte von beiden Seiten, Transporter-Mitte von rechts.

### Knoten und Materialien (Vorschlag; der Client greift per Name zu)

Bestehende Namen bleiben (`body`, `wheel_*`, `light_*`, `tail_*`, `paint`, `lamp_front`, `lamp_rear`). Neu:

| Name | Bedeutung |
|---|---|
| `door_fl`, `door_fr`, `door_rl`, `door_rr` | Türen; Ursprung auf der Scharnierachse (vorn angeschlagen), drehen um die Hochachse |
| `steering` | Lenkrad; dreht um die Lenksäulenachse |
| `seat_0` … `seat_n` | Leerobjekte am Hüftpunkt jedes Sitzes, Reihenfolge: Fahrer, Beifahrer, hinten links, hinten rechts, hinten Mitte (Transporter: Fahrer, Bank außen, Bank Mitte) |
| `grip_l`, `grip_r` | Griffpunkte am Lenkrad (Kinder von `steering`) |
| Material `glass` | Scheiben; im Client durchsichtig, getönt, spiegelnd |
| Materialien `interior`, `interior_trim`, `seat` | Innenraum (dunkel, matt) |

Das **Fernmodell** (`<typ>_lod.glb`) bleibt einfach: geschlossene Hülle, dunkle undurchsichtige Scheiben, kein
Innenraum, keine Türknoten – wie heute. Damit der Wechsel nicht auffällt, ist das Glas des Nahmodells stark genug
getönt, dass man aus der Wechseldistanz ohnehin kaum hineinsieht.

### Sitzmaße zwischen Modell und Simulation

Die Simulation braucht je Typ die Lage der Türen und Sitze (Sitzwahl, Ausstiegspunkt); das Modell hat dieselben
Punkte als Knoten. Quelle der Wahrheit sind neue Felder in `CAR_SPECS` (je Sitz: Lage längs/quer, Seite, Tür);
`build.py` baut danach, und `CAR_REPORT` bzw. ein Test stellt sicher, dass Modellknoten und `CAR_SPECS` nicht
auseinanderlaufen (Vorschlag; das genaue Mittel ist Sache der Umsetzung).

## Sitzen, Ein- und Aussteigen im Spiel

### Regeln (Nutzer bestätigt, soweit nicht anders markiert)

- **Einsteigen:** an eine Tür gehen, **E**. Man bekommt den Platz hinter der nächstgelegenen Tür; ist er belegt, den
  nächsten freien auf derselben Seite (hinten also die Mitte).
  - Genauer (Vorschlag): Jede Tür bedient nur ihre eigenen Plätze. Vordertür → nur der Vordersitz; hintere Tür →
    Außenplatz, dann Mitte; rechte Tür des Transporters → Bank außen, dann Bankmitte. Ist an dieser Tür nichts frei:
    abgelehnt, mit Hinweis wie heute bei besetztem Auto – auch wenn an einer anderen Tür noch Platz wäre. Auf die
    Mitte kommt man nur, wenn der Außenplatz belegt ist; die Figur steigt dann an der sitzenden Figur vorbei.
  - Reichweite (Vorschlag): Welches Auto gemeint ist, entscheidet wie heute der Abstand zur Wagenmitte
    (`ENTER_MAX_DIST`), ebenso die Wahl Auto/Rad. Die Tür ist die dem Spieler nächstgelegene, egal wo am Auto er
    steht. Die Bewegung beginnt am Standpunkt vor dieser Tür: die Figur gleitet in der Zeit, in der die Tür
    aufschwingt, dorthin. Das gilt schon in Stufe 3, dort mit nur einer Tür (Fahrertür).
- Einsteigen nur, solange das Auto (fast) steht – dieselbe Schwelle wie fürs Aussteigen (`EXIT_MAX_SPEED`).
- **Fahrer** wird, wer auf Sitz 0 sitzt. Nur dann läuft die Zündung an (Tür zu → Anlasser → Motor), wie heute.
- **Mitfahrende** steuern nichts außer: sich umsehen (Kamera), **hupen** und aussteigen. Sie hören Motor und Radio des
  Autos so wie der Fahrer. Das Radio bedient nur der Fahrer (Vorschlag).
- **Fahrer steigt aus:** Handbremse, Motor und Radio aus (wie heute), die anderen bleiben sitzen. Der Fahrersitz ist
  frei; wer an die Fahrertür geht, wird neuer Fahrer. Kein Durchrutschen.
- **Aussteigen:** aus der eigenen Tür auf die eigene Seite, auf Höhe der Tür (Mittelplätze: feste Regel, zuerst
  rechts – die Seite wird nicht gemerkt; Vorschlag); ist dort blockiert, auf der anderen
  Seite, sonst hinter dem Auto (die heutige Reihenfolge, nur mit der eigenen Seite zuerst). Nur unter
  `EXIT_MAX_SPEED`; sonst der heutige Hinweis.
- Ein Auto mit Insassen, aber ohne Fahrer, gilt als **benutzt**: es wird nicht auf seinen Stellplatz zurückgesetzt
  und nicht aus der Physik genommen, solange jemand drin sitzt (Vorschlag).
- Verlässt ein Spieler das Spiel, wird sein Sitz frei (wie heute beim Fahrer).
- Rad/Roller neben dem Auto: die heutige Wahl „das, worauf die Figur schaut“ bleibt.

### Ablauf und Zeiten (Vorschlag)

Die Simulation bleibt **sofort**: Mit **E** sitzt der Spieler in der Simulation im Auto (bzw. steht am
Ausstiegspunkt) – wie heute, damit Vorhersage und Server-Korrektur einfach bleiben. Die Bewegung ist **Darstellung**
im Client, ausgelöst durch das Ereignis:

- Einsteigen, rund 1,2 s: Tür schwingt auf (~0,3 s), die Figur geht von ihrem Standort in den Sitz und nimmt die
  Sitzhaltung ein (~0,6 s), Tür fällt zu (~0,3 s, mit dem Türgeräusch).
- Aussteigen: dasselbe rückwärts, die Figur endet am Ausstiegspunkt.
- Damit nichts losfährt oder losläuft, während die Figur noch unterwegs ist: Die Zündung des Fahrers wartet auf das
  Türschließen (die Zeiten `DOOR_CLOSE_AT`/`CRANK_AT` rücken entsprechend nach hinten), und nach dem Aussteigen
  nimmt die Simulation für die Dauer der Bewegung keine Lauf-Eingaben an (ein Tick-Zähler im Spielerzustand, analog
  `fallTicks`, damit Client und Server gleich rechnen).
- Fährt der Fahrer an, während jemand anderes noch einsteigt, läuft dessen Bewegung im Bezug zum Auto weiter zu Ende.
- Neues Geräusch „Tür auf“; „Tür zu“ gibt es schon.

### Die sitzende Figur (Vorschlag)

Wie beim Rad: die Figur hängt am Auto, Hüfte auf `seat_n`; Hände per IK an `grip_l`/`grip_r` (Fahrer) bzw. auf den
Oberschenkeln (andere); Füße am Boden vor dem Sitz. Das Lenkrad dreht mit dem Lenkeinschlag, die Hände folgen. Die
Figur muss in jeden Typ passen, ohne durch Dach, Sitz oder Tür zu ragen – das wird je Typ an Bildern geprüft.

## Simulation und Netz (Vorschlag)

- `CarPool.driver` (ein Spieler je Auto) wird zu **Sitzen je Auto**; „Fahrer“ ist der Spieler auf Sitz 0. Alles, was
  heute „hat einen Fahrer“ fragt (Zurücksetzen, Physik-Reichweite, `place`, Kandidaten fürs Einsteigen), fragt
  künftig passend „hat Insassen“ bzw. „hat einen Fahrer“.
- Spielerzustand: zum Auto kommt der Sitz. Ereignisse `enter`/`exit` tragen den Sitz, damit alle Clients die
  richtige Tür und Bewegung zeigen.
- Langsamer Zustand (Colyseus): `CarState.driver` wird zur Sitzliste; `PlayerState` bekommt den Sitz.
  Protokollversion hoch; alte Clients werden wie bei früheren Protokolländerungen behandelt.
- **Mitfahrende sagen das Auto nicht vorher.** Ihr Client zeigt es aus den Server-Schnappschüssen wie jedes fremde
  gefahrene Auto und hängt Kamera und eigene Figur daran. Nur der Fahrer rechnet sein Auto voraus (wie heute).
- Hupe: an, wenn irgendein Insasse sie hält.
- Interesse/Fokus eines Mitfahrenden liegt auf dem Auto (er sieht, was um das Auto ist).

## Darstellung im Client (Vorschlag)

- **Geparkte Autos** bleiben instanziert (`ParkedCars`), jetzt mit Innenraum und durchsichtigem Glas; Türen zu.
- Ein Auto mit Insassen **oder** mit bewegter Tür wird als Einzelauto gezeichnet (das heutige `DrivenCar`-Prinzip,
  erweitert): Türknoten, Lenkrad, Figuren auf den Sitzen. Steht es wieder leer mit geschlossenen Türen, geht es
  zurück in die Instanzen.
- **Glas:** durchsichtig, getönt, mit Umgebungsspiegelung; je nach Blickwinkel und Licht sieht man mehr oder
  weniger hinein. Nachts ist der Innenraum dunkel. Sortierung/Tiefenschreiben so, dass Glas vor Glas und Regen/Wetter
  sauber aussehen.
- **Namensschilder:** über dem Dach die Namen aller Insassen, Fahrer zuoberst.
- **Kamera:** für Mitfahrende dieselbe Fahrkamera wie für den Fahrer.
- **Hinweise:** Fahrer wie heute; Mitfahrende „E aussteigen · H hupen“. Touch-Bedienung entsprechend.
- **Karten:** Mitfahrende erscheinen an der Position des Autos.
- **Bildrate statt Größe:** Kein Dreieckslimit vorab. Geprüft wird im Spiel (Playwright mit Hardware-GPU) an einer
  Straße voller geparkter Autos gegen den Stand vor dem Umbau; bricht die Bildrate spürbar ein, wird zuerst die
  Nahdistanz der Instanzen bzw. die Qualitätsstufe angepasst, nicht das Modell verarmt.

## Reihenfolge (Vorschlag)

1. **Kleinwagen-Pilot:** neues `carparts.py`, Kleinwagen mit Innenraum, Glas, Türen; im Client Glas und Innenraum
   sichtbar. Bilder an den Nutzer → Okay oder Korrekturen.
2. Die drei anderen Typen.
3. Sitzende Fahrerfigur, Lenkrad, Tür-/Einsteigebewegung (noch ein Sitz je Auto).
4. Sitze in Simulation, Server und Protokoll; Mitfahren; Namensschilder, Hinweise, Ton.

Jede Stufe ist für sich spielbar und kommt als eigener Branch + PR (Projektregel: nie direkt auf `main`).

## Prüfen

- Simulation/Netz: Tests wie bisher (vitest) für Sitzwahl, Ausstiegspunkte je Sitz, Fahrerwechsel, Insassen ohne
  Fahrer, Verbindungsabbruch, Codec.
- Modelle: Review-Bilder je Typ aus Blender; im Spiel Bilder mit Figur auf jedem Sitz, Tür offen/zu, Tag und Nacht.
- Im Spiel zu zweit: einsteigen, mitfahren, Fahrer wechselt, aussteigen an einer Wand (Ausweichseite).

## Der Umsetzung überlassen

- Wie die Karosserie technisch entsteht (Loft weiterentwickeln oder anders), Dreieckszahlen, Texturen ja/nein.
- Genaue Sitz- und Türmaße, Öffnungswinkel, Kurven und Dauern der Bewegungen im genannten Rahmen.
- Wie Modellknoten und `CAR_SPECS` abgeglichen werden.
- Aufbau des Protokolls im Detail (Feldbreiten, Kodierung der Sitzliste).
- Glasparameter (Tönung, Rauheit), solange man tagsüber aus der Nähe hineinsieht und das Fernmodell nicht auffällt.
