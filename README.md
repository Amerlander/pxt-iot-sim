# pxt-iot-sim — die Dashboard-Ansicht neben dem Simulator

Eine **Simulator-Extension** (simx) für MakeCode: ein Panel neben dem Simulator,
das die Feeds des verknüpften IoT-Dashboards live zeigt. Damit sieht ein Kind
beim Programmieren, was sein Programm senden *würde* und was auf dem Dashboard
gerade steht — ohne Gerät am Kabel.

## Woher die Daten kommen

**Direkt aus PocketBase**, nicht über den Campus-Tab.

Das ist die wichtigere der beiden Entscheidungen. Der Umweg über den Host wäre
möglich — die Klempnerei dafür liegt fertig in `serialRelay.handleSimulatorMessage`
(Kanal `iot`) — aber sie bindet das Panel an einen eingebetteten Campus. Über
PocketBase funktioniert es auch im nackten MakeCode, und es liest dieselbe
Realtime-Quelle wie `IotDashboard.svelte`: `iot_last` und `iot_feeds`.

Der Preis ist ehrlich zu nennen: Das Panel braucht eine Adresse und einen
Lesezugang. Beides steht im Programm — der Dashboard-Block trägt Slug oder
Token und optional die Serveradresse —, und das Programm sagt es dem Panel über
den simx-Kanal (siehe unten).

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

**Offen und wichtig:** Die Extension schweigt im Simulator, solange der Schalter
„im Simulator senden" am Übertragungsblock aus ist —

```ts
function emit(zeile: string): void {
    if (istSimulator() && !simSenden) return
    …
}
```

Der Grund dafür steht im Code: pxt reichte Simulator-Ausgaben bisher an keinen
Host weiter, der Schalter war der Anknüpfpunkt „für später". Mit diesem Panel
ist „später" da. Die Entscheidung, ob der Schalter fällt oder bleibt, gehört
in `pxt-grove`, nicht hierher — und bis sie fällt, muss man ihn einschalten,
sonst zeigt das Panel nichts.

## Eintragen im Target

Wie `calliope-edu/gamekit` es tut, in `targetconfig.json` unter `packages.approvedRepos`:

```json
"amerlander/pxt-iot-sim": {
    "simx": {
        "sha": "<commit-sha>",
        "devUrl": "http://localhost:3000"
    }
}
```

`devUrl` greift, solange der Editor mit `simxdev=1` läuft — das tut die
Campus-Einbettung bereits (die iframe-URL trägt den Parameter). Für den
Produktivbetrieb zählt der `sha`.

## Entwickeln

```
npm install
npm run dev     # http://localhost:3000
```

Dann in MakeCode ein Programm mit den IoT-Blöcken öffnen, den Simulator starten
und „im Simulator senden" einschalten.
