# ioBroker.victron-vrm

Ersetzt den bisherigen Node-RED-Flow für Victron-VRM-Diagnosedaten durch einen
eigenständigen ioBroker-Adapter. Objekte bekommen dabei automatisch die
richtige `common.unit` (aus `formatWithUnit`) und eine passende `common.role`
statt der generischen Node-RED-Autocreate-Objekte.

## Status

Erste funktionsfähige Version. Noch offen / bewusst einfach gehalten:

- Kein Devcontainer/Testgerüst von `@iobroker/create-adapter` – dieses Projekt
  wurde von Hand nach dessen Struktur gebaut. Am einfachsten lässt sich das
  nachträglich zusammenführen, indem man `@iobroker/create-adapter` in einem
  leeren Ordner laufen lässt und die generierten Dev-/Testdateien
  (`.devcontainer/`, `test/`, ESLint-Config) übernimmt.
- Kein Adapter-Icon (`admin/victron-vrm.png`, 64x64px) – ohne Icon startet der
  Adapter trotzdem, im Admin fehlt nur das Bildchen.
- `common.role`-Mapping ist eine einfache Unit→Role-Tabelle
  (`UNIT_ROLE_MAP` in `main.js`). Für differenziertere Rollen (z. B. anhand
  von `dbusPath`/`dbusServiceType`) ist das der Ansatzpunkt zum Erweitern.

## Installation im Codespace

```bash
cd iobroker.victron-vrm
npm install
```

## Lokal gegen eine laufende ioBroker-Instanz testen

Am einfachsten über den ioBroker-eigenen Weg, einen Adapter aus einem
Ordner zu installieren (auf dem ioBroker-Host, nicht im Codespace):

```bash
cd /opt/iobroker
npm install <pfad-oder-git-url-zum-adapter-ordner>
iobroker upload victron-vrm
iobroker add victron-vrm
```

Danach im Admin unter Instanzen → victron-vrm.0 → Konfiguration:

- **VRM Access Token**: VRM-Portal → Preferences → Integrations →
  Access tokens → neues Token erzeugen
- **Installations-ID**: aus der VRM-URL
  (`vrm.victronenergy.com/installation/<idSite>/dashboard`)
- **Abfrageintervall**: in Sekunden, Default 30

Nach dem Start sollten unter `victron-vrm.0.*` die Objekte erscheinen,
mit `info.connection` als Statusanzeige, ob die API erreichbar ist.

