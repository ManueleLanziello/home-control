import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHomeControlServer } from '../server.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from '../src/hardware-registry.js';
import { DeviceRoleStore } from '../src/device-roles.js';

test('slow verification serializes complete transactions with concurrent create and alias update', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-sensor-race-'));
  const source = path.join(directory, 'distributed.json');
  await writeFile(source, JSON.stringify(defaultHardwareRegistry()));
  const store = new HardwareRegistryStore({ filePath: path.join(directory, 'local.json'), sourceFilePath: source });
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const server = createHomeControlServer({ hardwareStore: store, roleStore: new DeviceRoleStore({ filePath: path.join(directory, 'roles.json') }), verifySensor: async () => { entered(); await gate; return { verifiedAt: '2026-09-09T12:00:00Z' }; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/hardware/sensors`;
  const options = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = (await (await fetch(base, options('POST', { alias: 'First', tuyaDeviceId: 'one' }))).json()).device;
  const verify = fetch(`${base}/${first.id}/verify`, { method: 'POST' });
  await started;
  const create = fetch(base, options('POST', { alias: 'Second', tuyaDeviceId: 'two' }));
  const rename = fetch(`${base}/${first.id}`, options('PUT', { alias: 'Renamed', tuyaDeviceId: 'one' }));
  assert.equal(await Promise.race([create.then(() => 'completed'), new Promise(resolve => setTimeout(() => resolve('waiting'), 30))]), 'waiting');
  release();
  assert.deepEqual((await Promise.all([verify, create, rename])).map(response => response.status), [200, 201, 200]);
  const registry = await store.read();
  assert.equal(registry.devices.length, 2);
  assert.equal(registry.devices.find(device => device.id === first.id).alias, 'Renamed');
  assert.equal(registry.devices.find(device => device.id === first.id).verificationStatus, 'verified');
  assert.equal(JSON.parse(await readFile(source, 'utf8')).devices.length, 0);
});

test('persists Dewin sensors and logical Home roles without hardware access', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-sensors-'));
  const hardwarePath = path.join(directory, 'hardware.json');
  const rolesPath = path.join(directory, 'roles.json');
  const sourceFilePath = path.join(directory, 'distributed.json');
  const distributed = JSON.stringify(defaultHardwareRegistry());
  await writeFile(sourceFilePath, distributed);
  const server = createHomeControlServer({
    hardwareStore: new HardwareRegistryStore({ filePath: hardwarePath, sourceFilePath, defaults: defaultHardwareRegistry(), idFactory: () => 'unused' }),
    roleStore: new DeviceRoleStore({ filePath: rolesPath }),
    thermostatRuntime: { async readSnapshot() { return { online: true, updatedAt: new Date().toISOString(), thermostat: { currentTemperature: 22 } }; } },
    verifySensor: async (device) => ({ physicalDeviceId: device.identity.tuyaDeviceId, name: 'Dewin fixture', capabilities: ['ambientTemperature'], verifiedAt: '2026-09-09T12:00:00.000Z' }),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const add = async (alias, id) => fetch(`${base}/api/hardware/sensors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias, tuyaDeviceId: id }) });
  try {
    const first = await add('Cucina', 'tuya-one'); assert.equal(first.status, 201); const sensor1 = (await first.json()).device;
    const second = await add('Camera', 'tuya-two'); assert.equal(second.status, 201); const sensor2 = (await second.json()).device;
    const third = await add('Giardino', 'tuya-three'); assert.equal(third.status, 201); const sensor3 = (await third.json()).device;
    assert.equal((await fetch(`${base}/api/hardware/sensors/${sensor1.id}/verify`, { method: 'POST' })).status, 200);
    const role = async (deviceId, value) => fetch(`${base}/api/device-roles`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, role: value }) });
    assert.equal((await role(sensor1.id, 'temperature_cucina')).status, 200);
    assert.equal((await role(sensor2.id, 'temperature_cucina')).status, 200);
    assert.equal((await role(sensor2.id, 'temperature_camera')).status, 200);
    assert.equal((await role(sensor3.id, 'temperature_giardino')).status, 200);
    assert.equal((await role(sensor1.id, 'temperature_salotto')).status, 400);
    const listed = await (await fetch(`${base}/api/hardware/sensors`)).json();
    assert.deepEqual(listed.sensors.map(sensor => sensor.role), ['none', 'temperature_camera', 'temperature_giardino']);
    assert.equal(listed.sensors[0].verificationStatus, 'verified');
    const persisted = JSON.parse(await readFile(hardwarePath, 'utf8'));
    assert.equal(persisted.devices.length, 3); assert.equal(persisted.devices[0].identity.tuyaDeviceId, 'tuya-one');
    const home = await (await fetch(`${base}/api/home/status`)).json();
    assert.equal(home.sensors.S3.value, 22); assert.equal(home.sensors.S1.value, null);
    const aliasResponse = await fetch(`${base}/api/hardware/sensors/${sensor1.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'Updated', tuyaDeviceId: 'tuya-one' }) });
    assert.equal(aliasResponse.status, 200);
    const renamed = (await aliasResponse.json()).device;
    assert.equal(renamed.verificationStatus, 'verified');
    assert.equal(renamed.verifiedAt, '2026-09-09T12:00:00.000Z');
    const changed = await (await fetch(`${base}/api/hardware/sensors/${sensor1.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias: 'Updated', tuyaDeviceId: 'replacement' }) })).json();
    assert.equal(changed.device.verificationStatus, 'pending'); assert.equal(changed.device.verifiedAt, null);
    assert.equal((await fetch(`${base}/api/hardware/sensors/${sensor1.id}`, { method: 'DELETE' })).status, 204);
    assert.equal(await readFile(sourceFilePath, 'utf8'), distributed);
  } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
});
