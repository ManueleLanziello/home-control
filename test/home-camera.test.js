import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHomeControlServer } from '../server.js';
import { HomeCameraRuntime } from '../src/camera-runtime.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from '../src/hardware-registry.js';
import { DeviceRoleStore } from '../src/device-roles.js';

test('C2 is read from Pond without creating an owned CameraManager', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-shared-'));
  const hardwareStore = new HardwareRegistryStore({ filePath: path.join(directory, 'hardware.json'), defaults: defaultHardwareRegistry() });
  const roleStore = new DeviceRoleStore({ filePath: path.join(directory, 'roles.json') });
  let calls = 0;
  const runtime = new HomeCameraRuntime({ hardwareStore, roleStore, root: directory, pondUrl: 'http://pond.fixture', fetchImpl: async url => {
    calls += 1; assert.equal(url, 'http://pond.fixture/api/camera/status');
    return new Response(JSON.stringify({ configured: true, assigned: true, runtimeActive: true, status: 'READY', alias: 'Laghetto', model: 'C410', imageAvailable: true, live: false }), { status: 200 });
  } });
  runtime.owned.createRuntime = () => { throw new Error('C2 must never construct an owned CameraManager'); };
  try {
    const snapshot = await runtime.snapshot();
    assert.equal(calls, 1); assert.equal(snapshot.C2.sourceType, 'shared'); assert.equal(snapshot.C2.available, true);
    assert.equal(snapshot.C1.configured, false); assert.equal(snapshot.C3.configured, false);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('C2 allows Pond enough time to complete a normal camera startup', async () => {
  const runtime = new HomeCameraRuntime({ hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, root: process.cwd(), pondUrl: 'http://pond.fixture' });
  let request;
  runtime.requestPond = async (...args) => { request = args; return new Response('{}', { status: 200 }); };
  runtime.sharedState = async () => ({ role: 'C2', sourceType: 'shared', configured: true, live: true });
  try {
    await runtime.setLive('C2', true);
    assert.equal(request[0], '/api/camera/live');
    assert.equal(request[2], 30_000);
    assert.equal(runtime.owned.entries.size, 0);
  } finally { await runtime.close(); }
});

test('owned C1 passes its registered IP to the CameraManager runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-owned-'));
  const hardwareStore = { async read() { return { devices: [{ id: 'c1', alias: 'Terrazzo', model: 'C410', connection: { ip: '192.168.1.9' }, identity: { mac: '30:68:93:09:34:A3' }, metadata: { adapter: 'tapo-c410-owned' }, configurationStatus: 'complete', verificationStatus: 'verified' }] }; } };
  const roleStore = { async read() { return { c1: 'camera_terrazzo' }; } };
  const runtime = new HomeCameraRuntime({ hardwareStore, roleStore, root: directory, pondUrl: '' });
  let createdWith;
  runtime.owned.createRuntime = async record => { createdWith = record; return { async snapshot() { return { configured: true, status: 'READY' }; }, async stop() {} }; };
  try {
    const snapshot = await runtime.snapshot();
    assert.equal(createdWith.ip, '192.168.1.9');
    assert.equal(snapshot.C1.configured, true);
    assert.equal(snapshot.C1.status, 'READY');
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('camera configuration keeps C1/C3 local and proxies C2 media through Pond only', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-api-'));
  const hardwareStore = new HardwareRegistryStore({ filePath: path.join(directory, 'hardware.json'), defaults: defaultHardwareRegistry() });
  const roleStore = new DeviceRoleStore({ filePath: path.join(directory, 'roles.json') });
  const proxied = [];
  const cameraRuntime = {
    pondUrl: 'http://pond.fixture',
    fetchImpl: async url => { proxied.push(url); return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }); },
    async requestPond(endpoint) { return this.fetchImpl(`${this.pondUrl}${endpoint}`); },
    async snapshot() { return {
      C1: { role: 'C1', configured: false, sourceType: 'owned', available: false },
      C2: { role: 'C2', configured: true, sourceType: 'shared', available: true, online: true, alias: 'Laghetto', model: 'C410', imageAvailable: true, live: false },
      C3: { role: 'C3', configured: false, sourceType: 'owned', available: false },
    }; },
    async imagePath() { return null; }, async setLive(role, active) { return { role, active, sourceType: 'shared' }; },
    async verify() { return { model: 'C410' }; }, async close() {},
  };
  const server = createHomeControlServer({ hardwareStore, roleStore, cameraRuntime,
    thermostatRuntime: { async readSnapshot() { return { online: true, updatedAt: new Date().toISOString(), thermostat: { currentTemperature: 22 } }; } },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const created = await fetch(`${base}/api/hardware/cameras`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'Terrazzo', ip: '192.168.1.44', mac: 'aa:bb:cc:dd:ee:ff', role: 'camera_terrazzo' }) });
    assert.equal(created.status, 201);
    const listed = await (await fetch(`${base}/api/hardware/cameras`)).json();
    assert.equal(listed.cameras[0].role, 'camera_terrazzo'); assert.equal(listed.cameras[0].identity.mac, 'AA:BB:CC:DD:EE:FF');
    assert.deepEqual(listed.shared, { role: 'camera_pond', sourceApp: 'Pond-Control', configured: true });
    const media = await fetch(`${base}/api/cameras/C2/image`);
    assert.equal(media.status, 200); assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [0xff, 0xd8, 0xff]);
    assert.deepEqual(proxied, ['http://pond.fixture/api/camera/image']);
    const home = await (await fetch(`${base}/api/home/status`)).json();
    assert.equal(home.cameras.C2.sourceType, 'shared'); assert.equal(home.cameras.C1.role, 'C1');
  } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
});
