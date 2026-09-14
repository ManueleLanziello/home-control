import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createHomeControlServer } from '../server.js';
import { HomeCiarraRuntime } from '../src/ciarra-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';

const stamp = new Date().toISOString();
const initialState = () => ({ online: true, power: false, fanSpeed: 3, light: 'off', operatingStatus: 'off', updatedAt: stamp });

test('runtime CIARRA conserva l ultimo stato quando una lettura LAN fallisce', async () => {
  let fail = false;
  const runtime = new HomeCiarraRuntime({ adapter: { async getState() { if (fail) throw new Error('offline'); return initialState(); } } });
  assert.deepEqual(await runtime.getState(), initialState());
  fail = true;
  assert.deepEqual(await runtime.getState(), { ...initialState(), online: false });
});

test('snapshot Home include lo stato CIARRA LAN normalizzato', async () => {
  const runtime = new HomeStatusRuntime({
    hardwareStore: { async read() { return { devices: [] }; } },
    roleStore: { async read() { return {}; } },
    readThermostat: async () => null,
    readHood: async () => initialState(),
  });
  assert.deepEqual((await runtime.readSnapshot()).hood, initialState());
});

test('API Home espone solo comandi semantici CIARRA con validazione rigida', async () => {
  let state = initialState();
  const calls = [];
  const hoodRuntime = {
    async getState() { return state; },
    async setPower(power) { calls.push(['power', power]); state = { ...state, power }; return state; },
    async setFanSpeed(fanSpeed) { calls.push(['fanSpeed', fanSpeed]); state = { ...state, fanSpeed }; return state; },
    async setLight(light) { calls.push(['light', light]); state = { ...state, light }; return state; },
  };
  const server = createHomeControlServer({
    hardwareStore: { async read() { return { devices: [] }; } },
    roleStore: { async read() { return {}; } },
    thermostatRuntime: { async readSnapshot() { return null; } },
    hoodRuntime,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (path, body) => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await (await fetch(base + '/api/hood')).json()).fanSpeed, 3);
    assert.equal((await put('/api/hood/power', { power: 1 })).status, 400);
    assert.equal((await put('/api/hood/fan-speed', { fanSpeed: '2' })).status, 400);
    assert.equal((await put('/api/hood/fan-speed', { fanSpeed: 5 })).status, 400);
    assert.equal((await put('/api/hood/light', { light: 'Turn_off' })).status, 400);
    assert.equal((await put('/api/hood/power', { power: true })).status, 200);
    assert.equal((await put('/api/hood/fan-speed', { fanSpeed: 2 })).status, 200);
    assert.equal((await put('/api/hood/light', { light: 'level1' })).status, 200);
    assert.equal((await put('/api/hood/dps', { dp: 12, value: '2' })).status, 404);
    assert.deepEqual(calls, [['power', true], ['fanSpeed', 2], ['light', 'level1']]);
  } finally { server.close(); await once(server, 'close'); }
});

test('runtime Home CIARRA non dipende da credenziali o client Cloud', async () => {
  const source = await readFile(new URL('../src/ciarra-runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /TuyaCloud|CLIENT_ID|CLIENT_SECRET/);
  assert.match(source, /CiarraTuyaLanAdapter/);
});
