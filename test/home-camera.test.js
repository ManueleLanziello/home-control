import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHomeControlServer } from '../server.js';
import { HomeCameraRuntime } from '../src/camera-runtime.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from '../src/hardware-registry.js';
import { DeviceRoleStore, HOME_CAMERA_ROLES } from '../src/device-roles.js';

const camera = (id, alias, ip, mac) => ({
  id, alias, model: 'C410', connection: { ip }, identity: { mac }, metadata: { adapter: 'tapo-c410-owned' },
  configurationStatus: 'complete', verificationStatus: 'verified',
});

test('C1 and C2 are independent cameras owned directly by Home-Control', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-owned-'));
  const records = [
    camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'),
    camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02'),
  ];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } },
    root: directory,
  });
  const created = [];
  runtime.owned.createRuntime = async record => {
    let live = false;
    created.push(record);
    return {
      async snapshot() { return { configured: true, status: live ? 'LIVE' : 'READY', source: record.ip, imageAvailable: true, live }; },
      async imagePath() { return `${record.id}.jpg`; },
      async start() { live = true; },
      async stop() { live = false; },
    };
  };
  try {
    const snapshot = await runtime.snapshot();
    assert.deepEqual(created.map(item => item.id).sort(), ['c1', 'c2']);
    assert.equal(snapshot.C1.sourceType, 'owned'); assert.equal(snapshot.C1.source, '192.0.2.1');
    assert.equal(snapshot.C2.sourceType, 'owned'); assert.equal(snapshot.C2.source, '192.0.2.2');
    assert.equal(await runtime.imagePath('C2'), 'c2.jpg');
    const live = await runtime.setLive('C2', true);
    assert.equal(live.status, 'LIVE'); assert.equal(live.source, '192.0.2.2'); assert.equal(live.sourceType, 'owned');
    assert.notEqual(runtime.owned.runtimeForRole('camera_terrazzo'), runtime.owned.runtimeForRole('camera_pond'));
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a C2 snapshot error is isolated from C1 and the rest of Home-Control', async () => {
  const records = [
    camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'),
    camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02'),
  ];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } },
    root: process.cwd(),
  });
  runtime.owned.createRuntime = async record => ({
    async snapshot() { if (record.id === 'c2') throw new Error('fixture failure'); return { configured: true, status: 'READY' }; },
    async stop() {},
  });
  try {
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.C1.status, 'READY'); assert.equal(snapshot.C1.available, true);
    assert.equal(snapshot.C2.status, 'ERROR'); assert.equal(snapshot.C2.available, false); assert.equal(snapshot.C2.alias, 'Pond');
  } finally { await runtime.close(); }
});

test('camera configuration exposes C1/C2/C3 as local roles and C2 media uses the local runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-api-'));
  const imagePath = path.join(directory, 'c2.jpg'); await writeFile(imagePath, new Uint8Array([0xff, 0xd8, 0xff]));
  const hardwareStore = new HardwareRegistryStore({ filePath: path.join(directory, 'hardware.json'), defaults: defaultHardwareRegistry() });
  const roleStore = new DeviceRoleStore({ filePath: path.join(directory, 'roles.json') });
  const calls = [];
  const cameraRuntime = {
    async snapshot() { return {
      C1: { role: 'C1', configured: false, sourceType: 'owned', available: false },
      C2: { role: 'C2', configured: true, sourceType: 'owned', available: true, alias: 'Pond', model: 'C410' },
      C3: { role: 'C3', configured: false, sourceType: 'owned', available: false },
    }; },
    async imagePath(role) { calls.push(['image', role]); return role === 'C2' ? imagePath : null; },
    async setLive(role, active) { calls.push(['live', role, active]); return { role, active, sourceType: 'owned' }; },
    async verify() { return { model: 'C410' }; }, async close() {},
  };
  const server = createHomeControlServer({ hardwareStore, roleStore, cameraRuntime,
    thermostatRuntime: { async readSnapshot() { return { online: true, updatedAt: new Date().toISOString(), thermostat: { currentTemperature: 22 } }; } },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(HOME_CAMERA_ROLES, ['camera_terrazzo', 'camera_pond', 'camera_giardino']);
    const created = await fetch(`${base}/api/hardware/cameras`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'Pond', ip: '192.0.2.2', mac: 'aa:bb:cc:dd:ee:02', role: 'camera_pond' }) });
    assert.equal(created.status, 201);
    const listed = await (await fetch(`${base}/api/hardware/cameras`)).json();
    assert.equal(listed.cameras[0].role, 'camera_pond'); assert.equal(Object.hasOwn(listed, 'shared'), false);
    const media = await fetch(`${base}/api/cameras/C2/image`); assert.equal(media.status, 200);
    assert.deepEqual([...new Uint8Array(await media.arrayBuffer())], [0xff, 0xd8, 0xff]);
    const live = await fetch(`${base}/api/cameras/C2/live`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }) });
    assert.equal(live.status, 200); assert.deepEqual(calls, [['image', 'C2'], ['live', 'C2', true]]);
    const home = await (await fetch(`${base}/api/home/status`)).json();
    assert.equal(home.cameras.C2.sourceType, 'owned'); assert.equal(home.cameras.C1.role, 'C1');
  } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
});
