"use strict";

const utils = require("@iobroker/adapter-core");
const axios = require("axios");

class VictronVrm extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "victron-vrm",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
        
        this.updateInterval = null;
        this.forecastInterval = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Überprüfen, ob die Konfiguration vorhanden ist
        if (!this.config.token || !this.config.idSite) {
            this.log.error("VRM Access Token oder Installations-ID (idSite) fehlt in der Konfiguration!");
            this.setState("info.connection", false, true);
            return;
        }

        this.log.info(`Starte Victron VRM Adapter für Instanz ${this.config.idSite}`);
        
        // Erstmaliger Abruf beim Start
        await this.fetchDiagnosticsData();
        await this.fetchForecastData();

        // Intervall für Live-Diagnosedaten (z. B. alle 30-60 Sekunden aus Config)
        const intervalSec = parseInt(this.config.interval, 10) || 30;
        this.updateInterval = this.setInterval(async () => {
            await this.fetchDiagnosticsData();
        }, intervalSec * 1000);

        // Prognosedaten ändern sich selten. Ein Abruf alle 30 Minuten schont die API-Limits.
        this.forecastInterval = this.setInterval(async () => {
            await this.fetchForecastData();
        }, 30 * 60 * 1000);
    }

    /**
     * Holt die Standard-Diagnosedaten (Bisherige Logik)
     */
    async fetchDiagnosticsData() {
        try {
            const url = `https://victronenergy.com{this.config.idSite}/diagnostics`;
            const response = await axios.get(url, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });

            if (response.data && response.data.success && response.data.records) {
                this.setState("info.connection", true, true);
                
                // Verarbeite Records und erstelle Datenpunkte analog zu deinem bisherigen Parser
                for (const record of response.data.records) {
                    if (!record.idAttribute) continue;
                    
                    const dpId = `diagnostics.${record.idAttribute}`;
                    const name = record.description || record.code;
                    const value = record.formattedValue; 
                    
                    // Extrahiere Einheit, falls vorhanden (z.B. "V", "A", "W", "%")
                    let unit = "";
                    if (record.formatWithUnit) {
                        unit = record.formatWithUnit.replace("%val", "").trim();
                    }

                    await this.extendObjectAsync(dpId, {
                        type: "state",
                        common: {
                            name: name,
                            type: typeof value === "number" ? "number" : "string",
                            role: this.determineRole(unit),
                            unit: unit,
                            read: true,
                            write: false
                        },
                        native: {}
                    });
                    
                    await this.setStateAsync(dpId, value, true);
                }
            }
        } catch (error) {
            this.log.error(`Fehler beim Abruf der Diagnosedaten: ${error.message}`);
            this.setState("info.connection", false, true);
        }
    }

    /**
     * Holt die PV-Prognose und den Verbrauchs-Forecast (Erweiterung)
     */
    async fetchForecastData() {
        try {
            this.log.debug("Frage Forecast-Daten von VRM API ab...");
            
            // Abruf für PV-Prognose (solar_forecast)
            // Intervall 'hours' liefert stündliche Auflösung für heute/morgen
            const urlForecast = `https://victronenergy.com{this.config.idSite}/stats?type=solar_forecast&interval=hours`;
            
            const response = await axios.get(urlForecast, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });

            if (response.data && response.data.success && response.data.records) {
                // Datenpunkte für PV-Prognose verarbeiten
                await this.processForecastRecords(response.data.records, "forecast.solar");
            }

            // Abruf für Verbrauchs-Prognose (vrm_consumption_fc)
            const urlConsumption = `https://victronenergy.com{this.config.idSite}/stats?type=vrm_consumption_fc&interval=hours`;
            const responseCons = await axios.get(urlConsumption, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });

            if (responseCons.data && responseCons.data.success && responseCons.data.records) {
                // Datenpunkte für Verbrauchs-Prognose verarbeiten
                await this.processForecastRecords(responseCons.data.records, "forecast.consumption");
            }

        } catch (error) {
            this.log.error(`Fehler beim Abruf der Forecast-Daten: ${error.message}`);
        }
    }

    /**
     * Hilfsfunktion um die JSON-Arrays der Forecasts in ioBroker-Strukturen zu gießen
     */
    async processForecastRecords(records, baseChannel) {
        // Falls Victron ein Objekt mit Timestamps zurückgibt (z.B. { "1711972800": 450, ... })
        // oder ein Array aus Objekten [ { timestamp: 1711972800, value: 450 } ]
        
        let entries = [];
        if (Array.isArray(records)) {
            entries = records;
        } else if (typeof records === "object") {
            entries = Object.entries(records).map(([ts, val]) => ({ timestamp: parseInt(ts, 10), value: val }));
        }

        if (entries.length === 0) return;

        // Sortieren nach Zeitstempel aufsteigend
        entries.sort((a, b) => a.timestamp - b.timestamp);

        // 1. Rohdaten als JSON-String wegspeichern (für Scripte oder Lovelace/Grafana-Charts)
        const jsonDpId = `${baseChannel}.raw_json`;
        await this.extendObjectAsync(jsonDpId, {
            type: "state",
            common: {
                name: "Rohdaten Forecast (JSON)",
                type: "string",
                role: "json",
                read: true,
                write: false
            },
            native: {}
        });
        await this.setStateAsync(jsonDpId, JSON.stringify(entries), true);

        // 2. Sinnvolle, feste Datenpunkte extrahieren (Nächste Stunden extrahieren)
        // Wir legen feste Datenpunkte für die "nächsten X Stunden" an
        for (let i = 0; i < Math.min(entries.length, 12); i++) {
            const entry = entries[i];
            const dateStr = new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            const dpValueId = `${baseChannel}.plus_${i}_hour.value`;
            const dpTimeId = `${baseChannel}.plus_${i}_hour.time`;

            // Wert-Datenpunkt (Watt oder Wattstunden je nachdem was die API liefert, meist Wh für das Intervall)
            await this.extendObjectAsync(dpValueId, {
                type: "state",
                common: {
                    name: `In ${i} Stunden (${dateStr})`,
                    type: "number",
                    role: "value.power",
                    unit: "Wh",
                    read: true,
                    write: false
                },
                native: {}
            });
            await this.setStateAsync(dpValueId, entry.value, true);

            // Uhrzeit-Datenpunkt dazu
            await this.extendObjectAsync(dpTimeId, {
                type: "state",
                common: {
                    name: `Uhrzeit für Segment +${i}`,
                    type: "string",
                    role: "date",
                    read: true,
                    write: false
                },
                native: {}
            });
            await this.setStateAsync(dpTimeId, dateStr, true);
        }
    }

    /**
     * Hilfsfunktion zur Zuweisung von ioBroker-Rollen basierend auf der Einheit
     */
    determineRole(unit) {
        switch (unit) {
            case "V": return "value.voltage";
            case "A": return "value.current";
            case "W": return "value.power";
            case "Wh":
            case "kWh": return "value.energy";
            case "%": return "value.battery";
            case "°C": return "value.temperature";
            default: return "state";
        }
    }

    /**
     * Is called when adapter shuts down.
     */
    onUnload(callback) {
        try {
            if (this.updateInterval) this.clearInterval(this.updateInterval);
            if (this.forecastInterval) this.clearInterval(this.forecastInterval);
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new VictronVrm(options);
} else {
    // otherwise start the instance directly
    new VictronVrm();
}
