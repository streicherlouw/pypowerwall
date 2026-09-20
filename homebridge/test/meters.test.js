'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { meterReading, energyReading, stateOfCharge } = require('../src/meters');

const now = Date.parse('2026-09-19T00:00:00Z');
const meter = power => ({ instant_power: power, last_communication_time: new Date(now).toISOString() });

test('raw signed meter watts become milliwatts without inferred flows', () => {
  const payload = { site: meter(-2626), battery: meter(-2280), solar: meter(5860), load: meter(946.25) };
  for (const [key, expected] of Object.entries({ site: -2626000, battery: -2280000, solar: 5860000, load: 946250 })) {
    assert.equal(meterReading(payload, key, now, 90000).activePower, expected);
  }
});
test('missing, stale, future, nonnumeric and nonfinite readings fail; zero remains valid', () => {
  for (const value of [undefined, null, '0', true, NaN, Infinity]) {
    assert.throws(() => meterReading({ site: meter(value) }, 'site', now, 90000));
  }
  assert.throws(() => meterReading(null, 'site', now, 90000));
  assert.throws(() => meterReading({ site: meter(1) }, 'site', now + 90001, 90000));
  assert.throws(() => meterReading({ site: meter(1) }, 'site', now - 60001, 90000));
  assert.throws(() => meterReading({ site: { instant_power: 1 } }, 'site', now, 90000));
  assert.equal(meterReading({ site: meter(0) }, 'site', now, 90000).activePower, 0);
});
test('native Wh counters retain orientation and missing energy is null', () => {
  assert.deepEqual(energyReading({ site: { energy_imported: 12.5, energy_exported: 4 } }, 'site'), {
    cumulativeEnergyImported: { energy: 12500 }, cumulativeEnergyExported: { energy: 4000 },
  });
  assert.deepEqual(energyReading({ battery: { energy_imported: -2, energy_exported: '0' } }, 'battery'), {
    cumulativeEnergyImported: null, cumulativeEnergyExported: null,
  });
});
test('SOC preserves already scaled value and rejects false zeroes', () => {
  assert.equal(stateOfCharge({ percentage: 50 }), 50);
  assert.equal(stateOfCharge({ percentage: 0 }), 0);
  for (const percentage of [null, undefined, -1, 101, '50', false]) {
    assert.throws(() => stateOfCharge({ percentage }));
  }
});
