'use strict';

/**
 * HTTP client for the pypowerwall proxy.
 * Author: Jason A. Cox
 * https://github.com/jasonacox/pypowerwall
 * Features: bounded requests, token-protected policy writes, readback validation.
 */

const fs = require('node:fs');
const path = require('node:path');

class ProxyClient {
  constructor(config, fetchImpl = fetch) {
    this.base = new URL(config.proxyUrl);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password ||
        this.base.search || this.base.hash) throw new Error('Use an HTTP(S) proxy URL without credentials or query');
    this.base.pathname = this.base.pathname.replace(/\/?$/, '/');
    this.timeoutMs = (config.timeoutSeconds ?? 10) * 1000;
    this.token = config.controlTokenEnv ? process.env[config.controlTokenEnv] : undefined;
    if (config.controlTokenFile) {
      if (!path.isAbsolute(config.controlTokenFile)) throw new Error('controlTokenFile must be an absolute path');
      const fd = fs.openSync(config.controlTokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Control token file must be private (0600)');
        this.token = fs.readFileSync(fd, 'utf8').trim();
      } finally { fs.closeSync(fd); }
    }
    this.fetch = fetchImpl;
  }

  async request(path, value) {
    const options = { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' };
    if (value !== undefined) {
      if (!this.token) throw new Error('Control token environment variable is not set');
      options.method = 'POST';
      options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      options.body = new URLSearchParams({ value: String(value), token: this.token }).toString();
    }
    // Never include a URL, response body or fetch error in logs: reverse proxies
    // can echo credentials. Do not retry writes after ambiguous timeouts.
    let response;
    try { response = await this.fetch(new URL(path.replace(/^\//, ''), this.base), options); }
    catch { throw new Error('Powerwall proxy request failed or timed out'); }
    if (!response.ok) throw new Error(`Powerwall proxy HTTP ${response.status}`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Powerwall proxy returned invalid JSON'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        ['error', 'ERROR', 'unauthorized'].some(key => key in body)) {
      throw new Error('Powerwall proxy returned no usable data');
    }
    return body;
  }

  async readState() {
    return this.request('/homebridge/state');
  }

  async writeSetting(action, value, momentary = false) {
    const body = await this.request('/control/homebridge', JSON.stringify({ action, value }));
    if (body.accepted !== true) throw new Error('Powerwall command was not acknowledged');
    if (momentary) return; // Acknowledgement is not proof that the grid contactor moved.
    const state = await this.readState();
    const expected = action === 'manual_backup' ? value !== false : value;
    const confirmed = action === 'reserve' ? typeof state.reserve === 'number' && Math.abs(state.reserve - value) < 0.01 : state[action] === expected;
    if (!confirmed) throw new Error('Powerwall readback has not confirmed the change');
  }

  async readControl(action) {
    const body = await this.request(`/control/${action}`);
    const value = body[action];
    if (action === 'grid_export' && ['battery_ok', 'pv_only', 'never'].includes(value)) return value;
    if (action === 'grid_charging' && typeof value === 'boolean') return value;
    throw new Error('Powerwall control state unavailable');
  }

  async writeControl(action, value) {
    const body = await this.request(`/control/${action}`, value);
    if (body[action] !== 'Set Successfully') throw new Error('Powerwall control was not acknowledged');
    // The existing proxy may cache the readback briefly. Report a mismatch as
    // unconfirmed, rather than claiming the requested policy is already active.
    const actual = await this.readControl(action);
    if (actual !== value) throw new Error('Powerwall control readback has not confirmed the change');
    return actual;
  }
}

module.exports = { ProxyClient };
