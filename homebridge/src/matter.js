'use strict';

/**
 * Individually named Matter accessories for Powerwall telemetry and controls.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Features: pairing-time NodeLabels, stable IDs, native power measurement.
 */
class MatterTransport {
  constructor(api, config) {
    this.api = api;
    this.config = config;
    this.managesAccessoryCache = true;
    this.cached = new Map();
    this.hapCached = new Map();
    this.ids = new Set();
  }

  get deviceTypes() { return this.api.matter?.deviceTypes; }
  validate() {
    if (!this.api.matter?.deviceTypes.ElectricalSensor || !this.api.versionGreaterOrEqual('2.4.0')) {
      throw new Error('Homebridge 2.4+ with Matter enabled is required');
    }
  }
  restore(accessory) { this.cached.set(accessory.UUID, accessory); }
  restoreHap(accessory) { this.hapCached.set(accessory.UUID, accessory); }

  async registerPlatformAccessories(plugin, platform, descriptors) {
    // Each bridged endpoint has its own NodeLabel at registration. Apple Home
    // ignores semantic labels on composed children during pairing.
    await this.api.matter.registerPlatformAccessories(plugin, platform, descriptors);
    this.ids = new Set(descriptors.map(d => d.UUID));
    const obsolete = [...this.cached.values()].filter(a => !this.ids.has(a.UUID));
    if (obsolete.length) await this.api.matter.unregisterPlatformAccessories(plugin, platform, obsolete);
    if (this.hapCached.size) this.api.unregisterPlatformAccessories(plugin, platform, [...this.hapCached.values()]);
  }

  async unregisterPlatformAccessories(plugin, platform, accessories) {
    await this.api.matter.unregisterPlatformAccessories(plugin, platform, accessories);
  }

  async updateAccessoryState(id, cluster, state) {
    if (!this.ids.has(id)) throw new Error('Unknown Powerwall service');
    await this.api.matter.updateAccessoryState(id, cluster, state);
  }
}
module.exports = { MatterTransport };
