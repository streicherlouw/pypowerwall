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

test('one Matter group exposes native load at root and routes child battery and contacts', async () => {
  const { p, groups, updates, setSoc } = await setup();
  await p.start(); await p.poll();
  assert.equal(groups.length, 1);
  const group = groups[0];
  assert.equal(group.parts.length, 23);
  assert.ok(group.clusters.electricalPowerMeasurement);
  assert.equal(group.parts.filter(p => p.clusters.electricalPowerMeasurement).length, 0);
  assert.equal(new Set(group.parts.map(p => p.id)).size, 23);
  assert.ok(updates.some(u => u.id === group.UUID && !u.partId && u.state.activePower === 500000));
  assert.ok(updates.some(u => u.partId === 'battery-status' && u.state.batPercentRemaining === 110));
  assert.ok(updates.some(u => u.partId === 'soc-above-50' && u.state.stateValue === false));
  assert.equal(updates.filter(u => u.state.reachable !== undefined).at(-1).state.reachable, true);
  setSoc(null); await p.poll();
  assert.equal(updates.filter(u => u.state.reachable !== undefined).at(-1).state.reachable, false);
  setSoc(0); await p.poll();
  assert.equal(updates.filter(u => u.state.reachable !== undefined).at(-1).state.reachable, true);
  assert.ok(updates.some(u => u.partId === 'soc-below-0' && u.state.stateValue === false));
  assert.ok(updates.every(u => u.cluster !== 'bridgedDeviceBasicInformation' || !u.partId));
  const { AccessoryManager } = await import('../node_modules/homebridge/dist/matter/server/AccessoryManager.js');
  const manager = new AccessoryManager();
  const prepared = await manager.prepareDeviceType(group);
  assert.ok(prepared.deviceType.behaviors.electricalPowerMeasurement);
  for (const part of group.parts) {
    const result = await manager.prepareDeviceType(manager.partAsAccessory(part, `${group.UUID}-part-${part.id}`));
    assert.ok(result.deviceType.behaviors.booleanState);
    if (part.id === 'battery-status') assert.ok(result.deviceType.behaviors.powerSource);
  }
});

test('Matter restore preserves group ID, adds stable parts and retires HAP without clearing new routes', async () => {
  const first = await setup({ thresholdValues: [50] }); await first.p.start();
  const next = await setup({ thresholdValues: [10,50] });
  next.p.configureMatterAccessory(first.groups[0]);
  next.p.configureMatterAccessory({ UUID: 'old-matter' });
  next.p.configureAccessory({ UUID: 'old-hap' });
  await next.p.start(); await next.p.poll();
  assert.equal(next.groups[0].UUID, first.groups[0].UUID);
  assert.deepEqual(next.groups[0].parts.slice(0,3).map(p => p.id), first.groups[0].parts.map(p => p.id));
  assert.deepEqual(next.removed.map(a => a.UUID), ['old-matter']);
  assert.deepEqual(next.hapRemoved.map(a => a.UUID), ['old-hap']);
  assert.ok(next.updates.some(u => u.partId === 'soc-above-10'));
});

test('grouped Matter controls preserve confirmed control handlers and read-only load', async () => {
  process.env.MATTER_TEST_TOKEN = 'test';
  const { p, groups } = await setup({ controlTokenEnv: 'MATTER_TEST_TOKEN', controlAuthority: 'homebridge',
    operationalModeSwitches: true });
  delete process.env.MATTER_TEST_TOKEN;
  let mode = 'self_consumption'; const writes = [];
  p.client.readState = async () => ({ supported: true, controls_enabled: true, mode });
  p.client.writeSetting = async (action, value) => { writes.push([action, value]); mode = value; };
  await p.start(); await p.poll();
  assert.throws(groups[0].handlers.onOff.off, /Read-only/);
  const part = groups[0].parts.find(p => p.id === 'mode-savings');
  await part.handlers.onOff.on();
  assert.deepEqual(writes, [['mode', 'autonomous']]);
  clearTimeout(p.refreshTimer);
});
