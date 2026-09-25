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
            return;
        }

        const unit = this.parseUnit(item.formatWithUnit);
        const type = typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string';
        const role = this.guessRole(unit, item);

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

        await this.setObjectNotExistsAsync(path, {
            type: 'state',
            common,
            native: {
                code: item.code || '',
                dbusServiceType: item.dbusServiceType || '',
                dbusPath: item.dbusPath || ''
            }
        });

        this.knownObjects.add(path);
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
