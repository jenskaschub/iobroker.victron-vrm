# ioBroker.victron-vrm

Adapter für die Victron VRM API (Diagnostics-Endpoint). Liest Messwerte einer
VRM-Installation aus und legt dafür passende ioBroker-Objekte an – inklusive
korrekter `common.unit` (aus `formatWithUnit`) und passender `common.role`,
statt nur generischer Werte ohne Einheit.

Dieses Projekt steht in keiner Verbindung zu und wird nicht unterstützt von
Victron Energy. "Victron" und "VRM" sind Marken von Victron Energy B.V.
Die Nutzung der VRM API unterliegt den Bedingungen von Victron Energy
(u. a. nicht für kommerzielle/professionelle Zwecke vorgesehen, ohne
Support seitens Victron).

## Warum über die VRM API statt MQTT/Modbus?

Die meisten existierenden Victron-Integrationen (auch für ioBroker/Home
Assistant) lesen die Daten lokal vom GX-Gerät (Cerbo GX o.ä.) per MQTT oder
Modbus TCP aus – das setzt voraus, dass die Installation im selben lokalen
Netz erreichbar ist. Dieser Adapter fragt stattdessen die Daten, die das
GX-Gerät ohnehin an das VRM-Portal sendet, über die VRM-Cloud-API ab.

Das ist sinnvoll, wenn die Installation nicht im lokalen Netz hängt, sondern
z. B. nur per Mobilfunk am VRM-Portal angebunden ist (wie im Ursprungsfall
dieses Adapters: keine direkte lokale Erreichbarkeit, davor lief die
Anbindung über MQTT mit ca. 3 GB Datenvolumen pro Monat und teils doppelt
übertragenen Daten). Der Nachteil: Man ist auf das Poll-Intervall angewiesen
statt auf Echtzeit-Pushes, und die Daten müssen erst den Umweg über die
VRM-Cloud nehmen.



- **VRM Access Token**: VRM-Portal → Preferences → Integrations →
  Access tokens → neues Token erzeugen
- **Installations-ID**: aus der VRM-URL
  (`vrm.victronenergy.com/installation/<idSite>/dashboard`)
- **Abfrageintervall**: in Sekunden, Default 30

Nach dem Start sollten unter `victron-vrm.0.*` die Objekte erscheinen,
mit `info.connection` als Statusanzeige, ob die API erreichbar ist.

