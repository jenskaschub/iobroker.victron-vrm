'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

// Einheit -> passende ioBroker-role. Fallback ist 'value'.
const UNIT_ROLE_MAP = {
    '°C': 'value.temperature',
    V: 'value.voltage',
    A: 'value.current',
    W: 'value.power',
    kWh: 'value.power.consumption',
    Wh: 'value.power.consumption',
    Hz: 'value',
    Ah: 'value'
};

class VictronVrm extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'victron-vrm' });

        this.pollTimer = null;
        this.knownObjects = new Set();
        this.customNames = {};
        this.enumStates = {};

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);

        if (!this.config.vrmToken || !this.config.installationId) {
            this.log.error('VRM-Token oder Installations-ID fehlt in der Adapter-Konfiguration.');
            return;
        }

        const intervalSec = parseInt(this.config.pollInterval, 10) || 30;

        await this.poll();
        this.pollTimer = setInterval(() => this.poll(), intervalSec * 1000);
    }

    async poll() {
        await this.pollDiagnostics();
        await this.pollAlarms();
    }

    async pollDiagnostics() {
        const url = `https://vrmapi.victronenergy.com/v2/installations/${this.config.installationId}/diagnostics`;

        try {
            const response = await axios.get(url, {
                headers: { 'X-Authorization': `Token ${this.config.vrmToken}` },
                timeout: 15000
            });

            const records = response.data && response.data.records;
            if (!Array.isArray(records)) {
                this.log.warn('VRM-Antwort enthielt keine "records"-Liste - Rohantwort: ' + JSON.stringify(response.data).slice(0, 300));
                return;
            }

            await this.setStateAsync('info.connection', true, true);
            await this.processRecords(records);
        } catch (err) {
            await this.setStateAsync('info.connection', false, true);
            if (err.response) {
                this.log.error(`VRM API Fehler ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`);
            } else {
                this.log.error(`VRM API Fehler: ${err.message}`);
            }
        }
    }

    // Undokumentierter, aber durch Node-RED-Node und Drittanbieter-Clients bestätigter Endpoint.
    // Feldnamen sind noch nicht final geklärt - Objekte werden daher generisch aus dem
    // erstbesten Antwortformat abgeleitet und im Log protokolliert, damit wir bei Bedarf
    // nachschärfen können.
    async pollAlarms() {
        const url = `https://vrmapi.victronenergy.com/v2/installations/${this.config.installationId}/alarms`;

        try {
            const response = await axios.get(url, {
                headers: { 'X-Authorization': `Token ${this.config.vrmToken}` },
                timeout: 15000
            });

            const alarms = (response.data && (response.data.records || response.data.alarms)) || [];
            if (!Array.isArray(alarms)) {
                this.log.warn('VRM-Alarme: unerwartetes Antwortformat - Rohantwort: ' + JSON.stringify(response.data).slice(0, 500));
                return;
            }

            this.log.debug(`VRM-Alarme Rohantwort (${alarms.length} Einträge): ${JSON.stringify(alarms).slice(0, 1000)}`);
            await this.processAlarms(alarms);
        } catch (err) {
            if (err.response) {
                this.log.error(`VRM Alarme API Fehler ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`);
            } else {
                this.log.error(`VRM Alarme API Fehler: ${err.message}`);
            }
        }
    }

    async processAlarms(alarms) {
        for (let i = 0; i < alarms.length; i++) {
            const alarm = alarms[i];
            const idPart = alarm.nid !== undefined ? alarm.nid : alarm.id !== undefined ? alarm.id : alarm.name || i;
            const base = `Alarms.${this.cleanId(idPart)}`;

            for (const [key, value] of Object.entries(alarm)) {
                if (value === null || typeof value === 'object') {
                    continue; // verschachtelte Objekte erstmal auslassen, bis Struktur klar ist
                }

                const path = `${base}.${this.cleanId(key)}`;
                const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';

                if (!this.knownObjects.has(path)) {
                    await this.setObjectNotExistsAsync(path, {
                        type: 'state',
                        common: { name: key, type, role: 'value', read: true, write: false },
                        native: {}
                    });
                    this.knownObjects.add(path);
                }
                await this.setStateAsync(path, value, true);
            }
        }

        if (alarms.length === 0) {
            this.log.debug('VRM-Alarme: aktuell keine aktiven Alarme gemeldet.');
        }
    }

    async processRecords(records) {
        const deviceInstances = {};

        // Durchgang 1: welche Devices haben mehrere Instanzen? Custom-Names einsammeln.
        for (const item of records) {
            const deviceFolder = this.cleanId(item.Device || 'System');
            const instanceNum = item.instance !== undefined ? item.instance : 0;

            if (!deviceInstances[deviceFolder]) {
                deviceInstances[deviceFolder] = new Set();
            }
            deviceInstances[deviceFolder].add(instanceNum);

            const isNameField =
                item.code &&
                (item.code.toLowerCase().includes('name') ||
                    (item.description && item.description.toLowerCase().includes('custom name')));

            if (isNameField && item.rawValue) {
                const nameKey = `${deviceFolder}_${instanceNum}`;
                this.customNames[nameKey] = this.cleanId(item.rawValue.toString().trim());
            }
        }

        // Durchgang 2: Objekte anlegen/aktualisieren und Werte schreiben.
        for (const item of records) {
            const val = item.rawValue !== undefined && item.rawValue !== null ? item.rawValue : item.value;
            if (val === undefined || val === null) {
                continue;
            }

            const deviceFolder = this.cleanId(item.Device || 'System');
            const instanceNum = item.instance !== undefined ? item.instance : 0;
            const stateName = this.cleanId(item.description || item.code || 'Wert');

            let path = deviceFolder;
            if (deviceInstances[deviceFolder].size > 1) {
                const nameKey = `${deviceFolder}_${instanceNum}`;
                path += `.${this.customNames[nameKey] || `Instanz_${instanceNum}`}`;
            }
            path += `.${stateName}`;

            await this.ensureObject(path, item, val);
            await this.setStateAsync(path, val, true);
        }
    }

    async ensureObject(path, item, val) {
        if (this.knownObjects.has(path)) {
            if (this.enumStates[path]) {
                await this.maybeUpdateEnumState(path, val, item);
            }
            return;
        }

        // Objekt existiert eventuell schon aus einem früheren Adapter-Lauf -
        // dessen common.states (gelernte Enum-Werte) übernehmen statt zu verlieren.
        const existing = await this.getObjectAsync(path);

        const unit = this.parseUnit(item.formatWithUnit);
        const type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
        const role = this.guessRole(unit, item);
        const isEnum = this.looksLikeEnum(unit, val, item);

        const common = {
            name: item.description || item.code || path,
            type,
            role,
            read: true,
            write: false
        };
        if (unit) {
            common.unit = unit;
        }

        if (isEnum) {
            const states = existing && existing.common && existing.common.states ? { ...existing.common.states } : {};
            const key = String(val);
            if (states[key] === undefined) {
                states[key] = item.value.toString().trim();
            }
            common.states = states;
            this.enumStates[path] = states;
        }

        const objDef = {
            type: 'state',
            common,
            native: {
                code: item.code || '',
                dbusServiceType: item.dbusServiceType || '',
                dbusPath: item.dbusPath || ''
            }
        };

        if (existing) {
            await this.extendObjectAsync(path, objDef);
        } else {
            await this.setObjectNotExistsAsync(path, objDef);
        }

        this.knownObjects.add(path);
    }

    // Erkennt zustandsartige numerische Felder wie Charge_state/MPPT_State: kein Unit,
    // aber VRM liefert in item.value einen lesbaren Text zum Rohwert.
    looksLikeEnum(unit, val, item) {
        return (
            !unit &&
            typeof val === 'number' &&
            typeof item.value === 'string' &&
            item.value.trim() !== '' &&
            item.value.trim() !== String(val)
        );
    }

    async maybeUpdateEnumState(path, val, item) {
        if (typeof item.value !== 'string') {
            return;
        }
        const key = String(val);
        const states = this.enumStates[path];
        if (states[key] === undefined) {
            states[key] = item.value.trim();
            await this.extendObjectAsync(path, { common: { states } });
        }
    }

    // formatWithUnit sieht z.B. so aus: "%.1f V" oder "%d %%" - letztes Token als Einheit nehmen.
    parseUnit(formatWithUnit) {
        if (!formatWithUnit || typeof formatWithUnit !== 'string') {
            return '';
        }
        const parts = formatWithUnit.trim().split(/\s+/);
        if (parts.length < 2) {
            return '';
        }
        return parts[parts.length - 1].replace(/^%%$/, '%');
    }

    guessRole(unit, item) {
        if (unit === '%' && item.code && item.code.toUpperCase().includes('SOC')) {
            return 'value.battery';
        }
        return UNIT_ROLE_MAP[unit] || 'value';
    }

    cleanId(str) {
        return str.toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
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
