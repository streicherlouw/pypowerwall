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
    for (const accessory of descriptors) {
      if (!accessory.context.key.endsWith('-net-v2')) continue;
      // Homebridge normally adds utility types after attaching the endpoint.
      // Supply them in the initial Descriptor so discovery cannot see an outlet
      // before its metering capabilities. Keep the working load endpoint intact.
      const types = [accessory.deviceType, this.deviceTypes.ElectricalSensor];
      accessory.clusters.descriptor = { deviceTypeList: types.map(type => ({
        deviceType: type.deviceType, revision: type.deviceRevision,
      })) };
      if (accessory.clusters.powerSource) {
        // Matter Power Source utility device type (revision 1).
        accessory.clusters.descriptor.deviceTypeList.push({ deviceType: 0x11, revision: 1 });
      }
    }
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
