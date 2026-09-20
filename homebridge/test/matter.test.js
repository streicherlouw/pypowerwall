'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PowerwallMeters } = require('../src');

async function setup(options = {}) {
  const { deviceTypes } = await import('../node_modules/homebridge/dist/matter/types.js');
  const groups = [], updates = [], removed = [], hapRemoved = [];
  const api = { hap: { uuid: { generate: key => {
    const v = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
    return v.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  } } }, on() {}, versionGreaterOrEqual: () => true,
  unregisterPlatformAccessories: (_, __, list) => hapRemoved.push(...list),
  matter: { deviceTypes,
    registerPlatformAccessories: async (_, __, list) => groups.push(...list),
    unregisterPlatformAccessories: async (_, __, list) => removed.push(...list),
    updateAccessoryState: async (id, cluster, state, partId) => updates.push({ id, cluster, state, partId }),
  } };
  const p = new PowerwallMeters({ info() {}, warn() {}, error() {} },
    { siteId: 'group-test', proxyUrl: 'http://localhost', ...options }, api);
  p.tick = async () => {};
  let soc = 55;
  p.client.request = async path => path.includes('aggregates') ? {
    load: { instant_power: 500, last_communication_time: new Date().toISOString() },
    battery: { instant_power: -100, last_communication_time: new Date().toISOString() },
  } : { percentage: soc };
  return { p, api, groups, updates, removed, hapRemoved, setSoc: v => { soc = v; } };
}

test('separate Matter endpoints carry pairing names and native load only once', async () => {
  const { p, groups, updates, setSoc } = await setup();
  await p.start(); await p.poll();
  assert.equal(groups.length, 4);
  assert.ok(groups.every(a => !a.parts));
  assert.equal(groups.filter(a => a.clusters.electricalPowerMeasurement).length, 1);
  const above = groups.find(a => a.context.key === 'soc-above-limit');
  const below = groups.find(a => a.context.key === 'soc-below-limit');
  assert.equal(above.displayName, 'Above 90 Percent');
  assert.equal(below.displayName, 'Below 70 Percent');
  const { AccessoryManager } = await import('../node_modules/homebridge/dist/matter/server/AccessoryManager.js');
  const manager = new AccessoryManager();
  for (const accessory of [above, below]) {
    const options = manager.createEndpointOptions(accessory, { externalAccessory: false });
    assert.equal(options.bridgedDeviceBasicInformation.nodeLabel, accessory.displayName);
    const prepared = await manager.prepareDeviceType(accessory);
    assert.ok(prepared.deviceType.behaviors.booleanState);
  }
  assert.deepEqual(p.limits, { above: 90, below: 70 });
  setSoc(0); await p.poll();
  assert.ok(updates.some(u => u.id === below.UUID && u.state.stateValue === false));
  setSoc(100); await p.poll();
  assert.ok(updates.some(u => u.id === above.UUID && u.state.stateValue === false));
  setSoc(75); await p.poll();
  for (const accessory of [above, below]) {
    assert.equal(updates.filter(u => u.id === accessory.UUID && u.cluster === 'booleanState').at(-1).state.stateValue, true);
  }
  assert.ok(updates.every(u => u.partId === undefined));
});

test('migration retires composed group and old thresholds; limit changes preserve identity', async () => {
  const first = await setup(); await first.p.start();
  const next = await setup({ aboveLimitPercent: 80, belowLimitPercent: 20 });
  for (const a of first.groups) next.p.configureMatterAccessory(a);
  next.p.configureMatterAccessory({ UUID: 'old-group', parts: [] });
  next.p.configureMatterAccessory({ UUID: 'old-threshold' });
  next.p.configureAccessory({ UUID: 'old-hap' });
  await next.p.start(); await next.p.poll();
  assert.deepEqual(next.groups.map(a => a.UUID), first.groups.map(a => a.UUID));
  assert.deepEqual(next.removed.map(a => a.UUID), ['old-group', 'old-threshold']);
  assert.deepEqual(next.hapRemoved.map(a => a.UUID), ['old-hap']);
});

test('Matter controls preserve confirmed handlers and read-only load', async () => {
  process.env.MATTER_TEST_TOKEN = 'test';
  const { p, groups } = await setup({ controlTokenEnv: 'MATTER_TEST_TOKEN', controlAuthority: 'homebridge',
    operationalModeSwitches: true });
  delete process.env.MATTER_TEST_TOKEN;
  let mode = 'self_consumption'; const writes = [];
  p.client.readState = async () => ({ supported: true, controls_enabled: true, mode });
  p.client.writeSetting = async (action, value) => { writes.push([action, value]); mode = value; };
  await p.start(); await p.poll();
  assert.throws(groups.find(a => a.context.key === 'meter-load-outlet').handlers.onOff.off, /Read-only/);
  await groups.find(a => a.context.key === 'mode-savings').handlers.onOff.on();
  assert.deepEqual(writes, [['mode', 'autonomous']]);
  clearTimeout(p.refreshTimer);
});
