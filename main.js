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
        // Validierung der Konfigurationswerte
        if (!this.config.token || !this.config.idSite) {
            this.log.error("VRM Access Token oder Installations-ID (idSite) fehlt in der Konfiguration!");
            this.setState("info.connection", false, true);
            return;
        }

        this.log.info(`Starte Victron VRM Adapter für Instanz ${this.config.idSite}`);
        
        // Erstmaliger Datenabruf beim Start
        await this.fetchDiagnosticsData();
        await this.fetchForecastData();

        // Intervall für Live-Diagnosedaten aus Config (Standard: 30s)
        const intervalSec = parseInt(this.config.interval, 10) || 30;
        this.updateInterval = this.setInterval(async () => {
            await this.fetchDiagnosticsData();
        }, intervalSec * 1000);

        // Prognosedaten ändern sich selten -> Abruf alle 30 Minuten
        this.forecastInterval = this.setInterval(async () => {
            await this.fetchForecastData();
        }, 30 * 60 * 1000);
    }

    /**
     * Holt die Standard-Diagnosedaten
     */
    async fetchDiagnosticsData() {
        try {
            const baseUrl = `https://vrm.victronenergy.com/installation/${this.config.idSite}`;
            const url = `${baseUrl}/diagnostics`;
            const response = await axios.get(url, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });

            if (response.data && response.data.success && response.data.records) {
                this.setState("info.connection", true, true);
                
                for (const record of response.data.records) {
                    if (!record.idAttribute) continue;
                    
                    const dpId = `diagnostics.${record.idAttribute}`;
                    const name = record.description || record.code;
                    const value = record.formattedValue; 
                    
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

                // Extrahiere Tank Custom Names
                await this.extractTankCustomNames(response.data.records);
                
                // Extrahiere Temperature Sensor Custom Names
                await this.extractTemperatureSensorCustomNames(response.data.records);
            }
        } catch (error) {
            this.log.error(`Fehler beim Abruf der Diagnosedaten: ${error.message}`);
            this.setState("info.connection", false, true);
        }
    }

    /**
     * Extrahiert Tank Custom Names aus diagnostics und erstellt benutzerdefinierte Channels
     */
    async extractTankCustomNames(records) {
        try {
            // Filter nach Tank-Records die ein idAttribute mit "Tank" und einer Nummer haben
            const tankRecords = records.filter(r =>
                r.idAttribute && /Tank\d+/i.test(r.idAttribute)
            );

            for (const record of tankRecords) {
                const match = record.idAttribute.match(/Tank(\d+)/i);
                if (!match) continue;

                const tankNumber = match[1];
                const tankChannelId = `Tank${tankNumber}`;
                
                // Erstelle den Tank-Channel
                await this.extendObjectAsync(tankChannelId, {
                    type: "channel",
                    common: {
                        name: "Tank"
                    },
                    native: {}
                });

                // Erstelle den custom_name State darin
                const dpId = `${tankChannelId}.tank_custom_name`;
                const customName = record.description || record.code || `Tank ${tankNumber}`;

                await this.extendObjectAsync(dpId, {
                    type: "state",
                    common: {
                        name: "Tank Custom Name",
                        type: "string",
                        role: "info.name",
                        read: true,
                        write: false
                    },
                    native: {}
                });

                await this.setStateAsync(dpId, customName, true);
            }
        } catch (error) {
            this.log.error(`Fehler beim Extrahieren von Tank Custom Names: ${error.message}`);
        }
    }

    /**
     * Extrahiert Temperature Sensor Custom Names aus diagnostics und erstellt benutzerdefinierte Channels
     */
    async extractTemperatureSensorCustomNames(records) {
        try {
            // Filter nach Temperature Sensor Records
            const tempRecords = records.filter(r =>
                r.idAttribute && /Temperature.*Sensor\d+/i.test(r.idAttribute)
            );

            for (const record of tempRecords) {
                const match = record.idAttribute.match(/Sensor(\d+)/i) || record.idAttribute.match(/(\d+)$/);
                if (!match) continue;

                const sensorNumber = match[1];
                const sensorChannelId = `Temperature sensor${sensorNumber}`;
                
                // Erstelle den Temperature Sensor Channel
                await this.extendObjectAsync(sensorChannelId, {
                    type: "channel",
                    common: {
                        name: "Temperature Sensor"
                    },
                    native: {}
                });

                // Erstelle den temperature_custom_name State darin
                const dpId = `${sensorChannelId}.temperature_custom_name`;
                const customName = record.description || record.code || `Temperature Sensor ${sensorNumber}`;

                await this.extendObjectAsync(dpId, {
                    type: "state",
                    common: {
                        name: "Temperature Sensor Custom Name",
                        type: "string",
                        role: "info.name",
                        read: true,
                        write: false
                    },
                    native: {}
                });

                await this.setStateAsync(dpId, customName, true);
            }
        } catch (error) {
            this.log.error(`Fehler beim Extrahieren von Temperature Sensor Custom Names: ${error.message}`);
        }
    }

    /**
     * Holt die PV-Prognose und den Verbrauchs-Forecast
     */
    async fetchForecastData() {
        try {
            this.log.debug("Frage Forecast-Daten von VRM API ab...");
            
            const baseUrl = `https://vrm.victronenergy.com/installation/${this.config.idSite}`;

            // 1. PV-Prognose (solar_forecast)
            const urlSolar = `${baseUrl}/stats?type=solar_forecast&interval=hours`;
            const resSolar = await axios.get(urlSolar, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });
            if (resSolar.data && resSolar.data.success && resSolar.data.records) {
                await this.processForecastRecords(resSolar.data.records, "forecast.solar");
            }

            // 2. Verbrauchs-Prognose (vrm_consumption_fc)
            const urlCons = `${baseUrl}/stats?type=vrm_consumption_fc&interval=hours`;
            const resCons = await axios.get(urlCons, {
                headers: { "X-Authorization": `Bearer ${this.config.token}` }
            });
            if (resCons.data && resCons.data.success && resCons.data.records) {
                await this.processForecastRecords(resCons.data.records, "forecast.consumption");
            }

        } catch (error) {
            this.log.error(`Fehler beim Abruf der Forecast-Daten: ${error.message}`);
        }
    }

    /**
     * Hilfsfunktion: Verarbeitet die verschachtelten Victron-Arrays
     */
    async processForecastRecords(records, baseChannel) {
        let rawEntries = [];
        
        // Victron liefert im Stats-Endpunkt ein Objekt zurück, dessen Key dynamisch dem Typ entspricht
        const keys = Object.keys(records);
        if (keys.length > 0 && Array.isArray(records[keys[0]])) {
            rawEntries = records[keys[0]];
        } else if (Array.isArray(records)) {
            rawEntries = records;
        }

        if (rawEntries.length === 0) return;

        // Iteriert durch das [Timestamp, Value] Format der API
        const entries = rawEntries.map(item => {
            if (Array.isArray(item) && item.length >= 2) {
                return { timestamp: Math.round(item[0] / 1000), value: item[1] };
            }
            return null;
        }).filter(item => item !== null).sort((a, b) => a.timestamp - b.timestamp);

        if (entries.length === 0) return;

        // Speichere die kompletten Rohdaten als JSON-String
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

        // Schreibt die nächsten 12 stündlichen Segmente in Einzeldatenpunkte
        for (let i = 0; i < Math.min(entries.length, 12); i++) {
            const entry = entries[i];
            const dateStr = new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            
            const dpValueId = `${baseChannel}.plus_${i}_hour.value`;
            const dpTimeId = `${baseChannel}.plus_${i}_hour.time`;

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
     * Hilfsfunktion zur automatischen Rollen-Zuweisung
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
    module.exports = (options) => new VictronVrm(options);
} else {
    new VictronVrm();
}
