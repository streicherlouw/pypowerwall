'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PowerwallMeters, validate } = require('../src');

function setup(options = {}, types = { ElectricalSensor: 'meter', OnOffOutlet: 'outlet', ContactSensor: 'contact' }) {
  const updates = [], registered = [], removed = [], events = {};
  const api = {
    hap: { uuid: { generate: seed => crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') } },
    on: (event, callback) => { events[event] = callback; },
    versionGreaterOrEqual: () => true,
    transport: {
      deviceTypes: types,
      registerPlatformAccessories: async (_, __, accessories) => registered.push(...accessories),
      unregisterPlatformAccessories: async (_, __, accessories) => removed.push(...accessories),
      updateAccessoryState: async (id, cluster, state) => updates.push({ id, cluster, state }),
    },
  };
  const config = { meterProfile: 'compact', thresholdSensors: false, siteId: 'test-site', proxyUrl: 'http://localhost', ...options };
  const p = new PowerwallMeters({ info() {}, warn() {}, error() {} }, config, api, api.transport);
  const aggregates = Object.fromEntries(['site', 'battery', 'load', 'solar'].map(key => [key, {
    instant_power: key === 'battery' ? -1000 : 2000, last_communication_time: new Date().toISOString(),
  }]));
  p.client.request = async path => path.includes('aggregates') ? aggregates : { percentage: 55.5 };
  p.tick = async () => {}; // Explicit cycles, no timers or real sockets in tests.
  return { p, api, updates, registered, removed, aggregates, events };
}

test('four raw meters, SOC and no enabled control writes by default', async () => {
  const { p, registered, updates } = setup();
  await p.start();
  assert.equal(registered.length, 5);
  assert.equal(registered.filter(a => a.deviceType === 'outlet').length, 1);
  assert.ok(registered.every(a => !a.clusters.electricalEnergyMeasurement));
  await p.poll();
  assert.ok(updates.some(u => u.cluster === 'powerSource' && u.state.batPercentRemaining === 111));
  assert.ok(updates.some(u => u.state.activePower === -1000000));
  for (const handler of Object.values(registered[0].handlers.onOff)) assert.throws(handler, /Read-only/);
});

test('missing channel is null/unreachable independently and subsequently recovers', async () => {
  const { p, aggregates, updates } = setup();
  await p.start();
  aggregates.solar.instant_power = null;
  await p.poll();
  const solar = [...p.accessories.values()].find(a => a.context.key.includes('solar'));
  assert.ok(updates.some(u => u.id === solar.UUID && u.state.activePower === null));
  assert.ok(updates.some(u => u.id === solar.UUID && u.state.reachable === false));
  assert.ok(updates.some(u => u.state.activePower === 2000000));
  aggregates.solar.instant_power = 7;
  await p.poll();
  assert.equal(p.faults.has(solar.context.key), false);
  assert.ok(updates.some(u => u.id === solar.UUID && u.state.activePower === 7000));
});

test('low battery opens contact; SOC failure is unavailable, not zero percent', async () => {
  const { p, aggregates, updates } = setup();
  await p.start();
  p.client.request = async path => path.includes('aggregates') ? aggregates : { percentage: 10 };
  await p.poll();
  assert.ok(updates.some(u => u.cluster === 'booleanState' && u.state.stateValue === false));
  assert.ok(updates.some(u => u.cluster === 'powerSource' && u.state.batChargeState === 1));
  updates.length = 0;
  p.client.request = async path => path.includes('aggregates') ? aggregates : { percentage: null };
  await p.poll();
  assert.ok(updates.some(u => u.cluster === 'powerSource' && u.state.batPercentRemaining === null));
  assert.ok(!updates.some(u => u.cluster === 'powerSource' && u.state.batPercentRemaining === 0));
  assert.ok(p.faults.has('battery-status'));
});

test('battery export is opt-in, preserves existing OFF policy and serializes writes', async () => {
  const { p, registered } = setup({ allowBatteryExportSwitch: true, controlAuthority: 'homebridge', exportOffPolicy: 'pv_only' });
  p.client.token = 'test';
  let policy = 'never';
  const writes = [];
  p.client.readControl = async () => policy;
  p.client.writeSetting = async (_, value) => { writes.push(value); policy = value; };
  await p.start();
  const handlers = registered.find(a => a.context.key === 'allow-export').handlers.onOff;
  await handlers.off();
  assert.deepEqual(writes, []);
  await Promise.all([handlers.on(), handlers.off(), handlers.toggle()]);
  assert.deepEqual(writes, ['battery_ok', 'pv_only', 'battery_ok']);
  p.client.writeSetting = async () => { throw new Error('rejected'); };
  await assert.rejects(handlers.off(), /rejected/);
});

test('restore uses stable UUIDs, removes deselected accessories and restores handlers', async () => {
  const old = setup();
  await old.p.start();
  const current = setup({ meters: ['load'], batteryStatus: false });
  for (const accessory of old.registered) current.p.configureAccessory(accessory);
  await current.p.start();
  assert.equal(current.registered[0].UUID, old.registered[0].UUID);
  assert.equal(current.removed.length, 4);
  assert.throws(current.registered[0].handlers.onOff.off, /Read-only/);
});

test('misconfiguration and unauthenticated controls fail explicitly', async () => {
  for (const config of [{ pollSeconds: 0 }, { meters: ['unknown'] }, { exportOffPolicy: 'battery_ok' },
    { allowBatteryExportSwitch: 'false' }]) {
    assert.throws(() => validate({ siteId: 'test', proxyUrl: 'http://localhost', ...config }));
  }
  const control = setup({ gridChargingSwitch: true });
  await assert.rejects(control.p.start(), /controlTokenEnv/);
});

test('enabling native energy replaces a cached endpoint to rebuild its features', async () => {
  const old = setup({ meters: ['site'], batteryStatus: false });
  await old.p.start();
  const next = setup({ meters: ['site'], batteryStatus: false, nativeEnergyMeters: ['site'] });
  next.p.configureAccessory(old.registered[0]);
  await next.p.start();
  assert.notEqual(next.registered[0].UUID, old.registered[0].UUID);
  assert.equal(next.removed.length, 1);
  assert.deepEqual(next.registered[0].clusters.electricalEnergyMeasurement,
    { cumulativeEnergyImported: null, cumulativeEnergyExported: null });
});

test('Accessory identity fields fit protocol limits with real UUID format and multibyte names', async () => {
  const { p, registered } = setup({ name: '🔋'.repeat(20) });
  await p.start();
  for (const a of registered) {
    assert.equal(a.UUID.length, 36);
    assert.equal(a.serialNumber.length, 32);
    assert.ok(Buffer.byteLength(a.displayName, 'utf8') <= 32);
    assert.ok(!a.displayName.includes('\uFFFD'));
  }
});

test('all 22 strict thresholds, hysteresis and unreachable recovery', async () => {
  const { p, updates, aggregates, registered } = setup({ thresholdSensors: true, batteryStatus: false, meters: [] });
  let percentage = 50;
  p.client.request = async path => path.includes('aggregates') ? aggregates : { percentage };
  await p.start();
  assert.equal(registered.length, 22);
  assert.equal(p.accessories.get('soc-above-0').displayName, 'Above 0 Percent Battery');
  assert.equal(p.accessories.get('soc-below-0').displayName, 'Below 1 Percent Battery');
  assert.equal(p.accessories.get('soc-above-100').displayName, 'Above 99 Percent Battery');
  assert.equal(new Set(registered.map(a => a.displayName.replace(/[^a-z0-9 ]/gi, ''))).size, 22);
  assert.ok(registered.every(a => /^(Above|Below) \d+ Percent Battery$/.test(a.displayName)));
  const active = key => updates.filter(u => u.id === p.accessories.get(key).UUID && u.cluster === 'booleanState').at(-1)?.state.stateValue === false;
  await p.poll();
  assert.equal(active('soc-above-50'), false);
  assert.equal(active('soc-below-50'), false);
  assert.equal(active('soc-above-0'), true);
  assert.equal(active('soc-below-100'), true);
  percentage = 51; await p.poll(); assert.equal(active('soc-above-50'), true);
  percentage = 49; await p.poll(); assert.equal(active('soc-above-50'), true);
  percentage = 48; await p.poll(); assert.equal(active('soc-above-50'), false);
  percentage = null; await p.poll(); assert.equal(p.faults.size, 22);
  percentage = 0; await p.poll();
  assert.equal(p.faults.size, 0);
  assert.equal(active('soc-above-0'), false);
  assert.equal(active('soc-below-0'), true);
  percentage = 100; await p.poll();
  assert.equal(active('soc-below-100'), false);
  assert.equal(active('soc-above-100'), true);
  percentage = 0; await p.poll(); assert.equal(active('soc-above-0'), false);
  percentage = 1; await p.poll(); assert.equal(active('soc-above-0'), true);
  assert.equal(active('soc-below-0'), true); // Clearing hysteresis retains the empty contact.
  percentage = 3; await p.poll(); assert.equal(active('soc-below-0'), false);
  percentage = 1; await p.poll(); assert.equal(active('soc-below-0'), false);
  percentage = 0; await p.poll(); assert.equal(active('soc-below-0'), true);
  percentage = 2; await p.poll(); assert.equal(active('soc-above-0'), true);
  percentage = 0; await p.poll();
  percentage = 99; await p.poll(); assert.equal(active('soc-above-100'), false);
  percentage = 100; await p.poll(); assert.equal(active('soc-above-100'), true);
});

test('every threshold treats equality strictly on first observation and clears at endpoints', () => {
  const { thresholdActive } = require('../src');
  for (let value = 0; value <= 100; value += 10) {
    for (const direction of ['above', 'below']) {
      assert.equal(thresholdActive(value, value, direction, false, 2), false);
      assert.equal(thresholdActive(direction === 'above' ? 0 : 100, value, direction, true, 2), false);
    }
  }
});

test('directional profile splits signs without raw duplicates or fabricated counters', async () => {
  const { p, registered, updates, aggregates } = setup({ meterProfile: 'directional', batteryStatus: false, nativeEnergyMeters: ['site'] });
  await p.start(); assert.equal(registered.length, 6);
  aggregates.site.instant_power = -123;
  await p.poll();
  const power = key => updates.filter(u => u.id === p.accessories.get(key).UUID && u.cluster === 'electricalPowerMeasurement').at(-1).state.activePower;
  assert.equal(power('grid-import-sensor'), 0);
  assert.equal(power('grid-export-sensor'), 123000);
  assert.equal(power('battery-charge-sensor'), 1000000);
  assert.equal(power('battery-discharge-sensor'), 0);
  assert.ok(registered.every(a => !a.clusters.electricalEnergyMeasurement));
  aggregates.site.instant_power = null;
  await p.poll();
  assert.equal(power('grid-export-sensor'), null);
  assert.ok(p.faults.has('grid-import-sensor'));
});

test('choice controls confirm state, reject deselection, honor authority and never write on polling', async () => {
  const { p, registered, updates } = setup({ energyExportSwitches: true, operationalModeSwitches: true,
    backupReservePresets: [0, 20, 100], scheduledBackupSwitch: true, advancedGridControls: true, controlAuthority: 'homebridge' });
  p.client.token = 'test';
  const state = { supported: true, controls_enabled: true, grid_export: 'pv_only', mode: 'self_consumption', reserve: 20, manual_backup: false };
  const writes = [];
  p.client.readState = async () => state;
  p.client.writeSetting = async (action, value) => { writes.push([action, value]); state[action] = action === 'manual_backup' ? value !== false : value; };
  await p.start(); await p.poll(); assert.deepEqual(writes, []);
  const handlers = key => registered.find(a => a.context.key === key).handlers.onOff;
  await assert.rejects(handlers('export-solar').off(), /Select another/);
  await handlers('export-everything').on();
  assert.deepEqual(writes, [['grid_export', 'battery_ok']]);
  await p.poll();
  const solar = p.accessories.get('export-solar');
  assert.equal(updates.filter(u => u.id === solar.UUID && u.cluster === 'onOff').at(-1).state.onOff, false);
  await handlers('reserve-0').on(); assert.equal(state.reserve, 0);
  await handlers('scheduled-backup').on(); await handlers('scheduled-backup').off();
  assert.deepEqual(writes.slice(-2), [['manual_backup', 7200], ['manual_backup', false]]);
  await handlers('go-off-grid').off(); assert.equal(writes.length, 4);
  p.config.controlAuthority = 'external';
  await assert.rejects(handlers('go-off-grid').on(), /disabled in plugin configuration/);
  state.mode = null; await p.poll(); assert.ok(p.faults.has('mode-self'));
  clearTimeout(p.refreshTimer);
});

test('commands do not wait for a poll holding a pending telemetry state update', async () => {
  const { p } = setup({ energyExportSwitches: true, controlAuthority: 'homebridge' });
  p.client.token = 'test';
  p.client.readState = async () => ({ supported: true, controls_enabled: true, grid_export: 'pv_only' });
  p.client.writeSetting = async () => {};
  await p.start();
  let release;
  const polling = p.serialize(() => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  await p.setChoice('export-everything', true);
  release(); await polling;
  clearTimeout(p.refreshTimer);
  p.config.externallyManagedControls = ['grid_export'];
  await p.setChoice('export-everything', true); // Legacy conflict settings no longer block manual control.
  clearTimeout(p.refreshTimer);
});

test('reserve contact scales independently; unknown grid state is not a false outage', async () => {
  const { p, updates } = setup({ belowReserveSensor: true, gridStatusSensor: true });
  p.client.readState = async () => ({ reserve: 60, grid_status: 'UP' });
  await p.start(); await p.poll();
  const contact = key => updates.filter(u => u.id === p.accessories.get(key).UUID && u.cluster === 'booleanState').at(-1).state.stateValue;
  assert.equal(contact('below-reserve'), false);
  assert.equal(contact('grid-disconnected'), true);
  p.client.readState = async () => ({ reserve: null, grid_status: null });
  await p.poll();
  assert.ok(p.faults.has('below-reserve'));
  assert.ok(p.faults.has('grid-disconnected'));
});


test('default home consumption excludes overlapping meter clusters even with legacy selections', async () => {
  const { p, registered, updates } = setup({ meterProfile: undefined, thresholdSensors: true,
    meters: ['load', 'solar', 'site', 'battery'], outletMeters: ['load', 'solar', 'site', 'battery'],
    nativeEnergyMeters: ['solar', 'site', 'battery'] });
  await p.start();
  assert.equal(registered.length, 24);
  assert.deepEqual(registered.filter(a => a.clusters.electricalPowerMeasurement).map(a => a.context.key), ['meter-load-outlet']);
  assert.equal(registered.filter(a => a.clusters.electricalEnergyMeasurement).length, 0);
  await p.poll();
  assert.ok(updates.some(u => u.cluster === 'powerSource' && u.state.batChargeState === 1));
  assert.equal(p.faults.size, 0);
});


test('home consumption stays on at startup, zero power and unavailable readings', async () => {
  const { p, aggregates, updates } = setup({ meters: ['load'], batteryStatus: false });
  await p.start();
  const id = p.accessories.get(p.meterKey('load')).UUID;
  const on = () => updates.filter(u => u.id === id && u.cluster === 'onOff').at(-1)?.state.onOff;
  assert.equal(on(), true);
  for (const power of [0, 500, null]) {
    updates.length = 0;
    aggregates.load.instant_power = power;
    await p.poll();
    assert.equal(on(), true);
    assert.ok(updates.some(u => u.id === id && u.state.activePower === (power === null ? null : power * 1000)));
  }
  assert.equal(p.faults.has(p.meterKey('load')), true);
});
