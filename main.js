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
        // Menge der aktuell aktiven Alarm-Basispfade (aus dem letzten Poll), damit wir
        // beendete Alarme beim nächsten Poll gezielt auf false zurücksetzen können.
        this.activeAlarmBases = new Set();

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
        this.pollTimer = this.setInterval(() => this.poll(), intervalSec * 1000);
    }

    async poll() {
        await this.pollDiagnostics();
        await this.pollAlarmLog();
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

    // Alarm-Log-Endpoint - empirisch bestätigt (nicht offiziell dokumentiert), liefert die
    // tatsächliche Historie inkl. isActive-Flag (im Gegensatz zum /alarms-Endpoint, der nur
    // die konfigurierten Schwellwerte liefert).
    async pollAlarmLog() {
        const url = `https://vrmapi.victronenergy.com/v2/installations/${this.config.installationId}/alarm-log`;

        try {
            const response = await axios.get(url, {
                headers: { 'X-Authorization': `Token ${this.config.vrmToken}` },
                timeout: 15000
            });

            const records = response.data && response.data.records;
            if (!Array.isArray(records)) {
                this.log.warn('VRM-Alarm-Log: unerwartetes Antwortformat - Rohantwort: ' + JSON.stringify(response.data).slice(0, 500));
                return;
            }

            await this.processAlarmLog(records);
        } catch (err) {
            if (err.response) {
                this.log.error(`VRM Alarm-Log API Fehler ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 300)}`);
            } else {
                this.log.error(`VRM Alarm-Log API Fehler: ${err.message}`);
            }
        }
    }

    async processAlarmLog(records) {
        const currentActiveBases = new Set();

        for (const record of records) {
            if (!record.isActive) {
                continue;
            }

            const base = this.alarmPathFor(record);
            currentActiveBases.add(base);

            await this.ensureSimpleState(`${base}.Active`, 'boolean', 'indicator.alarm', true);
            await this.ensureSimpleState(`${base}.Description`, 'string', 'value', record.description || '');
            if (record.started) {
                await this.ensureSimpleState(`${base}.Since`, 'number', 'value.time', record.started * 1000);
            }
        }

        // Alarme, die beim letzten Poll noch aktiv waren, jetzt aber nicht mehr auftauchen -> löschen/false setzen.
        for (const base of this.activeAlarmBases) {
            if (!currentActiveBases.has(base)) {
                await this.ensureSimpleState(`${base}.Active`, 'boolean', 'indicator.alarm', false);
            }
        }

        this.activeAlarmBases = currentActiveBases;
    }

    // Eigener, vom Diagnostics-Baum unabhängiger Zweig: Alarms.<Gerät>.<Name|Instanz>
    // bzw. Alarms.<Typ>.<idAlarm> für Alarme ohne Gerätebezug (z.B. Geofence).
    alarmPathFor(record) {
        if (record.device) {
            const deviceFolder = this.cleanId(record.device);
            const sub = record.customName
                ? this.cleanId(record.customName)
                : record.instance !== null && record.instance !== undefined
                    ? `Instanz_${record.instance}`
                    : 'Allgemein';
            return `Alarms.${deviceFolder}.${sub}`;
        }
        return `Alarms.${this.cleanId(record.type || 'Sonstige')}.${this.cleanId(record.idAlarm)}`;
    }

    async ensureSimpleState(path, type, role, value) {
        if (!this.knownObjects.has(path)) {
            await this.setObjectNotExistsAsync(path, {
                type: 'state',
                common: { name: path.split('.').pop(), type, role, read: true, write: false },
                native: {}
            });
            this.knownObjects.add(path);
        }
        await this.setStateAsync(path, value, true);
    }

    async processRecords(records) {
        const deviceInstances = {};

        // Durchgang 1: welche Devices haben mehrere Instanzen? Custom-Names einsammeln.
        for (const item of records) {
            const deviceFolder = this.resolveDeviceFolder(item);
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

        // Durchgang 2: Objekte anlegen/aktualisieren, Werte schreiben, Attribut-Lookup füllen.
        for (const item of records) {
            const val = item.rawValue !== undefined && item.rawValue !== null ? item.rawValue : item.formattedValue;
            if (val === undefined || val === null) {
                continue;
            }

            const deviceFolder = this.resolveDeviceFolder(item);
            const instanceNum = item.instance !== undefined ? item.instance : 0;
            const stateName = this.cleanId(item.description || item.code || 'Wert');

            let groupPath = deviceFolder;
            if (deviceInstances[deviceFolder].size > 1) {
                const nameKey = `${deviceFolder}_${instanceNum}`;
                groupPath += `.${this.customNames[nameKey] || `Instanz_${instanceNum}`}`;
            }
            const path = `${groupPath}.${stateName}`;

            await this.ensureObject(path, item, val);
            await this.setStateAsync(path, val, true);
        }
    }

    // GPS läuft bei Victron intern als eigener Dienst (com.victronenergy.gps), auch wenn
    // VRM ihn in der Anzeige oft unter "Gateway" mit gruppiert. Wir erkennen das über
    // dbusServiceType statt über das (unzuverlässigere) Device-Label, und lösen GPS-Punkte
    // in einen eigenen Zweig heraus. Ohne angeschlossenes GPS tauchen einfach keine
    // passenden Einträge auf - der GPS-Zweig entsteht dann gar nicht erst.
    resolveDeviceFolder(item) {
        if (item.dbusServiceType && item.dbusServiceType.toLowerCase().includes('gps')) {
            return 'GPS';
        }
        return this.cleanId(item.Device || 'System');
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
                states[key] = item.formattedValue.toString().trim();
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
            try {
                await this.extendObjectAsync(path, objDef);
            } catch (err) {
                this.log.error(`Konnte Objekt nicht erweitern (${path}): ${err.message} - objDef: ${JSON.stringify(objDef)}`);
                return;
            }
        } else {
            try {
                await this.setObjectNotExistsAsync(path, objDef);
            } catch (err) {
                this.log.error(`Konnte Objekt nicht anlegen (${path}): ${err.message} - objDef: ${JSON.stringify(objDef)}`);
                return;
            }
        }

        this.knownObjects.add(path);
    }

    // Erkennt zustandsartige numerische Felder wie Charge_state/MPPT_State: kein Unit,
    // aber VRM liefert in item.formattedValue einen lesbaren Text zum Rohwert.
    looksLikeEnum(unit, val, item) {
        return (
            !unit &&
            typeof val === 'number' &&
            typeof item.formattedValue === 'string' &&
            item.formattedValue.trim() !== '' &&
            item.formattedValue.trim() !== String(val)
        );
    }

    async maybeUpdateEnumState(path, val, item) {
        if (typeof item.formattedValue !== 'string') {
            return;
        }
        const key = String(val);
        const states = this.enumStates[path];
        if (states[key] === undefined) {
            states[key] = item.formattedValue.trim();
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
                this.clearInterval(this.pollTimer);
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
