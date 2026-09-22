# pxt-iot-sim — die Dashboard-Ansicht neben dem Simulator

Eine **Simulator-Extension** (simx) für MakeCode: ein Panel neben dem Simulator,
das die Feeds des verknüpften IoT-Dashboards live zeigt. Damit sieht ein Kind
beim Programmieren, was sein Programm senden *würde* und was auf dem Dashboard
gerade steht — ohne Gerät am Kabel.

## Was zu sehen ist

Je Feed **eine Zeile**: links der Name, rechts der aktuelle Wert, groß. Das ist
die Frage, für die das Panel da ist, und sie bekommt die ganze Breite.

Alles Weitere zu diesem Wert — **Zeit, Wert, Von, An** — steht in einer kleinen
Tabelle einen Klick darunter. Meist hat ein Feed ohnehin nur eine Zeile; die
flache Liste aller Absender verbrauchte die Höhe des Panels damit, das Wort
„Dashboard" zu wiederholen. Geöffnete Feeds bleiben geöffnet: Der Poll zeichnet
nur neu, wenn sich am Bild wirklich etwas geändert hat.

Die **Zeit** ist der Moment, in dem das Panel diesen Wert gesehen hat, nicht der
Zeitstempel des Servers — `/read` liefert keinen. Werte, die schon auf dem
Dashboard standen, als das Panel dazukam, tragen deshalb einen Punkt statt einer
Uhrzeit, statt sich den Startzeitpunkt des Panels zu borgen.

Den **Mitschnitt der rohen `IOT1:`-Zeilen** gibt es nicht mehr. Er kostete ein
Fünftel der Höhe, um in Protokollform zu wiederholen, was die Werte darüber in
Worten sagen. Wer die Zeilen braucht, findet sie dort, wo sie ohnehin gelesen
werden: in der seriellen Konsole des Editors und im Campus-Stream.

## Woher die Daten kommen — und wohin sie gehen

**Direkt vom Server**, nicht über den Campus-Tab. In beide Richtungen.

Das ist die tragende Entscheidung, und sie gilt inzwischen auch fürs Schreiben.
Das Panel braucht dafür genau zwei Dinge: eine Adresse und ein Token. Beides
steht im Programm — der Dashboard-Block trägt Slug oder Token und optional die
Serveradresse —, und das Programm sagt beides dem Panel über den simx-Kanal
(siehe unten). Damit braucht der Simulator keinen Rückkanal zum Campus und
funktioniert auch im nackten MakeCode.

**Lesen** geht über `GET <server>/read` und läuft immer: Das Panel zeigt das
Dashboard, das im Programm steht, live neben dem Simulator. Dafür ist es da.

**Schreiben** geht über `POST <server>/ingest` — dieselbe Anfrage, die ein mini
mit WLAN-Modul stellt — und ist **standardmäßig aus**. Der Schalter dafür sitzt
im Panel, weil hier gesendet wird oder eben nicht. Ein Schalter im Programm
würde mit einer geteilten Datei mitreisen und die Simulatoren einer ganzen
Klasse in ein Dashboard schreiben lassen, das niemand gefragt hat; und der
Schalter wird bewusst nicht über Reloads gemerkt, sonst wäre „aus" keine
Vorgabe, sondern eine Einstellung, die jemand einmal gemacht und längst
vergessen hat.

Die simulierten Werte tragen die Kennung, die die Extension selbst vergibt
(`sim-…`, siehe `meineNummer`). Auf dem Dashboard sind sie damit als Simulation
erkennbar und kollidieren nie mit der Zeile des echten Geräts.

Nennt das Programm nur einen Kurznamen statt eines Tokens, kann das Panel nicht
selbst schreiben — den Kurznamen kann allein der Campus auflösen, weil seine
Relay-Route über die Sitzung autorisiert. Dann sagt das Panel das, statt einen
Schalter anzubieten, der nichts tut.

## Wie das Panel erfährt, welches Dashboard gemeint ist

Über die `IOT1:`-Zeilen, die das Programm ohnehin schickt. pxt reicht
Simulator-Nachrichten als `messagepacket` an das simx-Panel weiter; die
Extension sendet ihre Anmeldung als

```
IOT1:s:<serveradresse>
IOT1:h:<slug oder token>
IOT1:i:<seriennummer>
IOT1:r:<leseumfang>
```

Das Panel hört auf `h:` (welches Dashboard) und `s:` (welcher Server) und
abonniert dann PocketBase. Mehr braucht es nicht.

Der Schalter „im Simulator senden" ist weg — er entfällt ersatzlos, weil der
Grund für ihn weg ist. Er stand im Übertragungsblock, weil pxt die Ausgaben des
Simulators an keinen Host weiterreichte; mit diesem Panel gibt es eine
Gegenseite, also sendet der Simulator jetzt immer mit.

## Was das Panel startet

Nicht das Panel meldet sich, sondern das Programm. pxt erzeugt das simx-iframe
erst, wenn der Simulator ein `messagepacket` schickt, dessen `channel` GENAU dem
Schlüssel in `approvedRepoLib` entspricht (`pxt/pxtsim/simdriver.ts`, Suche nach
`simulatorExtensions[messageChannel]`). `pxt-grove` schickt dafür einmal je
Programmlauf ein leeres Paket auf `amerlander/pxt-grove` und danach jede
`IOT1:`-Zeile auf dem Kanal `iot`.

Zwei Kanäle also, und das ist kein Versehen: Der Repo-Name startet, der
Datenkanal trägt. `pxt-jacdac` macht es genauso (`jacdac/pxt-jacdac` startet,
`jacdac` trägt). Wer beides zusammenlegt, bekommt ein Panel, das startet und
nie etwas hört — oder Zeilen, die an ein Panel gehen, das es nicht gibt.

Nebenbei erreicht dasselbe Paket auch den Campus-Tab: pxt reicht jedes
Broadcast-`messagepacket` zusätzlich an das Eltern-Fenster des Editors weiter,
und dort wartet `serialRelay.handleSimulatorMessage` auf genau den Kanal `iot`.

## Eintragen im Target

In `pxt-calliope/targetconfig.json` unter `packages.approvedRepoLib` — und zwar
beim Schlüssel der EXTENSION, nicht bei dem des Panels. pxt schlägt den simx
über den Kanal nach, den das Programm sendet, und das ist der Repo-Name von
`pxt-grove`:

```json
"amerlander/pxt-grove": {
    "simx": {
        "sha": "<commit-sha>",
        "devUrl": "http://localhost:3400",
        "aspectRatio": 0.78
    }
}
```

`aspectRatio` ist **Breite geteilt durch Höhe** und die einzige Stelle, an der
die Höhe des Panels festgelegt wird: pxt setzt daraus `padding-bottom: 100/r %`
auf den Rahmen (`applyAspectRatioToFrame` in `pxtsim/simdriver.ts`). Der
Vorgabewert 1.22 stammt vom Simulator selbst — ein liegendes Board — und gab
dem Panel eine Höhe von 0,82 Breiten; eine Werteliste ist das Gegenteil eines
liegenden Boards. 0.78 macht sie 1,28 Breiten hoch, also gut die Hälfte mehr.

`devUrl` greift, solange der Editor mit `simxdev=1` läuft — das tut die
Campus-Einbettung bereits (die iframe-URL trägt den Parameter, sobald der Editor
selbst auf localhost liegt). Für den Produktivbetrieb zählt der `sha`.

## Entwickeln

```
npm install
npm run dev     # http://localhost:3400
```

Port 3400, nicht 3000: Der Campus zeigt mit `PUBLIC_PYEDITOR_BASE_URL` bereits
auf `localhost:3000`, und zwei Server auf einem Port sind kein Fehler, den man
sieht — man sieht ein Panel, das nicht lädt.

Dann in MakeCode ein Programm mit den IoT-Blöcken öffnen und den Simulator
starten.
