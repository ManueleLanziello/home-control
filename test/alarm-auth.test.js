import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { AlarmAuthorization } from '../src/alarm-auth.js';
import { AlarmRuntime } from '../src/alarm-runtime.js';
import { createHomeControlServer } from '../server.js';

test('password antifurto usa confronto lato server, limita i tentativi e nega una configurazione assente', () => {
  let now = 0; const request = { socket: { remoteAddress: '127.0.0.1' } }; const auth = new AlarmAuthorization({ password: 'admin', now: () => now, randomUUID: () => 'sessione' });
  assert.equal(auth.verify('admin', request), true); assert.equal(auth.verify('no', request), false);
  for (let index = 0; index < 4; index += 1) auth.verify('no', request);
  assert.equal(auth.verify('admin', request), false); now += 30_001; assert.equal(auth.verify('admin', request), true);
  assert.equal(new AlarmAuthorization({ password: '' }).verify('admin', request), false);
});

test('API protegge disinserimento e configurazione SR1 con sessione monouso', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-auth-')); const authorization = new AlarmAuthorization({ password: 'admin' }); const calls = [];
  const zigbeeRuntime = { subscribeState() { return () => {}; }, readDoorContactSnapshot: () => ({}), readMotionSensorSnapshot: () => null, readSirenSnapshot: () => ({ available: true }), setSirenConfiguration: async value => { calls.push(value); return { pending: true, expected: value }; }, close() {} };
  const server = createHomeControlServer({ alarmAuthorization: authorization, alarmStore: new AlarmRuntime({ filePath: path.join(directory, 'alarm.json') }), zigbeeRuntime, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve))); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const put = (path, body, headers = {}) => fetch(base + path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await put('/api/alarm/mode', { mode: 'none' })).status, 401); assert.equal((await put('/api/alarm/mode', { mode: 'none', password: 'admin' })).status, 200);
  assert.equal((await put('/api/alarm/siren/config', { soundEnabled: true })).status, 401);
  const denied = await fetch(base + '/api/alarm/siren/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'no' }) }); assert.equal(denied.status, 401);
  const authorized = await fetch(base + '/api/alarm/siren/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }) }); const { token } = await authorized.json();
  assert.equal((await put('/api/alarm/siren/config', { soundEnabled: true, lightEnabled: false, soundType: 'siren_warning', volumeLevel: 'high', duration: 60 }, { Authorization: `Bearer ${token}` })).status, 202);
  assert.deepEqual(calls, [{ soundEnabled: true, lightEnabled: false, soundType: 'siren_warning', volumeLevel: 'high', duration: 60 }]); assert.equal((await put('/api/alarm/siren/config', { soundEnabled: true }, { Authorization: `Bearer ${token}` })).status, 401);
});

test('disinserimento autorizzato invia STOP dal backend, quello negato non invia comandi', async t => {
  const stops = []; const store = { subscribe() { return () => {}; }, async read() { return { intrusion: { active: true }, events: [] }; }, async selectMode(mode) { assert.equal(mode, 'none'); return { mode: 'none', intrusion: null }; }, async syncSensors() {} };
  const server = createHomeControlServer({ alarmAuthorization: new AlarmAuthorization({ password: 'admin' }), alarmStore: store, alarmSirenController: { activate() {}, stop: options => { stops.push(options); return Promise.resolve(true); } }, zigbeeRuntime: { subscribeState() { return () => {}; }, readDoorContactSnapshot: () => ({}), readMotionSensorSnapshot: () => null, readSirenSnapshot: () => null, close() {} }, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve))); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const url = `http://127.0.0.1:${server.address().port}/api/alarm/mode`;
  const call = password => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'none', password }) });
  assert.equal((await call('no')).status, 401); assert.deepEqual(stops, []); assert.equal((await call('admin')).status, 200); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(stops, [{ force: true }]);
});

test('API TEST SR1 richiede sessione, rifiuta antifurto inserito e delega STOP al controller', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-siren-test-')); let snapshot = { mode: 'none', intrusion: null, events: [] }; const calls = []; let alarmListener;
  const store = { subscribe(listener) { alarmListener = listener; return () => {}; }, async read() { return snapshot; }, async syncSensors() {} };
  let testActive = false; const controller = { activate() {}, async startTest() { calls.push('start'); testActive = true; return true; }, async stopTest() { if (!testActive) return false; calls.push('stop'); testActive = false; return true; }, stop() { return Promise.resolve(true); } };
  const zigbeeRuntime = { subscribeState() { return () => {}; }, readDoorContactSnapshot: () => ({}), readMotionSensorSnapshot: () => null, readSirenSnapshot: () => ({ available: true }), close() {} };
  const server = createHomeControlServer({ alarmAuthorization: new AlarmAuthorization({ password: 'admin' }), alarmStore: store, alarmSirenController: controller, zigbeeRuntime, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve))); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const testRequest = (method, token = '') => fetch(`${base}/api/alarm/siren/test`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await testRequest('POST')).status, 401);
  const authorized = await fetch(`${base}/api/alarm/siren/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }) }); const { token } = await authorized.json();
  assert.equal((await testRequest('POST', token)).status, 202); assert.deepEqual(calls, ['start']);
  alarmListener({ type: 'arming' }); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['start', 'stop']);
  assert.equal((await testRequest('DELETE', token)).status, 202); assert.deepEqual(calls, ['start', 'stop']);
  snapshot = { mode: 'complete', intrusion: null, events: [] }; assert.equal((await testRequest('POST', token)).status, 409);
  snapshot = { mode: 'none', intrusion: { active: true }, events: [] }; assert.equal((await testRequest('POST', token)).status, 409);
});
