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
     * Bereinigt Unit-Strings: extrahiert nur den Teil nach dem letzten Leerzeichen
     * z.B. "%.1F Ah" → "Ah", "%d W" → "W", "%s" → ""
     */
    cleanUnit(formatWithUnit) {
        if (!formatWithUnit) return "";
        const lastSpace = formatWithUnit.lastIndexOf(' ');
        if (lastSpace === -1) return ""; // Kein Leerzeichen = keine Unit
        return formatWithUnit.substring(lastSpace + 1).trim();
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
                
                const unit = this.cleanUnit(record.formatWithUnit);
                
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
                
                const unit = this.cleanUnit(record.formatWithUnit);
                
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
     * Verarbeitet Gateway-Daten und trennt GPS in eigenständigen Channel.
     * GPS-Records werden über das Feld dbusServiceType === "gps" identifiziert
     * (Codes: lt=Latitude, lg=Longitude, lc=Course, la=Altitude, etc.)
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
                
                const isGps = record.dbusServiceType === "gps";
                const dpId = isGps
                    ? `${gpsChannelId}.${this.sanitizeName(record.code)}`
                    : `${channelId}.${this.sanitizeName(record.code)}`;
                const name = record.description || record.code;
                const value = record.formattedValue;
                
                const unit = this.cleanUnit(record.formatWithUnit);
                
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
                
                const unit = this.cleanUnit(record.formatWithUnit);
                
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
     * Ruft sowohl stündliche Daten (nächste 48h) als auch tägliche Aggregaten 
     * (Morgen, Übermorgen) ab
     */
    async fetchForecastData() {
        try {
            this.log.debug("Frage Forecast-Daten von VRM API ab...");
            
            const baseUrl = `https://vrmapi.victronenergy.com/v2/installations/${this.config.idSite}`;
            const nowSec = Math.floor(Date.now() / 1000);
            const endSec = nowSec + (48 * 3600); // 48 Stunden in die Zukunft

            // Abruf stündliche Daten
            this.log.debug(`Fetching hourly forecast from: ${baseUrl}/stats?type=forecast&interval=hours&start=${nowSec}&end=${endSec}`);
            const hourlyResponse = await axios.get(`${baseUrl}/stats?type=forecast&interval=hours&start=${nowSec}&end=${endSec}`, {
                headers: this.getHeaders()
            });

            if (hourlyResponse.data && hourlyResponse.data.success && hourlyResponse.data.records) {
                const records = hourlyResponse.data.records;
                this.log.debug(`Hourly forecast response keys: ${Object.keys(records).join(", ")}`);

                // Solar-Ertrag Prognose (stündlich)
                if (Array.isArray(records.solar_yield_forecast) && records.solar_yield_forecast.length > 0) {
                    await this.processForecastRecordsHourly(records.solar_yield_forecast, "forecast.solar");
                    this.log.info("PV-Forecast (stündlich) erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine PV-Forecast-Daten (stündlich) verfügbar");
                }

                // Verbrauchs-Prognose (stündlich)
                if (Array.isArray(records.vrm_consumption_fc) && records.vrm_consumption_fc.length > 0) {
                    await this.processForecastRecordsHourly(records.vrm_consumption_fc, "forecast.consumption");
                    this.log.info("Verbrauchs-Forecast (stündlich) erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine Verbrauchs-Forecast-Daten (stündlich) verfügbar");
                }
            } else {
                this.log.warn("Hourly Forecast: unerwartete Response-Struktur");
            }

            // Abruf tägliche Daten (Morgen, Übermorgen)
            // Berechne Start auf Mitternacht morgen und Ende auf Ende Übermorgen
            const tomorrowStart = Math.floor((nowSec + 86400) / 86400) * 86400;
            const dayAfterTomorrowEnd = tomorrowStart + (2 * 86400);
            
            this.log.debug(`Fetching daily forecast from: ${baseUrl}/stats?type=forecast&interval=days&start=${tomorrowStart}&end=${dayAfterTomorrowEnd}`);
            const dailyResponse = await axios.get(`${baseUrl}/stats?type=forecast&interval=days&start=${tomorrowStart}&end=${dayAfterTomorrowEnd}`, {
                headers: this.getHeaders()
            });

            if (dailyResponse.data && dailyResponse.data.success && dailyResponse.data.records) {
                const records = dailyResponse.data.records;
                this.log.debug(`Daily forecast response keys: ${Object.keys(records).join(", ")}`);

                // Solar-Ertrag Prognose (täglich)
                if (Array.isArray(records.solar_yield_forecast) && records.solar_yield_forecast.length > 0) {
                    await this.processForecastRecordsDaily(records.solar_yield_forecast, "forecast.solar");
                    this.log.info("PV-Forecast (täglich) erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine PV-Forecast-Daten (täglich) verfügbar");
                }

                // Verbrauchs-Prognose (täglich)
                if (Array.isArray(records.vrm_consumption_fc) && records.vrm_consumption_fc.length > 0) {
                    await this.processForecastRecordsDaily(records.vrm_consumption_fc, "forecast.consumption");
                    this.log.info("Verbrauchs-Forecast (täglich) erfolgreich verarbeitet");
                } else {
                    this.log.info("Keine Verbrauchs-Forecast-Daten (täglich) verfügbar");
                }
            } else {
                this.log.warn("Daily Forecast: unerwartete Response-Struktur");
            }
        } catch (error) {
            this.log.error(`Fehler beim Abruf der Forecast-Daten: ${error.message}`);
        }
    }

    /**
     * Verarbeitet stündliche Forecast-Daten: [Timestamp(ms), Value] Array
     */
    async processForecastRecordsHourly(rawEntries, baseChannel) {
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
            this.log.warn(`No hourly forecast entries found for ${baseChannel}`);
            return;
        }

        this.log.info(`Processing ${rawEntries.length} hourly forecast entries for ${baseChannel}`);

        // Konvertiere zu Sekunden
        const entries = rawEntries.map(item => {
            if (Array.isArray(item) && item.length >= 2) {
                return { timestamp: Math.round(item[0] / 1000), value: item[1] };
            }
            return null;
        }).filter(item => item !== null).sort((a, b) => a.timestamp - b.timestamp);

        if (entries.length === 0) {
            this.log.warn(`No valid hourly forecast entries after parsing for ${baseChannel}`);
            return;
        }

        // Schreibt die nächsten 12 stündlichen Segmente
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
     * Verarbeitet tägliche Forecast-Daten: [Timestamp(ms), Value] Array
     * Speichert Werte als day_1 (morgen), day_2 (übermorgen)
     */
    async processForecastRecordsDaily(rawEntries, baseChannel) {
        if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
            this.log.warn(`No daily forecast entries found for ${baseChannel}`);
            return;
        }

        this.log.info(`Processing ${rawEntries.length} daily forecast entries for ${baseChannel}`);

        // Konvertiere zu Sekunden und sortiere
        const entries = rawEntries.map(item => {
            if (Array.isArray(item) && item.length >= 2) {
                return { timestamp: Math.round(item[0] / 1000), value: item[1] };
            }
            return null;
        }).filter(item => item !== null).sort((a, b) => a.timestamp - b.timestamp);

        if (entries.length === 0) {
            this.log.warn(`No valid daily forecast entries after parsing for ${baseChannel}`);
            return;
        }

        // Schreibe die ersten 2 Tage (Morgen, Übermorgen)
        for (let i = 0; i < Math.min(entries.length, 2); i++) {
            const entry = entries[i];
            const date = new Date(entry.timestamp * 1000);
            const dateStr = date.toLocaleDateString('de-DE', { weekday: 'short', month: 'numeric', day: 'numeric' });
            
            const dpId = `${baseChannel}.day_${i + 1}`;

            await this.extendObjectAsync(dpId, {
                type: "state",
                common: {
                    name: `${dateStr} (Tag ${i + 1})`,
                    type: "number",
                    role: "value.energy",
                    unit: "Wh",
                    read: true,
                    write: false
                },
                native: {}
            });
            await this.setStateAsync(dpId, entry.value, true);
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
            case "Ah": return "value.battery";
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
