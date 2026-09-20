'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerwallMeters } = require('../src');

async function setup(options = {}) {
  const hap = await import('@homebridge/hap-nodejs');
  const { PlatformAccessory } = await import('../node_modules/homebridge/dist/platformAccessory.js');
  const added = [], removed = [], updated = [];
  const api = { hap, platformAccessory: PlatformAccessory, on() {},
    registerPlatformAccessories: (plugin, platform, list) => {
      for (const a of list) { a._associatedPlugin = plugin; a._associatedPlatform = platform; }
      added.push(...list);
    },
    unregisterPlatformAccessories: (_, __, list) => removed.push(...list),
    updatePlatformAccessories: list => updated.push(...list),
  };
  Object.defineProperty(api, 'matter', { get() { throw new Error('HAP must not access Matter'); } });
  const config = { siteId: 'hap-test', proxyUrl: 'http://localhost', ...options };
  const p = new PowerwallMeters({ info() {}, warn() {}, error() {} }, config, api);
  p.tick = async () => {};
  const readings = { load: { instant_power: 1234.5, last_communication_time: new Date().toISOString() },
    battery: { instant_power: -500, last_communication_time: new Date().toISOString() } };
  let soc = 55.5;
  p.client.request = async path => path.includes('aggregates') ? readings : { percentage: soc };
  return { p, api, added, removed, updated, readings, setSoc: value => { soc = value; } };
}

test('real HAP services publish power, battery and threshold values without Matter', async () => {
  const { p, api, added, readings, setSoc } = await setup();
  const C = api.hap.Characteristic, S = api.hap.Service;
  await p.start(); await p.poll();
  assert.equal(added.length, 24);
  const find = key => added.find(a => a.context.key === key);
  const outlet = find(p.meterKey('load')).getService(S.Outlet);
  assert.equal(await outlet.getCharacteristic(C.On).handleGetRequest(), true);
  assert.equal(await outlet.getCharacteristic(p.transport.custom.power).handleGetRequest(), 1234.5);
  await assert.rejects(outlet.getCharacteristic(C.On).handleSetRequest(false));
  const battery = find('battery-status').getService(S.Battery);
  assert.equal(await battery.getCharacteristic(C.BatteryLevel).handleGetRequest(), 56);
  assert.equal(await battery.getCharacteristic(C.ChargingState).handleGetRequest(), C.ChargingState.CHARGING);
  setSoc(0); await p.poll();
  assert.equal(await find('soc-below-0').getService(S.ContactSensor).getCharacteristic(C.ContactSensorState).handleGetRequest(), 1);
  assert.equal(await battery.getCharacteristic(C.StatusLowBattery).handleGetRequest(), 1);
  readings.load.instant_power = null; await p.poll();
  await assert.rejects(outlet.getCharacteristic(p.transport.custom.power).handleGetRequest());
  assert.equal(outlet.getCharacteristic(C.StatusFault).value, 1);
  readings.load.instant_power = 0; await p.poll();
  assert.equal(await outlet.getCharacteristic(p.transport.custom.power).handleGetRequest(), 0);
  assert.equal(await outlet.getCharacteristic(C.On).handleGetRequest(), true);
  setSoc(null); await p.poll();
  await assert.rejects(battery.getCharacteristic(C.BatteryLevel).handleGetRequest());
});

test('HAP cache restore updates labels and services without duplicating accessories', async () => {
  const first = await setup(); await first.p.start();
  const next = await setup({ thresholdSensors: false });
  for (const accessory of first.added) next.p.configureAccessory(accessory);
  first.added.find(a => a.context.key === 'battery-status').displayName = 'Old Battery';
  await next.p.start(); await next.p.poll();
  assert.equal(next.added.length, 0);
  assert.equal(next.updated.length, 2);
  assert.equal(next.removed.length, 22);
  assert.equal(next.updated.find(a => a.context.key === 'battery-status').displayName, 'Low Battery Warning');
  const outlet = next.updated.find(a => a.context.key.startsWith('meter-load'));
  assert.equal(outlet.services.filter(s => s.UUID === next.api.hap.Service.Outlet.UUID).length, 1);
  // Every service/characteristic must serialize using the actual HAP implementation.
  for (const accessory of next.updated) assert.ok(next.api.platformAccessory.serialize(accessory));
});

test('HAP control switches acknowledge writes and reject failed writes', async () => {
  process.env.HAP_TEST_TOKEN = 'test';
  const { p, api, added } = await setup({ thresholdSensors: false, operationalModeSwitches: true,
    controlTokenEnv: 'HAP_TEST_TOKEN', controlAuthority: 'homebridge' });
  delete process.env.HAP_TEST_TOKEN;
  let mode = 'self_consumption';
  p.client.readState = async () => ({ supported: true, controls_enabled: true, mode });
  const writes = [];
  p.client.writeSetting = async (action, value) => { writes.push([action, value]); mode = value; };
  await p.start(); await p.poll();
  const on = added.find(a => a.context.key === 'mode-savings').getService(api.hap.Service.Switch).getCharacteristic(api.hap.Characteristic.On);
  await on.handleSetRequest(true); await p.poll();
  assert.deepEqual(writes, [['mode', 'autonomous']]);
  assert.equal(await on.handleGetRequest(), true);
  mode = 'self_consumption'; await p.poll();
  p.client.writeSetting = async () => { throw new Error('Rejected'); };
  await assert.rejects(on.handleSetRequest(true));
  clearTimeout(p.refreshTimer);
});
