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
  assert.equal(added.length, 1);
  assert.equal(added[0].services.length, 26);
  const find = key => ({ getService: type => added[0].getServiceById(type, key) });
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
  first.added[0].displayName = 'Old Powerwall';
  await next.p.start(); await next.p.poll();
  assert.equal(next.added.length, 0);
  assert.equal(next.updated.length, 1);
  assert.equal(next.removed.length, 0);
  assert.equal(next.updated[0].services.length, 4);
  assert.equal(next.updated[0].displayName, 'Powerwall');
  assert.equal(next.updated[0].UUID, first.added[0].UUID);
  const outlet = next.updated[0];
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
  const on = added[0].getServiceById(api.hap.Service.Switch, 'mode-savings').getCharacteristic(api.hap.Characteristic.On);
  await on.handleSetRequest(true); await p.poll();
  assert.deepEqual(writes, [['mode', 'autonomous']]);
  assert.equal(await on.handleGetRequest(), true);
  mode = 'self_consumption'; await p.poll();
  p.client.writeSetting = async () => { throw new Error('Rejected'); };
  await assert.rejects(on.handleSetRequest(true));
  clearTimeout(p.refreshTimer);
});


test('grouping migrates separate accessories and keeps independent contact state and faults', async () => {
  const { p, api, added, removed, readings, setSoc } = await setup();
  for (const key of ['meter-load-outlet', 'soc-above-50']) {
    const old = new api.platformAccessory(key, api.hap.uuid.generate(`homebridge-powerwall-meters:hap-test:${key}`));
    old.context = { key };
    p.configureAccessory(old);
  }
  await p.start(); await p.poll();
  assert.equal(added.length, 1);
  assert.equal(removed.length, 2);
  const group = added[0], S = api.hap.Service, C = api.hap.Characteristic;
  assert.equal(group.services.filter(s => s.isPrimaryService).length, 1);
  assert.equal(group.getServiceById(S.Outlet, p.meterKey('load')).isPrimaryService, true);
  assert.equal(group.services.filter(s => s.UUID === S.ContactSensor.UUID).length, 23);
  const above = group.getServiceById(S.ContactSensor, 'soc-above-50').getCharacteristic(C.ContactSensorState);
  const below = group.getServiceById(S.ContactSensor, 'soc-below-50').getCharacteristic(C.ContactSensorState);
  assert.equal(await above.handleGetRequest(), 1);
  assert.equal(await below.handleGetRequest(), 0);
  readings.load.instant_power = null;
  setSoc(40); await p.poll();
  assert.equal(await above.handleGetRequest(), 0);
  assert.equal(await below.handleGetRequest(), 1);
  assert.equal(group.getServiceById(S.ContactSensor, 'soc-above-50').getCharacteristic(C.StatusFault).value, 0);
  assert.equal(new Set(group.services.map(s => s.getServiceId())).size, group.services.length);
});

test('Home generic onboarding names are repaired while custom names survive restore', async () => {
  const first = await setup(); await first.p.start();
  const C = first.api.hap.Characteristic, S = first.api.hap.Service;
  const group = first.added[0];
  const service = group.getServiceById(S.ContactSensor, 'soc-above-50');
  const name = service.getCharacteristic(C.ConfiguredName);
  await name.handleSetRequest('Contact Sensor 12');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(name.value, 'Above 50 Percent Battery');
  assert.equal(await name.handleGetRequest(), 'Above 50 Percent Battery');
  await name.handleSetRequest('Battery Half Full');
  await new Promise(resolve => setTimeout(resolve, 10));
  const restored = first.api.platformAccessory.deserialize(first.api.platformAccessory.serialize(group));
  const next = await setup(); next.p.configureAccessory(restored); await next.p.start();
  assert.equal(await next.updated[0].getServiceById(S.ContactSensor, 'soc-above-50')
    .getCharacteristic(C.ConfiguredName).handleGetRequest(), 'Battery Half Full');
});
