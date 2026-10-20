import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { CameraAlarmAutomation, cameraDetectionTarget } from '../src/camera-alarm-automation.js';
import { CameraAlarmAutomationStore } from '../src/camera-alarm-automation-store.js';
import { createHomeControlServer } from '../server.js';

class AlarmFixture {
  constructor(state = { mode: 'none', armingUntil: null, intrusion: null }) { this.state = state; this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async read() { return structuredClone(this.state); }
  emit(next) { this.state = { ...this.state, ...next }; for (const listener of this.listeners) listener({ type: 'state' }); }
}

class CameraFixture {
  constructor() { this.calls = []; this.listeners = new Set(); this.fail = new Set(); }
  subscribeContact(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async setDetectionMode(role, enabled) { this.calls.push([role, enabled]); if (this.fail.has(role)) throw Error('offline'); return { available: true, enabled }; }
  contact(role) { for (const listener of this.listeners) listener({ role, online: true }); }
}

test('AUT-002 default disabled, persists independently and maps every alarm state to the documented target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'camera-automation-'));
  try {
    const store = new CameraAlarmAutomationStore({ filePath: path.join(directory, 'automation.json') });
    assert.deepEqual(await store.read(), { enabled: false });
    await store.set(true); assert.deepEqual(await new CameraAlarmAutomationStore({ filePath: path.join(directory, 'automation.json') }).read(), { enabled: true });
    assert.equal(cameraDetectionTarget({ mode: 'none', armingUntil: null, intrusion: null }), false);
    assert.equal(cameraDetectionTarget({ mode: 'partial', armingUntil: null, intrusion: null }), true);
    assert.equal(cameraDetectionTarget({ mode: 'complete', armingUntil: null, intrusion: null }), true);
    assert.equal(cameraDetectionTarget({ mode: 'none', armingUntil: 1, intrusion: null }), true);
    assert.equal(cameraDetectionTarget({ mode: 'none', armingUntil: null, intrusion: { active: true } }), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('AUT-002 applies once per target, keeps C2 independent, retries C1 only after a later contact and stops after disable', async () => {
  let enabled = false; const store = { async read() { return { enabled }; }, async set(value) { enabled = value; return { enabled }; } };
  const alarm = new AlarmFixture(); const cameras = new CameraFixture(); const automation = new CameraAlarmAutomation({ alarmStore: alarm, cameraRuntime: cameras, store });
  await automation.start(); assert.deepEqual(cameras.calls, []);
  await automation.setEnabled(true); assert.deepEqual(cameras.calls, [['C1', false], ['C2', false]]);
  alarm.emit({ mode: 'partial' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cameras.calls.slice(-2), [['C1', true], ['C2', true]]);
  const count = cameras.calls.length; alarm.emit({ intrusion: { active: false } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(cameras.calls.length, count);
  cameras.fail.add('C1'); alarm.emit({ mode: 'none', intrusion: null }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cameras.calls.slice(-2), [['C1', false], ['C2', false]]);
  cameras.fail.delete('C1'); cameras.contact('C1'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cameras.calls.at(-1), ['C1', false]);
  await automation.setEnabled(false); const afterDisable = cameras.calls.length; alarm.emit({ mode: 'complete' }); cameras.contact('C1'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cameras.calls.length, afterDisable); automation.close();
});

test('API AUT-002 espone, salva e propaga lo stato senza alterare le API manuali delle CAM', async t => {
  let enabled = false;
  const store = { async read() { return { enabled }; }, async set(value) { enabled = value; return { enabled }; } };
  const alarm = new AlarmFixture(); const cameras = new CameraFixture();
  cameras.snapshot = async () => ({}); cameras.close = async () => {};
  const automation = new CameraAlarmAutomation({ alarmStore: alarm, cameraRuntime: cameras, store });
  const wake = { start() {}, stop() {} };
  const server = createHomeControlServer({ alarmStore: alarm, cameraRuntime: cameras, cameraWakeScheduler: wake, cameraAlarmAutomation: automation,
    hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); await new Promise(resolve => setImmediate(resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/alarm/camera-automation`)).json(), { enabled: false });
  assert.equal((await (await fetch(`${base}/api/alarm`)).json()).cameraAutomation.enabled, false);
  const response = await fetch(`${base}/api/alarm/camera-automation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(cameras.calls, [['C1', false], ['C2', false]]);
  assert.equal((await fetch(`${base}/api/alarm/camera-automation`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }) })).status, 400);
});

test('popup ANTIFURTO colloca il controllo CAM tra temporizzazioni e audio e ascolta l evento condiviso', async () => {
  const source = await readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8');
  assert.match(source, /data-delay[^]*data-camera-automation[^]*alarm-audio/);
  assert.match(source, /\/api\/alarm\/camera-automation/);
  assert.match(source, /addEventListener\('camera-automation'/);
});
