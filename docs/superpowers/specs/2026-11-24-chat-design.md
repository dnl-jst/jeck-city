# Chat – Design

Stand: 2026-11-24

## Absicht

Spieler sollen sich im Spiel schreiben können – vor allem, um sich zu **verabreden** („treffen am Dom?“), und für
Sprüche im Vorbeigehen. Vorbild ist der Chat aus WoW: ein kleines Fenster unten links, Sprechblasen über den Figuren.

Zwei Kanäle:

- **Sagen** – nur Spieler in der Nähe hören es, mit Sprechblase über dem Sprecher.
- **Welt** – alle im Spiel lesen es, nur im Chatfenster (keine Blase).

## Ziele

- Nachrichten schreiben und lesen am Desktop (Tastatur) und auf Touch-Geräten (eigenes Chat-Fenster per Knopf).
- Sagen-Nachrichten als Sprechblase über Figur / Auto / Rad des Sprechers.
- Der Server entscheidet allein, wer eine Nachricht bekommt; Reichweite von Sagen ist nicht im Client umgehbar.
- Grundschutz: Längenlimit, Drosselung, Schimpfwortfilter.

## Nicht-Ziele

- Flüstern, Gruppen, weitere Kanäle, Emotes, Links, Erwähnungen.
- Verlauf über Sitzungen hinweg; Neuankömmlinge sehen keine alten Nachrichten.
- Ignorieren/Melden von Spielern, Moderationswerkzeuge.
- Chat im Offline-Modus (dort ist niemand zum Reden: Fenster und Knopf bleiben weg).

## Anti-Ziele (wäre ein Misserfolg, auch wenn es technisch läuft)

- Tippen lässt die Figur laufen, hupen, aussteigen, Radio wechseln o. Ä.
- Das Chatfenster verdeckt dauerhaft Spielfläche oder stört auf dem Handy den Bewegungs-Stick.
- Ein Spieler kann andere mit Spam fluten oder durch Chat den Server ausbremsen.
- Ein Spieler wird beim normalen Chatten vom Server gekickt.

## Ansätze

| | Ansatz | Abwägung |
|---|---|---|
| **A (gewählt)** | Eigene Colyseus-Nachricht `chat`: Client → Server `{ channel, text }`, Server prüft und verteilt gezielt (Welt an alle, Sagen an Spieler im Umkreis). | Einfach, passt zu `radio`/`welcome`, Server hat volle Kontrolle über Reichweite; unabhängig vom 60-Hz-Takt. |
| B | Chat im Colyseus-Schema-State. | Jeder bekäme jede Sagen-Nachricht, Reichweite nur im Client – umgehbar; State ist für Dauerhaftes, nicht für Ereignisse. Verworfen. |
| C | Chat als Event in den Binär-Snapshots. | Reichweite über Interest fast gratis, aber Text im Binärcodec umständlich, Weltchat passt nicht hinein, Zustellung am Snapshot-Takt. Verworfen. |

Entschieden: **A**.

## Entschieden mit dem Auftraggeber

- Zwei Kanäle, Sagen und Welt.
- Sprechblase + Chatfenster unten links (Desktop).
- Mobil: ein Chat-Knopf öffnet ein eigenes Fenster (Verlauf + Eingabe); kein Dauerfenster unten links.
- Übertragung nach Ansatz A.
- Schimpfwortfilter im Chat: nur echte Beleidigungen, auch innerhalb von Wörtern; milde Flüche bleiben stehen.

## Das Design

### Protokoll (`packages/shared/src/net/chat.ts`, neu)

- Client → Server: Nachricht `chat` mit `{ c: 's' | 'w', t: string }`.
- Server → Client: Nachricht `chat` mit `{ c: 's' | 'w', slot: number, name: string, t: string }`.
  Der Name wird mitgeschickt, damit eine Zeile auch dann lesbar ist, wenn der Sprecher (bei Welt) gar nicht im
  Interest-Bereich ist oder schon gegangen ist.
- `checkChat(raw): { ok: true; text } | { ok: false }` – geteilte, reine Funktion:
  NFC, unsichtbare Format-Zeichen (`\p{Cf}`) und Steuerzeichen raus, Whitespace zu einem Leerzeichen, trimmen;
  leer → abgelehnt; länger als **120 Codepoints** → gekürzt (nicht abgelehnt).
- `censorChat(text): string` – pro Wort (Trennung an Whitespace) wird das Wort normalisiert wie bei Namen (Umlaute,
  Leetspeak, nur a–z). **Enthält** es einen Eintrag aus `CHAT_BAD_WORDS`, wird das **ganze Wort** durch `*` gleicher
  Länge ersetzt (fängt Plural und Komposita: „Arschlöcher“). Die Nachricht wird zugestellt, nicht verworfen.
- `CHAT_BAD_WORDS` (in `badwords.ts`, entschieden vom Auftraggeber: nur echte Beleidigungen): `BAD_WORDS` **ohne**
  die milden Flüche und neutralen Begriffe `scheisse`, `scheisser`, `shit`, `fuck`, `vagina`, `porno`, `dildo`.
  Beleidigungen, Slurs und Nazi-Begriffe bleiben gefiltert. Die Namensprüfung nutzt weiter die volle `BAD_WORDS`.
  *(Welche Einträge genau herausfallen, ist Entscheidung des Designers nach dieser Regel.)*
  Tests: „scheißegal“, „shit“, „Marsch“, „Kölsch“ bleiben; „Arschlöcher“, „Hurens0hn“ werden gesternt.
- `PROTOCOL_VERSION` wird auf **4** erhöht: ein neuer Client darf nicht in einen alten Server, sonst würde er für
  `chat` als unbekannte Nachricht gekickt (und umgekehrt).
- Konstanten: `CHAT_MAX_LEN = 120`, `SAY_RANGE_M = 50` (= `LABEL_GONE`), Drosselung siehe unten.

### Server (`apps/server/src/room.ts` + `apps/server/src/chat.ts`, neu)

- `onMessage('chat', …)`: Seat ermitteln (gekickte ignorieren), Nachricht auf Form prüfen (falsche Form → ignorieren,
  **kein** Kick), `checkChat`, Drosselung, `censorChat`, verteilen.
- **Drosselung** pro Spieler (Token-Bucket in `chat.ts`, eigene Testdatei): **5 Nachrichten**, danach **1 pro 2 s**.
  Überzählige werden still verworfen; der Absender bekommt eine Systemzeile `chat` mit `c: 'sys'`
  („Nicht so schnell.“), höchstens einmal je Drosselphase. Kein Kick.
- **Welt**: an alle verbundenen Seats (nicht `away`), inkl. Absender.
- **Sagen**: an alle Seats, deren Spielerposition (aus `sim.player(slot).pos`, gilt auch im Auto/auf dem Rad) höchstens
  50 m (horizontal, x/z) vom Absender entfernt ist, inkl. Absender.
- Versand über `outbound(seat, …)` (respektiert Fake-Lag und `away`).
- Log: `log('info', 'chat', { slot, channel, len })` – **ohne** Nachrichtentext.

### Client – gemeinsame Logik (`apps/client/src/chat/`)

- `chat-log.ts`: Ringpuffer der letzten **50** Zeilen (`{ channel, name, text, at }`), Parser für die Eingabe:
  - `/w text`, `/welt text` → Welt; `/s text`, `/sagen text` → Sagen; ohne Präfix → aktueller Kanal.
  - `/w` bzw. `/s` allein wechselt nur den Kanal (Eingabe bleibt offen).
  - Der zuletzt benutzte Kanal bleibt eingestellt (pro Sitzung, nicht gespeichert). **Start-Kanal ist Sagen**
    (Desktop und Mobil-Tab), wie bei WoW. *(Entscheidung des Designers.)*
  - Erreicht eine Sagen-Nachricht außer dem Absender niemanden, schickt der Server eine Systemzeile
    „Niemand in der Nähe hat dich gehört – /w für den Weltchat.“ *(Entscheidung des Designers; fängt den Fall ab,
    dass man sich verabreden will und im falschen Kanal schreibt.)*
  - Unbekannter Slash-Befehl → wird als normaler Text im aktuellen Kanal gesendet.
- `Connection.sendChat(channel, text)` + `onChat`-Callback in `net/connection.ts`; nur wenn online.

### Client – Desktop-Fenster (`chat/chat-window.ts`)

```
┌──────────────────────────────────┐
│ [Welt] Jupp: treffen am Dom?     │  orange
│ Tünn: Hey!                       │  weiß
│ Nicht so schnell.                │  grau, kursiv (System)
│ Sagen ▸ bin unterwegs_           │  Eingabezeile, Kanal als Präfix
└──────────────────────────────────┘
 v0.3.0
```

- Unten links, über dem Versions-Label; Breite ca. 360 px, max. 8 sichtbare Zeilen, halbtransparenter Hintergrund nur
  bei offener Eingabe; Zeilen haben Textschatten.
- Ohne Aktivität blendet das Fenster nach **15 s** aus; neue Nachricht oder offene Eingabe zeigt es wieder.
- **Enter** öffnet die Eingabe (Pointer-Lock wird freigegeben), **Enter** sendet (leer = nur schließen), **Esc**
  schließt ohne Senden; danach wird Pointer-Lock nicht automatisch wiederhergestellt (Klick ins Spiel wie bisher).
- **Tastatur-Isolation**: Solange das Eingabefeld fokussiert ist, werden `keydown`/`keyup` nicht an `Input`
  weitergegeben, und beim Öffnen wird `input.releaseAll()` aufgerufen (sonst bleibt z. B. W „gedrückt“). Umsetzung im
  Listener von `attachInput`: Events mit Ziel `input`/`textarea` ignorieren.
- Scrollen im Verlauf ist nicht nötig (nur die letzten 8 Zeilen).

### Client – Sprechblasen (`remote/speech-bubble.ts`)

- Canvas-Sprite nach dem Muster von `NameLabel`: weiße Blase mit dunklem Text und kleinem Zipfel, Text auf bis zu
  **3 Zeilen** umbrochen (danach „…“), über dem Namensschild.
- Sichtbar **6 s** (+ 0,05 s je Zeichen, max. 10 s), dann 0,5 s ausblenden. Neue Nachricht desselben Sprechers
  ersetzt die alte.
- Gleiche Distanz-Abblendung wie das Namensschild (`labelOpacity`).
- Hängt an der Figur, dem Fahrer-Auto bzw. dem Rad – dieselben Ankerpunkte, die `RemotePlayers` für Labels nutzt.
  Mitfahrer im Auto (Modus `sit`): Blase am Auto.
- Eigene Sagen-Nachrichten bekommen ebenfalls eine Blase über der eigenen Figur.

### Client – Mobil (`chat/chat-sheet.ts`)

- Neuer Knopf „Chat“ in der Systemleiste (`.nn-tc-sys`, neben Karte/Ton/Grafik/Figur); Punkt-Markierung bei
  ungelesenen Nachrichten.
- Tippen öffnet ein **eigenes Fenster** (Overlay über der oberen Bildschirmhälfte): Verlauf (scrollbar, alle 50
  Zeilen), darunter Kanal-Umschalter **Sagen | Welt** (Tabs statt Slash-Befehle) und Eingabefeld mit Senden-Knopf.
  Schließen-Knopf oben rechts. Solange es offen ist, sind die Touch-Steuerungen inaktiv und die Eingabe neutral.
- Kein Dauer-Chatfenster unten links auf Touch-Geräten; Sprechblasen erscheinen dort trotzdem.

## Tests

- Shared: `checkChat` (Normalisierung, Länge, leer, Steuerzeichen), `censorChat` (Treffer, Umlaute/Leetspeak,
  harmlose Wörter bleiben).
- Server: Drosselung (Bucket), Verteilung im `room.test.ts`: Welt an alle, Sagen nur ≤ 50 m, Absender bekommt eigene
  Nachricht, falsche Form führt nicht zum Kick.
- Client: Eingabe-Parser und Kanalwechsel, Ringpuffer, Blasen-Dauer, Tastatur-Isolation in `input`.
- `mp-check` o. Ä. Skript: zwei Clients, Sagen/Welt Ende-zu-Ende, Screenshot von Fenster und Blase.

## Dem Umsetzer überlassen

- Format der Systemzeilen, Ende einer Drosselphase, clientseitige Längenbegrenzung (so dass `MAX_MESSAGE_BYTES` = 512
  nie überschritten wird), Position der eigenen Blase (es gibt kein eigenes Namensschild), Touch-Erkennung über das
  bestehende `touchPreferred`.
- Exakte Farben, Schriftgrößen, Blasenform, Icons (am bestehenden HUD-Stil orientieren: `#f2c46b` als Akzent).
- Aufteilung der Client-Dateien im Detail.
- Wie `RemotePlayers` die Blasen verwaltet (eigene Map pro Slot oder Teil von `Figure`).
