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
        } else {
            await this.processGenericDevice(deviceType, instances);
        }
    }

    /**
     * Verarbeitet Tank-Daten
     */
    async processTanks(instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            // Finde den custom name (code: "tcn")
            const customNameRecord = records.find(r => r.code === "tcn");
            const customName = customNameRecord ? customNameRecord.description : `Tank ${instanceKey}`;
            
            // Erstelle Channel für diesen Tank mit seinem custom name
            const channelId = `Tank.${this.sanitizeName(customName)}`;
            
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: customName },
                native: {}
            });
            
            // Verarbeite alle Records dieses Tanks
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
     * Verarbeitet Temperature Sensor-Daten
     */
    async processTemperatureSensors(instances) {
        for (const [instanceKey, records] of Object.entries(instances)) {
            // Finde den custom name (code: "tscn")
            const customNameRecord = records.find(r => r.code === "tscn");
            const customName = customNameRecord ? customNameRecord.description : `Temperature sensor ${instanceKey}`;
            
            // Erstelle Channel für diesen Sensor mit seinem custom name
            const channelId = `Temperature sensor.${this.sanitizeName(customName)}`;
            
            await this.extendObjectAsync(channelId, {
                type: "channel",
                common: { name: customName },
                native: {}
            });
            
            // Verarbeite alle Records dieses Sensors
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
     * Verarbeitet generische Devices (Battery Monitor, Gateway, etc.)
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
     */
    async fetchForecastData() {
        try {
            this.log.debug("Frage Forecast-Daten von VRM API ab...");
            
            const baseUrl = `https://vrmapi.victronenergy.com/v2/installations/${this.config.idSite}`;

            // 1. PV-Prognose (solar_forecast)
            const urlSolar = `${baseUrl}/stats?type=solar_forecast&interval=hours`;
            const resSolar = await axios.get(urlSolar, {
                headers: this.getHeaders()
            });
            if (resSolar.data && resSolar.data.success && resSolar.data.records) {
                await this.processForecastRecords(resSolar.data.records, "forecast.solar");
            }

            // 2. Verbrauchs-Prognose (vrm_consumption_fc)
            const urlCons = `${baseUrl}/stats?type=vrm_consumption_fc&interval=hours`;
            const resCons = await axios.get(urlCons, {
                headers: this.getHeaders()
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
