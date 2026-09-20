'use strict';

/**
 * Native HAP accessory transport for Powerwall telemetry and policy controls.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Features: cached HAP accessories, read-only meters, battery and fault reporting.
 */

class HapTransport {
  constructor(api) {
    this.api = api;
    this.hap = api.hap;
    this.cached = new Map();
    this.entries = new Map();
    // Internal descriptor types only; no Matter API or server is used.
    this.deviceTypes = { ElectricalSensor: 'meter', OnOffOutlet: 'outlet', ContactSensor: 'contact' };
    this.custom = {};
    for (const [key, name, unit, minimum] of [
      ['power', 'Power', 'W', -1000000000],
      ['imported', 'Imported Energy', 'kWh', 0],
      ['exported', 'Exported Energy', 'kWh', 0],
    ]) {
      const { Characteristic, uuid, Formats, Perms } = this.hap;
      const id = uuid.generate(`homebridge-powerwall-meters:hap:${key}`);
      this.custom[key] = class extends Characteristic {
        static UUID = id;
        constructor() {
          super(name, id, { format: Formats.FLOAT, unit,
            perms: [Perms.PAIRED_READ, Perms.NOTIFY],
            minValue: minimum, maxValue: 1000000000, minStep: 0.001 });
          this.value = this.getDefaultValue();
        }
      };
    }
  }

  restore(accessory) { this.cached.set(accessory.UUID, accessory); }

  unavailable() { return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE); }

  bind(entry, service, type, key) {
    if (!service.testCharacteristic(type)) service.addOptionalCharacteristic(type);
    const characteristic = service.getCharacteristic(type);
    entry.values.set(key, null);
    entry.characteristics.set(key, characteristic);
    characteristic.onGet(() => {
      const value = entry.values.get(key);
      if (!entry.reachable || value == null) throw this.unavailable();
      return value;
    });
    return characteristic;
  }

  async registerPlatformAccessories(plugin, platform, descriptors) {
    const { Service, Characteristic: C } = this.hap;
    const added = [], updated = [];
    for (const descriptor of descriptors) {
      const restored = this.cached.get(descriptor.UUID);
      const accessory = restored ?? new this.api.platformAccessory(descriptor.displayName, descriptor.UUID);
      accessory.displayName = descriptor.displayName;
      accessory.context = { ...accessory.context, ...descriptor.context };
      const info = accessory.getService(Service.AccessoryInformation);
      info.setCharacteristic(C.Name, descriptor.displayName)
        .setCharacteristic(C.Manufacturer, descriptor.manufacturer)
        .setCharacteristic(C.Model, descriptor.model)
        .setCharacteristic(C.SerialNumber, descriptor.serialNumber)
        .setCharacteristic(C.FirmwareRevision, require('../package.json').version);
      const services = new Set([info]);
      const use = (type, name, subtype) => {
        let service = subtype ? accessory.getServiceById(type, subtype) : accessory.getService(type);
        if (!service) service = accessory.addService(type, name, subtype);
        service.displayName = name;
        service.setCharacteristic(C.Name, name);
        if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
        service.setCharacteristic(C.ConfiguredName, name);
        services.add(service);
        return service;
      };
      const entry = { accessory, reachable: false, values: new Map(), characteristics: new Map(), services: [] };
      this.entries.set(descriptor.UUID, entry);
      const clusters = descriptor.clusters;
      let primary;
      if (clusters.booleanState) {
        primary = use(Service.ContactSensor, descriptor.displayName);
        this.bind(entry, primary, C.ContactSensorState, 'contact');
      } else if (clusters.onOff) {
        const metered = !!clusters.electricalPowerMeasurement;
        primary = use(metered ? Service.Outlet : Service.Switch, descriptor.displayName);
        const on = this.bind(entry, primary, C.On, 'on');
        on.onSet(async value => {
          if (!entry.reachable) throw this.unavailable();
          const handler = value ? descriptor.handlers?.onOff?.on : descriptor.handlers?.onOff?.off;
          if (!handler) throw new this.hap.HapStatusError(this.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
          if (metered) throw new this.hap.HapStatusError(this.hap.HAPStatus.READ_ONLY_CHARACTERISTIC);
          try { await handler(); } catch { throw this.unavailable(); }
          // Policy logic performs acknowledged writes and refreshes from the proxy.
        });
        if (metered) primary.setCharacteristic(C.OutletInUse, true);
      } else {
        const meterId = this.hap.uuid.generate('homebridge-powerwall-meters:hap:meter-service');
        primary = accessory.getServiceById(meterId, 'meter');
        if (!primary) primary = accessory.addService(new Service(descriptor.displayName, meterId, 'meter'));
        primary.setCharacteristic(C.Name, descriptor.displayName);
        services.add(primary);
      }
      primary.setPrimaryService(true);
      if (clusters.electricalPowerMeasurement) this.bind(entry, primary, this.custom.power, 'power');
      if (clusters.electricalEnergyMeasurement) {
        this.bind(entry, primary, this.custom.imported, 'imported');
        this.bind(entry, primary, this.custom.exported, 'exported');
      }
      if (clusters.powerSource) {
        const battery = use(Service.Battery, descriptor.displayName);
        this.bind(entry, battery, C.BatteryLevel, 'battery');
        this.bind(entry, battery, C.StatusLowBattery, 'low');
        this.bind(entry, battery, C.ChargingState, 'charging');
        primary.addLinkedService(battery);
      }
      for (const service of accessory.services.slice()) {
        if (!services.has(service)) accessory.removeService(service);
      }
      entry.services = [...services].filter(service => service !== info);
      for (const service of entry.services) {
        if (!service.testCharacteristic(C.StatusFault)) service.addOptionalCharacteristic(C.StatusFault);
        service.setCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT);
      }
      if (restored) updated.push(accessory); else added.push(accessory);
    }
    if (added.length) this.api.registerPlatformAccessories(plugin, platform, added);
    if (updated.length) this.api.updatePlatformAccessories(updated);
  }

  async unregisterPlatformAccessories(plugin, platform, accessories) {
    this.api.unregisterPlatformAccessories(plugin, platform, accessories);
    for (const accessory of accessories) {
      this.cached.delete(accessory.UUID);
      this.entries.delete(accessory.UUID);
    }
  }

  set(entry, key, value) {
    const characteristic = entry.characteristics.get(key);
    if (!characteristic) return;
    entry.values.set(key, value);
    characteristic.updateValue(value == null ? this.unavailable() : value);
  }

  async updateAccessoryState(id, group, state) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Unknown HAP accessory');
    const C = this.hap.Characteristic;
    // These groups are internal telemetry descriptors retained from v0.2.
    // All output is native HAP services/characteristics; there is no Matter registration.
    if (group === 'bridgedDeviceBasicInformation') {
      if (typeof state.reachable === 'boolean') {
        entry.reachable = state.reachable;
        for (const service of entry.services) service.updateCharacteristic(C.StatusFault,
          state.reachable ? C.StatusFault.NO_FAULT : C.StatusFault.GENERAL_FAULT);
        for (const [key, characteristic] of entry.characteristics) {
          const value = entry.values.get(key);
          characteristic.updateValue(state.reachable && value != null ? value : this.unavailable());
        }
      }
    } else if (group === 'onOff') this.set(entry, 'on', state.onOff);
    else if (group === 'booleanState') this.set(entry, 'contact', state.stateValue
      ? C.ContactSensorState.CONTACT_DETECTED : C.ContactSensorState.CONTACT_NOT_DETECTED);
    else if (group === 'electricalPowerMeasurement') this.set(entry, 'power',
      state.activePower == null ? null : state.activePower / 1000);
    else if (group === 'electricalEnergyMeasurement') {
      for (const [field, key] of [['cumulativeEnergyImported', 'imported'], ['cumulativeEnergyExported', 'exported']]) {
        this.set(entry, key, state[field]?.energy == null ? null : state[field].energy / 1000000);
      }
    } else if (group === 'powerSource') {
      this.set(entry, 'battery', state.batPercentRemaining == null ? null : Math.round(state.batPercentRemaining / 2));
      if (state.batChargeLevel !== undefined) this.set(entry, 'low', state.batChargeLevel
        ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
      this.set(entry, 'charging', state.batChargeState === 0 ? null : state.batChargeState === 1
        ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING);
    }
  }
}

module.exports = { HapTransport };
