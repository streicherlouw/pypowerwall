'use strict';

/**
 * Grouped Matter transport for Powerwall telemetry and policy controls.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Features: one composed accessory, stable child IDs, native power measurement.
 */
class MatterTransport {
  constructor(api, config) {
    this.api = api;
    this.config = config;
    this.managesAccessoryCache = true;
    this.cached = new Map();
    this.hapCached = new Map();
    this.routes = new Map();
    this.reachable = new Map();
    this.UUID = api.hap.uuid.generate(`homebridge-powerwall-meters:${config.siteId}:matter-group`);
    this.name = config.name || 'Powerwall';
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
    // Keep real home load at the root to expose only one electrical measurement.
    // Stable part IDs preserve endpoint identity; saved ordering preserves relative child order. Homebridge assigns Number
    // tags by position, so removing a part can still change subsequent tags.
    const root = descriptors.find(d => d.context.key.startsWith('meter-load-')) || descriptors[0];
    if (!root) throw new Error('At least one Powerwall service must be enabled');
    const previous = this.cached.get(this.UUID)?.context?.partOrder || [];
    const parts = descriptors.filter(d => d !== root);
    const order = [...previous, ...parts.map(d => d.context.key).filter(key => !previous.includes(key))];
    parts.sort((a, b) => order.indexOf(a.context.key) - order.indexOf(b.context.key));
    this.routes.clear();
    this.reachable.clear();
    for (const descriptor of descriptors) {
      this.routes.set(descriptor.UUID, descriptor === root ? undefined : descriptor.context.key);
      this.reachable.set(descriptor.UUID, false);
    }
    const group = {
      ...root, UUID: this.UUID, displayName: this.name,
      serialNumber: this.UUID.replace(/-/g, ''),
      context: { grouped: true, siteId: this.config.siteId, partOrder: order },
      parts: parts.map(d => ({ id: d.context.key, displayName: d.displayName,
        deviceType: d.deviceType, clusters: d.clusters, handlers: d.handlers })),
    };
    await this.api.matter.registerPlatformAccessories(plugin, platform, [group]);
    const obsolete = [...this.cached.values()].filter(a => a.UUID !== this.UUID);
    if (obsolete.length) await this.api.matter.unregisterPlatformAccessories(plugin, platform, obsolete);
    // Retire HAP only after the grouped Matter registration has succeeded.
    if (this.hapCached.size) this.api.unregisterPlatformAccessories(plugin, platform, [...this.hapCached.values()]);
  }

  async unregisterPlatformAccessories(plugin, platform, accessories) {
    await this.api.matter.unregisterPlatformAccessories(plugin, platform, accessories);
  }

  async updateAccessoryState(id, cluster, state) {
    if (!this.routes.has(id)) throw new Error('Unknown Powerwall service');
    if (cluster === 'bridgedDeviceBasicInformation') {
      // BridgedDeviceBasicInformation belongs to the composed root, not each
      // functional child endpoint. Report a conservative whole-device fault if
      // any enabled function is unavailable, rather than hiding stale states.
      if (typeof state.reachable === 'boolean') {
        this.reachable.set(id, state.reachable);
        await this.api.matter.updateAccessoryState(this.UUID, cluster,
          { reachable: [...this.reachable.values()].every(Boolean) });
      }
      if (state.nodeLabel !== undefined && this.routes.get(id) === undefined) {
        await this.api.matter.updateAccessoryState(this.UUID, cluster, { nodeLabel: this.name });
      }
      return;
    }
    await this.api.matter.updateAccessoryState(this.UUID, cluster, state, this.routes.get(id));
  }
}
module.exports = { MatterTransport };
