const assert = require('assert');
const { VictronVrm } = require('../main.js');

const adapter = Object.create(VictronVrm.prototype);

assert.strictEqual(adapter.parseUnit('%.1f V'), 'V');
assert.strictEqual(adapter.parseUnit('V'), 'V');
assert.strictEqual(adapter.parseUnit('°C'), '°C');
assert.strictEqual(adapter.parseUnit('%d %%'), '%');
assert.strictEqual(adapter.cleanId('My Device / Battery'), 'My_Device___Battery');

console.log('unit parsing tests passed');
