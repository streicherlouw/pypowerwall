'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyClient } = require('../src/client');
const reply = body => ({ ok: true, json: async () => body });

test('proxy base path is retained; token only travels in POST body', async () => {
  const calls = [];
  process.env.PW_METERS_TEST_TOKEN = 'secret&value';
  const client = new ProxyClient({ proxyUrl: 'https://proxy.example/powerwall', controlTokenEnv: 'PW_METERS_TEST_TOKEN' },
    async (url, options) => { calls.push([url, options]); return reply({ grid_export: options.method ? 'Set Successfully' : 'battery_ok' }); });
  await client.writeControl('grid_export', 'battery_ok');
  assert.equal(calls[0][0].pathname, '/powerwall/control/grid_export');
  assert.equal(calls[0][0].search, '');
  assert.equal(new URLSearchParams(calls[0][1].body).get('token'), 'secret&value');
  assert.equal(calls[1][1].body, undefined);
  assert.equal(calls[0][1].redirect, 'error');
  delete process.env.PW_METERS_TEST_TOKEN;
});
test('HTTP 200 errors, null, malformed JSON and transport errors fail without leaking bodies', async () => {
  for (const body of [null, [], { error: 'secret' }, { ERROR: 'secret' }, { unauthorized: 'secret' }]) {
    const client = new ProxyClient({ proxyUrl: 'http://localhost' }, async () => reply(body));
    await assert.rejects(client.request('/soe'), /no usable data/);
  }
  const client = new ProxyClient({ proxyUrl: 'http://localhost' }, async () => { throw new Error('secret'); });
  await assert.rejects(client.request('/soe'), error => !error.message.includes('secret'));
  client.fetch = async () => ({ ok: true, json: async () => { throw new Error('secret'); } });
  await assert.rejects(client.request('/soe'), /invalid JSON/);
  client.fetch = async () => ({ ok: false, status: 401 });
  await assert.rejects(client.request('/soe'), /HTTP 401/);
});
test('write needs explicit acknowledgement and matching readback; timeout is not retried', async () => {
  let requests = 0;
  const client = new ProxyClient({ proxyUrl: 'http://localhost' }, async () => { requests++; return reply({ grid_export: 'never' }); });
  await assert.rejects(client.writeControl('grid_export', 'battery_ok'), /token/);
  assert.equal(requests, 0);
  client.token = 'test';
  await assert.rejects(client.writeControl('grid_export', 'battery_ok'), /not acknowledged/);
  client.fetch = async (_, options) => reply({ grid_export: options.method ? 'Set Successfully' : 'never' });
  await assert.rejects(client.writeControl('grid_export', 'battery_ok'), /not confirmed/);
  requests = 0;
  client.fetch = async () => { requests++; throw new Error('timeout'); };
  await assert.rejects(client.writeControl('grid_export', 'battery_ok'), /timed out/);
  assert.equal(requests, 1);
});

test('new settings route preserves unknown and validates readback without retries', async () => {
  const calls = [];
  const client = new ProxyClient({ proxyUrl: 'http://localhost' }, async (_, options) => {
    calls.push(options);
    return reply(options.method ? { accepted: true } : { reserve: 20.00001, grid_charging: null });
  });
  client.token = 'test';
  await client.writeSetting('reserve', 20);
  assert.deepEqual(JSON.parse(new URLSearchParams(calls[0].body).get('value')), { action: 'reserve', value: 20 });
  await assert.rejects(client.writeSetting('grid_charging', false), /not confirmed/);
  assert.equal((await client.readState()).grid_charging, null);
  calls.length = 0;
  await client.writeSetting('go_off_grid', true, true);
  assert.equal(calls.length, 1);
});

test('file token requires private permissions and is never put in request URLs', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-token-test-'));
  const file = path.join(dir, 'token');
  try {
    fs.writeFileSync(file, 'test-secret\n', { mode: 0o600 });
    assert.equal(new ProxyClient({ proxyUrl: 'http://localhost', controlTokenFile: file }).token, 'test-secret');
    fs.chmodSync(file, 0o644);
    assert.throws(() => new ProxyClient({ proxyUrl: 'http://localhost', controlTokenFile: file }), /private/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
