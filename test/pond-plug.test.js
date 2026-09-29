import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRoleStore } from '../src/device-roles.js';
import { createPondPlugRuntime, POND_PLUG_ADAPTER } from '../src/pond-plug-runtime.js';
import { createPondController } from '../src/pond-safety.js';
import { pondPlugOwnership, requirePondPlugOwner } from '../src/pond-ownership.js';
import { normalizeMac } from '../src/hardware-registry.js';
import { matchingMac } from '../server.js';
import { mkdtemp, rm } from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';

const plug = (id, ip) => ({ id, alias: id, model: 'P105', protocol: 'tpap', connectionType: 'lan', connection: { ip }, metadata: { adapter: POND_PLUG_ADAPTER }, verificationStatus: 'verified' });
test('ownership is fail-closed unless explicitly home', () => { assert.equal(pondPlugOwnership(), 'disabled'); assert.equal(pondPlugOwnership('invalid'), 'disabled'); assert.equal(pondPlugOwnership('home'), 'home'); assert.throws(() => requirePondPlugOwner('disabled'), { code: 'POND_PLUG_OWNERSHIP_DISABLED' }); });
test('P105 verification MAC comparison canonicalizes separators and case but rejects another device', () => {
  assert.equal(normalizeMac(' 98-03-8e-9c-0c-af '), '98:03:8E:9C:0C:AF');
  assert.equal(matchingMac('98:03:8E:9C:0C:AF', '98:03:8E:9C:0C:AF'), true);
  assert.equal(matchingMac('98:03:8E:9C:0C:AF', '98-03-8E-9C-0C-AF'), true);
  assert.equal(matchingMac('98:03:8E:9C:0C:AF', '98:03:8e:9c:0c:af'), true);
  assert.equal(matchingMac('98:03:8E:9C:0C:AF', '98:03:8E:9C:0C:B0'), false);
});
test('P105 runtime is shared-core based and preserves polling/read-back semantics with fakes', async () => {
  const state = new Map([['pump', true], ['heater', false]]); const runtime = createPondPlugRuntime({ devices: [plug('pump', '192.0.2.1'), plug('heater', '192.0.2.2')], createClient: device => ({ async getDeviceInfo() { return { device_on: state.get(device.id) }; }, async setDeviceOn(on) { state.set(device.id, on); }, close() {} }), setIntervalFn: () => 1, clearIntervalFn: () => {} });
  await runtime.pollAll(); assert.equal(runtime.snapshot('pump').state, 'ON'); await runtime.setDeviceOn('heater', true); assert.equal(runtime.snapshot('heater').state, 'ON'); runtime.stop();
});
test('P105 runtime passes injected credentials only to its client factory', async () => {
  let options; const runtime = createPondPlugRuntime({ devices: [plug('pump', '192.0.2.1')], username: 'fake-user', password: 'fake-password', createClient: input => { options = input; return { async getDeviceInfo() { return { device_on: false }; }, close() {} }; } });
  try { await runtime.read('pump'); assert.equal(options.username, 'fake-user'); assert.equal(options.password, 'fake-password'); assert.equal(options.ip, '192.0.2.1'); assert.equal(Object.hasOwn(runtime.deviceList[0], 'password'), false); } finally { runtime.stop(); }
});
test('pond safety requires a fresh ON pump and confirms heater OFF before pump OFF', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pond-role-')); const ids = ['pump', 'heater']; const roles = new DeviceRoleStore({ filePath: path.join(dir, 'roles.json') });
  const state = new Map([['pump', true], ['heater', true]]); const runtime = createPondPlugRuntime({ devices: [plug('pump', '192.0.2.1'), plug('heater', '192.0.2.2')], createClient: device => ({ async getDeviceInfo() { return { device_on: state.get(device.id) }; }, async setDeviceOn(on) { state.set(device.id, on); }, close() {} }) });
  try { await roles.assignPondPlug('pump', 'pump', ids); await roles.assignPondPlug('heater', 'heater', ids); await runtime.pollAll(); const controller = createPondController({ runtime, roleStore: roles }); await controller.set('heater', true); await controller.set('pump', false); assert.equal(state.get('heater'), false); assert.equal(state.get('pump'), false); await assert.rejects(controller.set('heater', true), { code: 'PUMP_REQUIRED' }); } finally { runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
test('safety absorbs DEVICE_BACKOFF, keeps pump unreliable and can protect on a later cycle', async () => {
  const roles = { async read() { return { pump: 'pump', heater: 'heater' }; } }; let reads = 0; let heaterOn = true;
  const runtime = { deviceList: [{ id: 'pump' }, { id: 'heater' }], hasDevice: () => true, isFreshAndReliable: () => false,
    snapshot: id => ({ id, state: id === 'heater' && heaterOn ? 'ON' : 'OFF', online: false }),
    async withDevices(_ids, operation) { return operation({ async read() { reads += 1; if (reads === 1) { const error = new Error('Nuovo tentativo rinviato dal backoff.'); error.code = 'DEVICE_BACKOFF'; throw error; } return { state: heaterOn ? 'ON' : 'OFF' }; }, async setDeviceOn() { heaterOn = false; return { state: 'OFF' }; } }); } };
  const controller = createPondController({ runtime, roleStore: roles });
  assert.deepEqual(await controller.monitor(), { action: 'none', reason: 'DEVICE_BACKOFF' });
  assert.equal(runtime.isFreshAndReliable('pump'), false);
  assert.equal((await controller.monitor()).action, 'heater-off');
  assert.equal(heaterOn, false);
});
test('role assignment atomically swaps pond plug roles', async () => { const dir = await mkdtemp(path.join(os.tmpdir(), 'pond-swap-')); const store = new DeviceRoleStore({ filePath: path.join(dir, 'roles.json') }); try { await store.assignPondPlug('a', 'pump', ['a', 'b']); await store.assignPondPlug('b', 'heater', ['a', 'b']); const swapped = await store.assignPondPlug('a', 'heater', ['a', 'b']); assert.deepEqual(swapped, { a: 'heater', b: 'pump' }); } finally { await rm(dir, { recursive: true, force: true }); } });
