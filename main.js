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
        // Erstelle info.connection State-Objekt
        await this.extendObjectAsync("info.connection", {
            type: "state",
            common: {
                name: "VRM Connection Status",
                type: "boolean",
                role: "indicator.connection",
                read: true,
                write: false
            },
            native: {}
        });

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
     * Baut die Standard-Header für API-Requests
     */
    getHeaders() {
        return {
            "X-Authorization": `Token ${this.config.token}`,
            "Accept": "application/json",
            "User-Agent": "ioBroker.victron-vrm/0.1.0"
        };
    }

    /**
     * Holt die Standard-Diagnosedaten
     */
    async fetchDiagnosticsData() {
        try {
            const baseUrl = `https://vrmapi.victronenergy.com/v2/installations/${this.config.idSite}`;
            const url = `${baseUrl}/diagnostics`;
            
            const response = await axios.get(url, {
                headers: this.getHeaders()
            });

            if (response.data && response.data.success && Array.isArray(response.data.records)) {
                this.setState("info.connection", true, true);
                
                // Gruppiere Records nach Device und Instance
                const groupedRecords = this.groupRecordsByDevice(response.data.records);
                
                // Verarbeite jedes Device
                for (const [deviceType, instances] of Object.entries(groupedRecords)) {
                    await this.processDeviceType(deviceType, instances);
                }
            } else {
                this.log.warn(`Unerwartete API-Antwortstruktur bei diagnostics.`);
                this.setState("info.connection", false, true);
            }
        } catch (error) {
            this.log.error(`Fehler beim Abruf der Diagnosedaten: ${error.message}`);
            this.setState("info.connection", false, true);
        }
    }

    /**
     * Gruppiert Records nach Device-Typ und Instance
     */
    groupRecordsByDevice(records) {
        const grouped = {};
        
        for (const record of records) {
            const deviceType = record.Device || "Unknown";
            const instance = record.instance || 0;
            
            if (!grouped[deviceType]) {
                grouped[deviceType] = {};
            }
            if (!grouped[deviceType][instance]) {
                grouped[deviceType][instance] = [];
            }
            
            grouped[deviceType][instance].push(record);
        }
        
        return grouped;
    }

    /**
     * Verarbeitet einen Device-Typ (z.B. Tank, Temperature sensor, Battery Monitor, etc.)
     */
    async processDeviceType(deviceType, instances) {
        if (deviceType === "Tank") {
            await this.processTanks(instances);
        } else if (deviceType === "Temperature sensor") {
            await this.processTemperatureSensors(instances);
        } else if (deviceType === "Gateway") {
            await this.processGateway(instances);
        } else {
            await this.processGenericDevice(deviceType, instances);
        }
    }

    /**
     * Verarbeitet Tank-Daten
     */
    async processTanks(instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            // Finde den custom name (code: "tcn") - nutze formattedValue, nicht description!
            const customNameRecord = records.find(r => r.code === "tcn");
            const customName = customNameRecord ? customNameRecord.formattedValue : `Tank ${instanceKey}`;
            
            // Erstelle Channel für diesen Tank mit seinem custom name als Channel-Name
            const channelId = `Tank.${this.sanitizeName(customName)}`;
            
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: customName },
                native: {}
            });
            
            // Verarbeite alle Records dieses Tanks (AUSSER tcn, das ist nur für den Namen)
            for (const record of records) {
                if (!record.idDataAttribute) continue;
                if (record.code === "tcn") continue; // tcn ist nur der Channel-Name, nicht ein State
                
                const dpId = `${channelId}.${this.sanitizeName(record.code)}`;
                const name = record.description || record.code;
                const value = record.formattedValue;
                
                let unit = "";
                if (record.formatWithUnit) {
                    unit = record.formatWithUnit.replace("%val", "").replace("%s", "").trim();
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
    }

    /**
     * Verarbeitet Temperature Sensor-Daten
     */
    async processTemperatureSensors(instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            // Finde den custom name (code: "tscn") - nutze formattedValue, nicht description!
            const customNameRecord = records.find(r => r.code === "tscn");
            const customName = customNameRecord ? customNameRecord.formattedValue : `Temperature sensor ${instanceKey}`;
            
            // Erstelle Channel für diesen Sensor mit seinem custom name als Channel-Name
            const channelId = `Temperature sensor.${this.sanitizeName(customName)}`;
            
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: customName },
                native: {}
            });
            
            // Verarbeite alle Records dieses Sensors (AUSSER tscn, das ist nur für den Namen)
            for (const record of records) {
                if (!record.idDataAttribute) continue;
                if (record.code === "tscn") continue; // tscn ist nur der Channel-Name, nicht ein State
                
                const dpId = `${channelId}.${this.sanitizeName(record.code)}`;
                const name = record.description || record.code;
                const value = record.formattedValue;
                
                let unit = "";
                if (record.formatWithUnit) {
                    unit = record.formatWithUnit.replace("%val", "").replace("%s", "").trim();
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
    }

    /**
     * Verarbeitet Gateway-Daten und trennt GPS in eigenständigen Channel
     */
    async processGateway(instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            const deviceType = "Gateway";
            let channelId = this.sanitizeName(deviceType);
            if (Object.keys(instances).length > 1) {
                channelId += `_${instanceKey}`;
            }
            
            // Gateway Channel
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: deviceType },
                native: {}
            });
            
            // GPS Channel (auf gleicher Ebene wie Gateway)
            const gpsChannelId = "GPS";
            await this.extendObjectAsync(gpsChannelId, {
                type: "channel",
                common: { name: "GPS" },
                native: {}
            });
            
            // Verarbeite alle Records
            for (const record of records) {
                if (!record.idDataAttribute) continue;
                
                const dpId = record.code.startsWith("gps_") 
                    ? `${gpsChannelId}.${this.sanitizeName(record.code)}`
                    : `${channelId}.${this.sanitizeName(record.code)}`;
                const name = record.description || record.code;
                const value = record.formattedValue;
                
                let unit = "";
                if (record.formatWithUnit) {
                    unit = record.formatWithUnit.replace("%val", "").replace("%s", "").trim();
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
    }

    /**
     * Verarbeitet generische Devices (Battery Monitor, etc.)
     */
    async processGenericDevice(deviceType, instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            // Für generische Devices: Channel nach Device-Typ benennen
            let channelId = this.sanitizeName(deviceType);
            if (Object.keys(instances).length > 1) {
                // Falls mehrere Instances: Nummer anhängen
                channelId += `_${instanceKey}`;
            }
            
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: deviceType },
                native: {}
            });
            
            // Verarbeite alle Records
            for (const record of records) {
                if (!record.idDataAttribute) continue;
                
                const dpId = `${channelId}.${this.sanitizeName(record.code)}`;
                const name = record.description || record.code;
                const value = record.formattedValue;
                
                let unit = "";
                if (record.formatWithUnit) {
                    unit = record.formatWithUnit.replace("%val", "").replace("%s", "").trim();
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
    }

    /**
     * Sanitiert Namen für ioBroker-IDs (erlaubt nur A-Z, 0-9, _ und .)
     */
    sanitizeName(name) {
        if (!name) return "unknown";
        return String(name)
            .toLowerCase()
            .replace(/[^a-z0-9._]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_|_$/g, "");
    }

    /**
     * Holt die PV-Prognose und den Verbrauchs-Forecast
     * Nutzt den korrekten Endpoint type=forecast, der alle Prognosedaten
     * in einem gemeinsamen Response liefert (solar_yield_forecast, vrm_consumption_fc, etc.)
     */
    async fetchForecastData() {
        try {
            this.log.debug("Frage Forecast-Daten von VRM API ab...");
            
            const baseUrl = `https://vrmapi.victronenergy.com/v2/installations/${this.config.idSite}`;
            const url = `${baseUrl}/stats?type=forecast&interval=hours`;

            this.log.debug(`Fetching forecast from: ${url}`);
            const response = await axios.get(url, {
                headers: this.getHeaders()
            });

            if (response.data && response.data.success && response.data.records) {
                const records = response.data.records;
                this.log.debug(`Forecast response keys: ${Object.keys(records).join(", ")}`);

                // Solar-Ertrag Prognose
                if (Array.isArray(records.solar_yield_forecast) && records.solar_yield_forecast.length > 0) {
                    await this.processForecastRecords(records.solar_yield_forecast, "forecast.solar");
                    this.log.info("PV-Forecast erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine PV-Forecast-Daten verfügbar");
                }

                // Verbrauchs-Prognose
                if (Array.isArray(records.vrm_consumption_fc) && records.vrm_consumption_fc.length > 0) {
                    await this.processForecastRecords(records.vrm_consumption_fc, "forecast.consumption");
                    this.log.info("Verbrauchs-Forecast erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine Verbrauchs-Forecast-Daten verfügbar");
                }
            } else {
                this.log.warn("Forecast: unerwartete Response-Struktur");
            }
        } catch (error) {
            this.log.error(`Fehler beim Abruf der Forecast-Daten: ${error.message}`);
        }
    }

    /**
     * Hilfsfunktion: Verarbeitet ein [Timestamp(ms), Value] Array in States
     */
    async processForecastRecords(rawEntries, baseChannel) {
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
            this.log.warn(`No forecast entries found for ${baseChannel}`);
            return;
        }

        this.log.info(`Processing ${rawEntries.length} forecast entries for ${baseChannel}`);

        // Iteriert durch das [Timestamp, Value] Format der API
        const entries = rawEntries.map(item => {
            if (Array.isArray(item) && item.length >= 2) {
                return { timestamp: Math.round(item[0] / 1000), value: item[1] };
            }
            return null;
        }).filter(item => item !== null).sort((a, b) => a.timestamp - b.timestamp);

        if (entries.length === 0) {
            this.log.warn(`No valid forecast entries after parsing for ${baseChannel}`);
            return;
        }

        // Nur zukünftige Einträge (ab jetzt) berücksichtigen
        const nowSec = Math.floor(Date.now() / 1000);
        const futureEntries = entries.filter(e => e.timestamp >= nowSec - 3600);
        const relevantEntries = futureEntries.length > 0 ? futureEntries : entries;

        // Erstelle Forecast Channel
        await this.extendObjectAsync(baseChannel, {
            type: "channel",
            common: { name: baseChannel.replace("forecast.", "") },
            native: {}
        });

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
        await this.setStateAsync(jsonDpId, JSON.stringify(relevantEntries), true);

        // Schreibt die nächsten 12 stündlichen Segmente in Einzeldatenpunkte
        for (let i = 0; i < Math.min(relevantEntries.length, 12); i++) {
            const entry = relevantEntries[i];
            const dateStr = new Date(entry.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            
            const dpValueId = `${baseChannel}.plus_${i}_hour.value`;
            const dpTimeId = `${baseChannel}.plus_${i}_hour.time`;

            await this.extendObjectAsync(dpValueId, {
                type: "state",
                common: {
                    name: `In ${i} Stunden (${dateStr})`,
                    type: "number",
                    role: "value.power",
                    unit: "kWh",
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
