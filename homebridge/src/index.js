'use strict';

/**
 * Powerwall meter and policy platform for Homebridge Matter.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Features: raw meter reporting, battery status, opt-in policy controls.
 */

const { MatterTransport } = require('./matter');
const { ProxyClient } = require('./client');
const { CHANNELS, LABELS, finite, meterReading, energyReading, stateOfCharge } = require('./meters');
const PLUGIN = 'homebridge-powerwall-meters';
const PLATFORM = 'PowerwallMeters';
const DIRECTIONS = { site: [['grid-import', 'Grid Import', 1], ['grid-export', 'Grid Export', -1]],
  battery: [['battery-charge', 'Battery Charging', -1], ['battery-discharge', 'Battery Discharging', 1]] };

// Strict above/below comparisons. Hysteresis affects clearing only. Clamp reset
// boundaries so Above 0 and Below 100 can always clear at the physical endpoints.
function thresholdActive(soc, value, direction, previous, hysteresis) {
  if (direction === 'above') return previous ? soc > Math.max(0, value - hysteresis) : soc > value;
  return previous ? soc < Math.min(100, value + hysteresis) : soc < value;
}


function accessoryLabel(value) {
  let label = '';
  for (const character of value) {
    if (Buffer.byteLength(label + character, 'utf8') > 32) break;
    label += character;
  }
  return label;
}

function validate(config) {
  if (!config.siteId || typeof config.siteId !== 'string') throw new Error('A stable siteId is required');
  if (typeof config.proxyUrl !== 'string') throw new Error('proxyUrl is required');
  for (const name of ['batteryStatus', 'allowBatteryExportSwitch', 'gridChargingSwitch', 'requireMeterTimestamp', 'thresholdSensors',
    'energyExportSwitches', 'noExportSwitch', 'operationalModeSwitches', 'advancedGridControls']) {
    if (config[name] !== undefined && typeof config[name] !== 'boolean') throw new Error(`Invalid ${name}`);
  }
  for (const [name, fallback, min, max] of [
    ['pollSeconds', 15, 5, 3600], ['timeoutSeconds', 10, 1, 120],
    ['aboveLimitPercent', 90, 0, 100], ['belowLimitPercent', 70, 0, 100],
    ['thresholdHysteresis', 2, 0, 10],
    ['staleSeconds', 90, 10, 86400], ['lowBatteryPercent', 20, 0, 100],
  ]) {
    const value = config[name] ?? fallback;
    if (!finite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  }
  for (const key of ['meters', 'outletMeters', 'nativeEnergyMeters']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) ||
        config[key].some(channel => !CHANNELS.includes(channel)))) throw new Error(`Invalid ${key}`);
  }
  if (config.meterProfile !== undefined && !['home-consumption', 'net-grid', 'compact', 'directional'].includes(config.meterProfile)) throw new Error('Invalid meterProfile');
  if (config.controlAuthority !== undefined && !['external', 'homebridge'].includes(config.controlAuthority)) throw new Error('Invalid controlAuthority');
  if (config.savingsLabel !== undefined && !['Savings', 'Time-Based Control'].includes(config.savingsLabel)) throw new Error('Invalid savingsLabel');
  for (const key of ['backupReservePresets']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some(v => !Number.isInteger(v) || v < 0 || v > 100))) throw new Error(`Invalid ${key}`);
  }
  if (config.exportOffPolicy !== undefined && !['pv_only', 'never'].includes(config.exportOffPolicy)) {
    throw new Error('exportOffPolicy must be pv_only or never');
  }
}

class PowerwallMeters {
  constructor(log, config, api, transport) {
    validate(config);
    this.log = log;
    this.config = config;
    this.api = api;
    this.transport = transport ?? new MatterTransport(api, config);
    this.client = new ProxyClient(config);
    this.cached = new Map();
    this.accessories = new Map();
    this.faults = new Set();
    this.queue = Promise.resolve();
    this.commandQueue = Promise.resolve();
    this.stopped = false;
    // Apple sums metered accessories without recognising overlapping boundaries.
    // The default profile must suppress extra endpoints, not just hide their tiles.
    this.profile = config.meterProfile ?? 'home-consumption';
    this.channels = this.profile === 'net-grid' ? ['load', 'solar', 'battery'] : this.profile === 'home-consumption' ? ['load'] : [...new Set(config.meters ?? CHANNELS)];
    this.outlets = new Set(this.profile === 'net-grid' ? this.channels : config.outletMeters ?? ['load']);
    // Net-grid publishes instantaneous power only; raw energy counter direction
    // must not be mistaken for the reversed solar/battery power convention.
    this.energy = new Set(this.profile === 'net-grid' ? [] : config.nativeEnergyMeters ?? []);
    this.thresholdStates = new Map();
    this.limits = { above: config.aboveLimitPercent ?? 90, below: config.belowLimitPercent ?? 70 };
    this.choices = [];
    this.pollMs = (config.pollSeconds ?? 15) * 1000;
    this.staleMs = (config.staleSeconds ?? 90) * 1000;
    api.on('didFinishLaunching', () => this.start().catch(error => log.error(`Powerwall Matter startup failed: ${error.message}`)));
    api.on('shutdown', () => { this.stopped = true; clearTimeout(this.timer); clearTimeout(this.refreshTimer); });
  }

  configureAccessory(accessory) { this.transport.restoreHap?.(accessory); }
  configureMatterAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
    this.transport.restore?.(accessory);
  }

  meterKey(channel) {
    // Homebridge restores an endpoint's feature set. Changing the energy
    // declaration needs a new endpoint, not just a metadata update.
    return `meter-${channel}-${this.outlets.has(channel) ? 'outlet' : 'sensor'}${this.energy.has(channel) ? '-energy' : ''}${this.profile === 'net-grid' && channel !== 'load' ? '-net-v2' : ''}`;
  }

  serialize(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  accessory(key, name, deviceType, clusters, handlers) {
    const UUID = this.api.hap.uuid.generate(`${PLUGIN}:${this.config.siteId}:${key}${key === 'battery-status' && this.profile === 'net-grid' ? '-warning-only' : ''}`);
    const accessory = {
      UUID, displayName: accessoryLabel(name || 'Battery'), deviceType,
      // Keep the existing stable compact serial number across protocol versions.
      manufacturer: 'pypowerwall', model: 'Powerwall proxy', serialNumber: UUID.replace(/-/g, ''),
      context: { key }, clusters, handlers,
    };
    this.accessories.set(key, accessory);
    return accessory;
  }

  async start() {
    const transport = this.transport;
    transport.validate?.();
    for (const channel of this.channels) {
      if (this.config.meterProfile === 'directional' && DIRECTIONS[channel]) {
        for (const [key, label] of DIRECTIONS[channel]) {
          const outlet = this.outlets.has(channel);
          const readOnly = () => { throw new Error('Read-only Powerwall meter'); };
          this.accessory(key + (outlet ? '-outlet' : '-sensor'), label,
            outlet ? transport.deviceTypes.OnOffOutlet : transport.deviceTypes.ElectricalSensor,
            { electricalPowerMeasurement: { activePower: null }, ...(outlet ? { onOff: { onOff: true } } : {}) },
            outlet ? { onOff: { on: readOnly, off: readOnly, toggle: readOnly } } : undefined);
        }
        continue;
      }
      const outlet = this.outlets.has(channel);
      const clusters = { electricalPowerMeasurement: { activePower: null } };
      if (this.energy.has(channel)) {
        clusters.electricalEnergyMeasurement = { cumulativeEnergyImported: null, cumulativeEnergyExported: null };
      }
      let handlers;
      if (outlet) {
        clusters.onOff = { onOff: true };
        // Outlet presentation is a UI compatibility option, never a household
        // disconnect. Reject every OnOff command, including Toggle.
        const readOnly = () => { throw new Error('Read-only Powerwall meter'); };
        handlers = { onOff: { on: readOnly, off: readOnly, toggle: readOnly } };
      }
      this.accessory(this.meterKey(channel), LABELS[channel],
        outlet ? transport.deviceTypes.OnOffOutlet : transport.deviceTypes.ElectricalSensor, clusters, handlers);
    }
    if (this.config.batteryStatus !== false) {
      this.accessory('battery-status', 'Low Battery Warning', transport.deviceTypes.ContactSensor, {
        booleanState: { stateValue: true },
        powerSource: { status: 1, order: 0, endpointList: [], batPercentRemaining: null,
          batChargeLevel: 0, batReplacementNeeded: false, batFunctionalWhileCharging: true,
          batChargeState: 0, batReplaceability: 0, batPresent: true, batQuantity: 1,
          description: 'Powerwall state of charge' },
      });
    }
    if (this.profile === 'net-grid' && this.accessories.has('battery-status')) {
      const warning = this.accessories.get('battery-status');
      this.accessories.get(this.meterKey('battery')).clusters.powerSource = warning.clusters.powerSource;
      delete warning.clusters.powerSource;
    }
    if (this.config.thresholdSensors !== false) {
      for (const direction of ['below', 'above']) {
        this.accessory(`soc-${direction}-limit`, `${direction === 'below' ? 'Below' : 'Above'} ${this.limits[direction]} Percent`,
          transport.deviceTypes.ContactSensor, { booleanState: { stateValue: true } });
      }
    }
    const choice = (key, label, action, value, momentary = false) => {
      if (!this.client.token) throw new Error('Enabled controls require controlTokenEnv or controlTokenFile');
      this.choices.push({ key, action, value, momentary });
      this.accessory(key, label, transport.deviceTypes.OnOffOutlet, { onOff: { onOff: false } }, {
        onOff: { on: () => this.setChoice(key, true), off: () => this.setChoice(key, false), toggle: () => this.setChoice(key) },
      });
    };
    if (this.config.energyExportSwitches) {
      choice('export-solar', 'Export Solar Only', 'grid_export', 'pv_only');
      choice('export-everything', 'Export Battery & Solar', 'grid_export', 'battery_ok');
      if (this.config.noExportSwitch) choice('export-never', 'Energy Exports No Export', 'grid_export', 'never');
    }
    if (this.config.operationalModeSwitches) {
      choice('mode-self', 'Self Powered Operating Mode', 'mode', 'self_consumption');
      choice('mode-savings', this.config.savingsLabel === 'Time-Based Control' ? 'Time-Based Control' : 'Savings Operating Mode', 'mode', 'autonomous');
    }
    for (const value of new Set(this.config.backupReservePresets ?? [])) {
      choice(`reserve-${value}`, `${value} Percent Backup`, 'reserve', value);
    }
    if (this.config.advancedGridControls) {
      choice('go-off-grid', 'Go Off-Grid', 'go_off_grid', true, true);
      choice('reconnect-grid', 'Reconnect to Grid', 'reconnect_grid', true, true);
    }
    for (const [enabled, key, label, action] of [
      [this.config.allowBatteryExportSwitch, 'allow-export', 'Allow battery export', 'grid_export'],
      [this.config.gridChargingSwitch, 'grid-charging', 'Grid Charging', 'grid_charging'],
    ]) {
      if (!enabled) continue;
      if (!this.client.token) throw new Error('Enabled controls require controlTokenEnv or controlTokenFile');
      this.accessory(key, label, transport.deviceTypes.OnOffOutlet, { onOff: { onOff: false } }, {
        onOff: {
          on: () => this.setControl(key, action, true),
          off: () => this.setControl(key, action, false),
          toggle: () => this.setControl(key, action, undefined),
        },
      });
    }
    const desired = [...this.accessories.values()];
    const ids = new Set(desired.map(accessory => accessory.UUID));
    const removed = [...this.cached.values()].filter(accessory => !ids.has(accessory.UUID));
    if (removed.length && !transport.managesAccessoryCache) await transport.unregisterPlatformAccessories(PLUGIN, PLATFORM, removed);
    if (desired.length) await transport.registerPlatformAccessories(PLUGIN, PLATFORM, desired);
    for (const [key, accessory] of this.accessories) {
      // Publish label changes without changing the stable accessory UUID.
      await this.update(key, 'bridgedDeviceBasicInformation', { nodeLabel: accessory.displayName });
      if (key === this.meterKey('load') && this.outlets.has('load')) {
        await this.update(key, 'onOff', { onOff: true });
      }
      await this.reachable(key, false);
    }
    if (this.profile !== 'net-grid' && (this.outlets.size > 1 || [...this.outlets].some(channel => channel !== 'load'))) {
      this.log.warn('Multiple/site/production meters may distort Apple Home energy totals; these are overlapping raw meters');
    }
    await this.tick();
  }

  async update(key, cluster, state) {
    const accessory = this.accessories.get(key);
    await this.transport.updateAccessoryState(accessory.UUID, cluster, state);
  }

  async reachable(key, reachable) {
    await this.update(key, 'bridgedDeviceBasicInformation', { reachable });
  }

  async attempt(key, task, failed) {
    try {
      await task();
      await this.reachable(key, true);
      if (this.faults.delete(key)) this.log.info(`${key}: data available again`);
    } catch {
      if (failed) await failed();
      await this.reachable(key, false);
      if (!this.faults.has(key)) this.log.warn(`${key}: unavailable; check proxy data and configuration`);
      this.faults.add(key);
    }
  }

  async poll() {
    // One aggregate snapshot per polling cycle. Fail channels independently:
    // a missing solar meter must not turn valid grid or battery readings to zero.
    let aggregates;
    try {
      if (this.channels.length || this.accessories.has('battery-status')) {
        aggregates = await this.client.request('/api/meters/aggregates');
      }
    }
    catch { aggregates = null; }
    for (const channel of this.channels) {
      if (this.config.meterProfile === 'directional' && DIRECTIONS[channel]) {
        for (const [id, , sign] of DIRECTIONS[channel]) {
          const key = id + (this.outlets.has(channel) ? '-outlet' : '-sensor');
          await this.attempt(key, async () => {
            const power = meterReading(aggregates, channel, Date.now(), this.staleMs, this.config.requireMeterTimestamp !== false);
            await this.update(key, 'electricalPowerMeasurement', { activePower: Math.max(0, sign * power.activePower) });
          }, () => this.update(key, 'electricalPowerMeasurement', { activePower: null }));
        }
        continue;
      }
      const key = this.meterKey(channel);
      // This outlet represents continuous monitoring, not a controllable load.
      if (this.outlets.has(channel) && (channel === 'load' || this.profile === 'net-grid')) await this.update(key, 'onOff', { onOff: true });
      await this.attempt(key, async () => {
        const power = meterReading(aggregates, channel, Date.now(), this.staleMs,
          this.config.requireMeterTimestamp !== false);
        if (this.profile === 'net-grid' && channel !== 'load') power.activePower = -power.activePower || 0;
        await this.update(key, 'electricalPowerMeasurement', power);
        if (this.energy.has(channel) && Date.now() - (this.lastEnergy?.[channel] ?? 0) >= 60000) {
          await this.update(key, 'electricalEnergyMeasurement', energyReading(aggregates, channel));
          this.lastEnergy ??= {};
          this.lastEnergy[channel] = Date.now();
        }
      }, async () => {
        await this.update(key, 'electricalPowerMeasurement', { activePower: null });
        if (this.energy.has(channel)) {
          await this.update(key, 'electricalEnergyMeasurement', {
            cumulativeEnergyImported: null, cumulativeEnergyExported: null,
          });
          if (this.lastEnergy) delete this.lastEnergy[channel];
        }
      });
    }
    if (this.profile === 'net-grid') {
      // Compare the same aggregate snapshot without publishing a fourth meter.
      // A missing measurement invalidates the comparison, never becomes zero.
      this.gridBalance = null;
      try {
        const read = channel => meterReading(aggregates, channel, Date.now(), this.staleMs,
          this.config.requireMeterTimestamp !== false).activePower / 1000;
        const inferredWatts = read('load') - read('solar') - read('battery');
        const measuredWatts = read('site');
        this.gridBalance = { inferredWatts, measuredWatts, differenceWatts: inferredWatts - measuredWatts };
        this.log.debug?.(`Grid balance: inferred ${inferredWatts.toFixed(1)} W; measured ${measuredWatts.toFixed(1)} W; difference ${this.gridBalance.differenceWatts.toFixed(1)} W`);
      } catch { /* Individual meter faults are reported independently above. */ }
    }
    let soc;
    if (this.config.batteryStatus !== false || this.config.thresholdSensors !== false) {
      try { soc = stateOfCharge(await this.client.request('/api/system_status/soe')); } catch { soc = undefined; }
    }
    if (this.accessories.has('battery-status')) {
      const batteryInfoKey = this.profile === 'net-grid' ? this.meterKey('battery') : 'battery-status';
      await this.attempt('battery-status', async () => {
        // This proxy route is already Tesla-app-scaled. Never scale it twice.
        if (!finite(soc)) throw new Error('Battery percentage unavailable');
        const low = soc <= (this.config.lowBatteryPercent ?? 20);
        let batChargeState = 0; // Unknown until a fresh battery meter is available.
        try {
          const power = meterReading(aggregates, 'battery', Date.now(), this.staleMs,
            this.config.requireMeterTimestamp !== false).activePower;
          batChargeState = power < -50000 ? 1 : (soc === 100 ? 2 : 3);
        } catch { /* A missing battery power meter does not invalidate a valid percentage. */ }
        await this.update(batteryInfoKey, 'powerSource', {
          batPercentRemaining: Math.round(soc * 2), batChargeLevel: low ? 1 : 0, batChargeState,
        });
        // Internal boolean semantics: false=open, true=closed. Matter reports false for open and true for closed.
        await this.update('battery-status', 'booleanState', { stateValue: !low });
      }, () => this.update(batteryInfoKey, 'powerSource', { batPercentRemaining: null, batChargeState: 0 }));
    }
    if (this.config.thresholdSensors !== false) {
      for (const direction of ['below', 'above']) {
        await this.updateThreshold(`soc-${direction}-limit`, soc, this.limits[direction], direction);
      }
    }
    let state;
    if (this.choices.length || this.config.gridChargingSwitch) {
      try { state = await this.client.readState(); } catch { state = {}; }
    }
    for (const item of this.choices) await this.attempt(item.key, async () => {
      if (!state?.supported || !state.controls_enabled || (!item.momentary && state[item.action] == null)) throw new Error('Control unavailable');
      await this.update(item.key, 'onOff', { onOff: item.momentary ? false : this.choiceOn(item, state) });
    });
    for (const [key, action] of [['allow-export', 'grid_export'], ['grid-charging', 'grid_charging']]) {
      if (!this.accessories.has(key)) continue;
      await this.attempt(key, async () => {
        const value = action === 'grid_charging' ? state?.grid_charging : await this.client.readControl(action);
        if (value == null) throw new Error('Unknown policy');
        await this.update(key, 'onOff', { onOff: action === 'grid_export' ? value === 'battery_ok' : value });
      });
    }
  }

  async updateThreshold(key, soc, value, direction) {
    await this.attempt(key, async () => {
      if (!finite(soc) || !finite(value)) throw new Error('Threshold data unavailable');
      const active = thresholdActive(soc, value, direction, this.thresholdStates.get(key), this.config.thresholdHysteresis ?? 2);
      this.thresholdStates.set(key, active);
      await this.update(key, 'booleanState', { stateValue: !active });
    }, async () => { this.thresholdStates.delete(key); });
  }

  choiceOn(item, state) {
    return item.action === 'reserve' ? Math.abs(state.reserve - item.value) < 0.01 : state[item.action] === item.value;
  }

  refreshSoon() {
    // Reconcile after the command response so HAP write completion cannot
    // overwrite a refreshed state (including momentary control switches).
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.serialize(() => this.stopped ? undefined : this.poll()).catch(() => {}), 250);
    this.refreshTimer.unref?.();
  }

  command(task) {
    // Serialize commands independently of telemetry so a slow poll cannot
    // block a control response. Reconcile telemetry again after each command.
    const next = this.commandQueue.then(task);
    this.commandQueue = next.catch(() => {});
    return next;
  }

  setChoice(key, desired) {
    return this.command(async () => {
      if (this.stopped) throw new Error('Plugin is stopping');
      if (this.config.controlAuthority !== 'homebridge') throw new Error('Control writes are disabled in plugin configuration');
      const item = this.choices.find(choice => choice.key === key);
      try {
        const state = await this.client.readState();
        if (!state.supported || !state.controls_enabled || (!item.momentary && state[item.action] == null)) throw new Error('Control unavailable');
        const current = item.momentary ? false : this.choiceOn(item, state);
        const on = desired ?? !current;
        if (!on && current) throw new Error('Select another option to change this setting');
        if (on !== current || (item.momentary && on)) {
          await this.client.writeSetting(item.action, on ? item.value : false, item.momentary);
        }
        await this.reachable(key, true);
      } catch (error) { await this.reachable(key, false); throw error; }
      finally { this.refreshSoon(); }
    });
  }

  setControl(key, action, desired) {
    return this.command(async () => {
      if (this.stopped) throw new Error('Plugin is stopping');
      if (this.config.controlAuthority !== 'homebridge') throw new Error('Control writes are disabled in plugin configuration');
      try {
        const current = action === 'grid_charging' ? (await this.client.readState()).grid_charging : await this.client.readControl(action);
        if (current == null) throw new Error('Unknown policy');
        const wasOn = action === 'grid_export' ? current === 'battery_ok' : current;
        const on = desired === undefined ? !wasOn : desired;
        // OFF while already OFF preserves 'never' vs 'pv_only'. When actually
        // disabling battery export, the configured OFF policy is explicit.
        if (on !== wasOn) {
          const value = action === 'grid_export' ? (on ? 'battery_ok' : this.config.exportOffPolicy ?? 'pv_only') : on;
          await this.client.writeSetting(action, value);
        }
        await this.reachable(key, true);
        // The Homebridge OnOff behavior commits the state after this handler
        // returns. Do not perform a nested update of its locked OnOff cluster.
      } catch (error) {
        await this.reachable(key, false);
        throw error;
      } finally { this.refreshSoon(); }
    });
  }

  async tick() {
    try { await this.serialize(() => this.stopped ? undefined : this.poll()); }
    catch { this.log.warn('Powerwall polling cycle failed'); }
    if (!this.stopped) {
      this.timer = setTimeout(() => this.tick(), this.pollMs);
      this.timer.unref?.();
    }
  }
}

module.exports = api => api.registerPlatform(PLUGIN, PLATFORM, PowerwallMeters);
module.exports.PowerwallMeters = PowerwallMeters;
module.exports.validate = validate;

module.exports.thresholdActive = thresholdActive;
