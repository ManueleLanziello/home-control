import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HardwareRegistryStore } from '../src/hardware-registry.js';

const device = (id = 'sensor') => ({ id, alias: id, model: 'Dewin', protocol: 'tuya-cloud', connectionType: 'cloud', identity: { tuyaDeviceId: id }, metadata: { adapter: 'dewin-tuya' }, configurationStatus: 'complete', verificationStatus: 'verified', verifiedAt: '2026-01-01T00:00:00Z' });
test('local registry reconciles deployments while preserving UI configuration, verification and deletions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'home-local-'));
  const sourceFilePath = path.join(dir, 'distributed.json');
  const filePath = path.join(dir, 'local.json');
  let source = { devices: [device()], inventory: [] };
  const deploy = () => writeFile(sourceFilePath, JSON.stringify(source));
  const boot = () => new HardwareRegistryStore({ filePath, sourceFilePath });
  try {
    await deploy();
    const original = await readFile(sourceFilePath, 'utf8');
    let store = boot();
    let registry = await store.read();
    assert.equal(registry.devices[0].verifiedAt, device().verifiedAt);
    const first = await readFile(filePath, 'utf8');
    await boot().read();
    assert.equal(await readFile(filePath, 'utf8'), first);
    registry.devices[0].alias = 'Local alias';
    registry.devices[0].verifiedAt = '2026-02-01T00:00:00Z';
    registry.devices.push(device('ui-created'));
    await store.write(registry);
    assert.equal(await readFile(sourceFilePath, 'utf8'), original);
    source.devices.push(device('new-distributed'));
    source.inventory.push({ marker: 'MOBILE-NEW', name: 'New mobile', category: 'mobile', type: 'phone', presenceEnabled: true });
    await deploy();
    store = boot(); registry = await store.read();
    assert.deepEqual(registry.devices.map(x => x.id), ['sensor', 'new-distributed', 'ui-created']);
    assert.equal(registry.devices[0].alias, 'Local alias');
    assert.equal(registry.devices[0].verifiedAt, '2026-02-01T00:00:00Z');
    assert.equal(registry.inventory[0].name, 'New mobile');
    source.devices[0].identity.tuyaDeviceId = 'replacement';
    source.inventory[0].name = 'Updated mobile';
    await deploy();
    store = boot(); registry = await store.read();
    assert.equal(registry.devices[0].identity.tuyaDeviceId, 'replacement');
    assert.equal(registry.devices[0].verificationStatus, 'pending');
    assert.equal(registry.devices[0].verifiedAt, null);
    assert.equal(registry.devices[0].alias, 'Local alias');
    assert.equal(registry.inventory[0].name, 'Updated mobile');
    registry.devices = registry.devices.filter(x => x.id !== 'sensor');
    await store.write(registry);
    assert.equal((await boot().read()).devices.some(x => x.id === 'sensor'), false);
    assert.equal(await readFile(sourceFilePath, 'utf8'), JSON.stringify(source));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid source leaves existing local bytes intact and bootstrap can recover', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'home-local-recovery-'));
  const sourceFilePath = path.join(dir, 'distributed.json');
  const filePath = path.join(dir, 'local.json');
  try {
    await writeFile(sourceFilePath, JSON.stringify({ devices: [device()], inventory: [] }));
    await new HardwareRegistryStore({ filePath, sourceFilePath }).read();
    const before = await readFile(filePath, 'utf8');
    await writeFile(sourceFilePath, '{broken');
    const store = new HardwareRegistryStore({ filePath, sourceFilePath });
    await assert.rejects(store.read());
    assert.equal(await readFile(filePath, 'utf8'), before);
    await writeFile(sourceFilePath, JSON.stringify({ devices: [device()], inventory: [] }));
    assert.equal((await store.read()).devices.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
