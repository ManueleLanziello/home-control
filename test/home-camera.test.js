import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHomeControlServer } from '../server.js';
import { HomeCameraRuntime } from '../src/camera-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from '../src/hardware-registry.js';
import { DeviceRoleStore, HOME_CAMERA_ROLES } from '../src/device-roles.js';

const camera = (id, alias, ip, mac) => ({
  id, alias, model: 'C410', connection: { ip }, identity: { mac }, metadata: { adapter: 'tapo-c410-owned' },
  configurationStatus: 'complete', verificationStatus: 'verified',
});
const noTelemetry = async () => ({ battery: { available: false, percent: null, charging: null }, events: { available: false, count: null, windowHours: 12 }, privacy: { available: false, enabled: null }, telemetryUpdatedAt: null });

test('server, dashboard status, alerts and cached controls never contact cameras during idle', async () => {
  const records = [camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'), camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02')];
  const hardwareStore = { async read() { return { devices: records, inventory: [{ marker: 'D11', presenceEnabled: true }, { marker: 'D12', presenceEnabled: true }] }; } };
  const roleStore = { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } };
  let now = Date.now();
  const calls = [];
  const cameraRuntime = new HomeCameraRuntime({ hardwareStore, roleStore, root: process.cwd(), now: () => now,
    async readTelemetry() { calls.push('telemetry'); throw new Error('unexpected'); },
    async readEvents() { calls.push('recordings'); throw new Error('unexpected'); },
    async setPrivacy() { calls.push('privacy'); throw new Error('unexpected'); },
  });
  cameraRuntime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  const server = createHomeControlServer({ hardwareStore, roleStore, cameraRuntime,
    thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let index = 0; index < 4; index++) {
      const home = await (await fetch(`${base}/api/home/status`)).json();
      assert.equal(home.devices.D11.status, 'unknown');
      assert.equal(home.devices.D12.status, 'unknown');
      await fetch(`${base}/api/cameras/event-alerts`);
      await fetch(`${base}/api/cameras/C1/privacy`);
      await fetch(`${base}/api/cameras/C2/detection`);
      await fetch(`${base}/api/cameras/C1/alarm`);
    }
    cameraRuntime.noteContact(records[0], true);
    now += 24 * 60 * 60 * 1000;
    for (let index = 0; index < 4; index++) {
      const home = await (await fetch(`${base}/api/home/status`)).json();
      assert.equal(home.devices.D11.status, 'online');
      assert.equal(home.cameras.C1.lastContactSucceeded, true);
      await fetch(`${base}/api/cameras/event-alerts`);
    }
    assert.deepEqual(calls, []);
    assert.equal(typeof cameraRuntime.startEventMonitor, 'undefined');
    assert.doesNotMatch(await readFile(new URL('../src/camera-runtime.js', import.meta.url), 'utf8'), /setInterval\(|setTimeout\([^\n]*readTelemetry|refreshEventMonitor/);
  } finally { server.close(); await once(server, 'close'); await cameraRuntime.close(); }
});

test('only explicit Live and control commands contact C410; later status reads stay local', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() { calls.push('telemetry'); return { battery: { available: true, percent: 70 }, privacy: { available: true, enabled: false }, detection: false, alarm: { available: true, enabled: false } }; },
    async setPrivacy({ enabled }) { calls.push('privacy'); return { available: true, enabled }; },
    async setDetection({ enabled }) { calls.push('detection'); return { available: true, enabled }; },
    async setAlarm({ enabled }) { calls.push('alarm'); return { available: true, enabled }; },
  });
  let live = false;
  runtime.owned.createRuntime = async () => ({
    async snapshot() { return { status: live ? 'LIVE' : 'READY', live }; },
    async start() { calls.push('live'); live = true; },
    async stop() { live = false; },
  });
  try {
    assert.equal((await runtime.snapshot()).C1.online, null);
    assert.deepEqual(calls, []);
    await runtime.setLive('C1', true);
    assert.deepEqual(calls, ['live', 'telemetry']);
    await runtime.setLive('C1', false);
    await runtime.setPrivacyMode('C1', true);
    await runtime.setDetectionMode('C1', true);
    await runtime.setAlarmMode('C1', true);
    assert.deepEqual(calls, ['live', 'telemetry', 'privacy', 'detection', 'alarm']);
    assert.equal((await runtime.getPrivacyMode('C1')).enabled, true);
    assert.equal((await runtime.getDetectionMode('C1')).enabled, true);
    assert.equal((await runtime.getAlarmMode('C1')).enabled, true);
    for (let index = 0; index < 5; index++) { await runtime.snapshot(); runtime.getCameraEventAlerts(); }
    assert.deepEqual(calls, ['live', 'telemetry', 'privacy', 'detection', 'alarm']);
  } finally { await runtime.close(); }
});

test('UNKNOWN controls read real state only after click, toggle atomically and confirm read-back', async () => {
  const records = [camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'), camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02')];
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } }, root: process.cwd(),
    async readPrivacy({ ip }) { calls.push(['read', 'privacy', ip]); return { available: true, enabled: false }; },
    async setPrivacy({ ip, enabled }) { calls.push(['write', 'privacy', ip, enabled]); return { available: true, enabled }; },
    async readDetection({ ip }) { calls.push(['read', 'detection', ip]); return { available: true, enabled: true }; },
    async setDetection({ ip, enabled }) { calls.push(['write', 'detection', ip, enabled]); return { available: true, enabled }; },
    async readAlarm({ ip }) { calls.push(['read', 'alarm', ip]); return { available: true, enabled: false }; },
    async setAlarm({ ip, enabled }) { calls.push(['write', 'alarm', ip, enabled]); return { available: true, enabled }; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot();
    await runtime.getPrivacyMode('C1'); await runtime.getDetectionMode('C2'); await runtime.getAlarmMode('C1');
    assert.deepEqual(calls, []);
    assert.equal((await runtime.toggleUnknownControl('C1', 'privacy')).enabled, true);
    assert.equal((await runtime.toggleUnknownControl('C2', 'detection')).enabled, false);
    assert.equal((await runtime.toggleUnknownControl('C1', 'alarm')).enabled, true);
    assert.deepEqual(calls, [
      ['read', 'privacy', '192.0.2.1'], ['write', 'privacy', '192.0.2.1', true],
      ['read', 'detection', '192.0.2.2'], ['write', 'detection', '192.0.2.2', false],
      ['read', 'alarm', '192.0.2.1'], ['write', 'alarm', '192.0.2.1', true],
    ]);
    assert.equal((await runtime.getPrivacyMode('C1')).enabled, true);
    assert.equal((await runtime.getDetectionMode('C2')).enabled, false);
    assert.equal((await runtime.getAlarmMode('C1')).enabled, true);
    for (let index = 0; index < 5; index++) { await runtime.snapshot(); runtime.getCameraEventAlerts(); }
    assert.equal(calls.length, 6);
  } finally { await runtime.close(); }
});

test('UNKNOWN control read failure never sends a pending command or confirms a state', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  let writes = 0;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readPrivacy() { throw new Error('read failed'); },
    async setPrivacy() { writes++; return { available: true, enabled: true }; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await assert.rejects(runtime.toggleUnknownControl('C1', 'privacy'), /read failed/);
    assert.equal(writes, 0);
    assert.equal((await runtime.getPrivacyMode('C1')).available, false);
    assert.equal((await runtime.snapshot()).C1.lastContactSucceeded, false);
  } finally { await runtime.close(); }
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
    readTelemetry: noTelemetry,
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
    readTelemetry: noTelemetry,
  });
  runtime.owned.createRuntime = async record => ({
    async snapshot() { if (record.id === 'c2') throw new Error('fixture failure'); return { configured: true, status: 'READY' }; },
    async stop() {},
  });
  try {
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.C1.status, 'READY'); assert.equal(snapshot.C1.available, false);
    assert.equal(snapshot.C2.status, 'ERROR'); assert.equal(snapshot.C2.available, false); assert.equal(snapshot.C2.alias, 'Pond');
    assert.equal(snapshot.C2.battery.available, false); assert.equal(snapshot.C2.events.available, false);
  } finally { await runtime.close(); }
});

test('telemetria read-only C1/C2 è indipendente, in cache e non blocca lo snapshot', async () => {
  const records = [
    camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'),
    camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02'),
  ];
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } },
    root: process.cwd(), telemetryTtlMs: 60_000,
    async readTelemetry({ ip }) {
      calls.push(ip);
      if (ip.endsWith('.2')) throw new Error('C2 unavailable');
      return { battery: { available: true, percent: 72, charging: true }, events: { available: true, count: 3, windowHours: 12 }, telemetryUpdatedAt: '2026-09-22T10:00:00.000Z' };
    },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { configured: true, status: 'READY', live: false }; }, async stop() {} });
  try {
    const initial = await runtime.snapshot();
    assert.equal(initial.C1.battery.available, false);
    assert.equal(initial.C2.events.available, false);
    assert.deepEqual(calls, []);
    await runtime.refreshTelemetryForLive(records[0]);
    const updated = await runtime.snapshot();
    assert.equal(updated.C1.online, true);
    assert.equal(updated.C2.online, null);
    assert.deepEqual(updated.C1.battery, { available: true, percent: 72, charging: true });
    assert.deepEqual(updated.C1.events, { available: true, count: 3, windowHours: 12 });
    assert.equal(updated.C2.battery.available, false);
    assert.equal(updated.C2.events.available, false);
    assert.deepEqual(calls, ['192.0.2.1']);
  } finally { await runtime.close(); }
});

test('Home status and D11 use only last contact, including unknown and offline', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  let reads = 0;
  const cameraRuntime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record], inventory: [{ marker: 'D11', presenceEnabled: true, status: 'active' }] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() { reads++; throw new Error('unexpected camera I/O'); },
  });
  cameraRuntime.owned.createRuntime = async () => ({ async snapshot() { return { configured: true, status: 'READY', live: false }; }, async stop() {} });
  const homeRuntime = new HomeStatusRuntime({
    hardwareStore: { async read() { return { devices: [record], inventory: [{ marker: 'D11', presenceEnabled: true, status: 'active' }] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } },
    readThermostat: async () => ({ online: false, thermostat: {} }), readCameras: () => cameraRuntime.snapshot(),
  });
  try {
    const home = await Promise.race([
      homeRuntime.readSnapshot(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('home status blocked on camera I/O')), 100)),
    ]);
    assert.equal(home.cameras.C1.online, null);
    assert.equal(home.cameras.C1.available, false);
    assert.equal(home.cameras.C1.battery.available, false);
    assert.equal(home.devices.D11.status, 'unknown');
    cameraRuntime.noteContact(record, false);
    const offline = await homeRuntime.readSnapshot();
    assert.equal(offline.cameras.C1.online, false);
    assert.equal(offline.cameras.C1.status, 'OFFLINE');
    assert.equal(offline.cameras.C1.privacy.available, false);
    assert.equal(offline.devices.D11.status, 'offline');
    cameraRuntime.noteContact(record, true);
    const previous = await homeRuntime.readSnapshot();
    assert.equal(previous.devices.D11.status, 'online');
    for (let index = 0; index < 4; index++) await homeRuntime.readSnapshot();
    assert.equal(reads, 0);
  } finally { await cameraRuntime.close(); }
});

test('refresh camera sovrapposto è singolo; errore non cancella stato valido e popup riusa le clip', async () => {
  const records = [camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01')];
  let reads = 0; let historyReads = 0;
  const now = Date.now();
  const clip = { startTime: Math.floor((now - 1000) / 1000), endTime: Math.floor((now + 9000) / 1000), vedio_type: 2 };
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(), now: () => now,
    async readTelemetry() { reads++; return { battery: { available: true, percent: 52, charging: false }, events: { available: true, count: 1, windowHours: 12 }, privacy: { available: true, enabled: true }, recordings: { available: true, clips: [clip] } }; },
    async readEvents() { historyReads++; throw new Error('history should be cached'); },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { configured: true, status: 'READY', live: false }; }, async stop() {} });
  try {
    await Promise.all([runtime.snapshot(), runtime.snapshot()]);
    assert.equal(reads, 0);
    await runtime.refreshTelemetryForLive(records[0]);
    assert.equal(reads, 1);
    assert.equal((await runtime.getCameraEvents('C1')).events.length, 1);
    assert.equal(historyReads, 0);
    runtime.cacheControl(records[0], { alarm: { available: true, enabled: true }, detection: false });
    const snapshot = await runtime.snapshot();
    assert.equal(snapshot.C1.alarm.enabled, true);
    assert.equal(snapshot.C1.detection, false);
    assert.equal(snapshot.C1.battery.percent, 52);
    assert.equal(Object.hasOwn(snapshot.C1, 'recordings'), false);
  } finally { await runtime.close(); }
});

test('popup storico riusa metadata ottenuti da un Live esplicito', async () => {
  const records = [camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01')];
  let release; const gate = new Promise(resolve => { release = resolve; });
  let historyReads = 0; const now = Date.now();
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(), now: () => now,
    async readTelemetry() { await gate; return { battery: { available: true, percent: 80, charging: false }, events: { available: true, count: 1, windowHours: 12 }, privacy: { available: true, enabled: false }, recordings: { available: true, clips: [{ startTime: Math.floor(now / 1000), endTime: Math.floor(now / 1000) + 5, vedio_type: 2 }] } }; },
    async readEvents() { historyReads++; throw new Error('duplicate'); },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot();
    const refresh = runtime.refreshTelemetryForLive(records[0]);
    release();
    await refresh;
    const history = runtime.getCameraEvents('C1');
    assert.equal((await history).events.length, 1);
    assert.equal(historyReads, 0);
  } finally { release(); await runtime.close(); }
});

test('video evento valida l ID, deduplica la preparazione e pulisce la cache temporanea', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'); const now = Date.now(); const calls = []; let cleanups = 0;
  const startTime = Math.floor((now - 20_000) / 1000); const endTime = startTime + 10;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } }, roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(), now: () => now,
    recordingTtlMs: 10, async readTelemetry() { return { recordings: { available: true, clips: [{ startTime, endTime, vedio_type: 2 }] } }; },
    async readRecording(input) { calls.push(input); return { path: 'temporary.mp4', size: 3, async cleanup() { cleanups++; } }; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot(); await runtime.refreshTelemetryForLive(record);
    const event = (await runtime.getCameraEvents('C1')).events[0];
    const [first, second] = await Promise.all([runtime.getCameraEventVideo('C1', event.id), runtime.getCameraEventVideo('C1', event.id)]);
    assert.equal(first.path, 'temporary.mp4'); assert.equal(second.path, 'temporary.mp4'); await first.release(); await second.release();
    assert.deepEqual(calls.map(({ ip, startTime: start, endTime: end }) => ({ ip, start, end })), [{ ip: '192.0.2.1', start: startTime, end: endTime }]);
    await assert.rejects(runtime.getCameraEventVideo('C1', '1-2'), /Registrazione non disponibile/);
    await assert.rejects(runtime.getCameraEventVideo('C3', event.id), /Camera non disponibile/);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(cleanups, 1);
  } finally { await runtime.close(); }
});

test('explicit history may read C410, but cached MP4 playback skips expired metadata', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  let now = Date.now(); let historyReads = 0; let downloads = 0;
  const startTime = Math.floor((now - 20_000) / 1000); const endTime = startTime + 8;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(), now: () => now,
    async readEvents() { historyReads++; return { available: true, hours: 12, events: [{ id: `${startTime}-${endTime}`, startTime, endTime }] }; },
    async readRecording() { downloads++; return { path: 'cached.mp4', size: 3, async cleanup() {} }; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot();
    const history = await runtime.getCameraEvents('C1');
    assert.equal(history.events.length, 1);
    const first = await runtime.getCameraEventVideo('C1', history.events[0].id);
    await first.release();
    assert.equal(historyReads, 1); assert.equal(downloads, 1);
    now += 61_000;
    const cached = await runtime.getCameraEventVideo('C1', history.events[0].id);
    assert.equal(cached.path, 'cached.mp4'); await cached.release();
    assert.equal(historyReads, 1); assert.equal(downloads, 1);
  } finally { await runtime.close(); }
});

test('alert polling reads memory only, including after a prior successful contact', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() { throw new Error('unexpected telemetry'); },
    async readEvents() { throw new Error('unexpected events'); },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    runtime.noteContact(record, true);
    await runtime.snapshot();
    for (let index = 0; index < 100; index++) runtime.getCameraEventAlerts();
    assert.equal(runtime.getCameraEventAlerts().C1.active, false);
    assert.equal(typeof runtime.startEventMonitor, 'undefined');
    assert.equal(typeof runtime.refreshEventMonitor, 'undefined');
  } finally { await runtime.close(); }
});

test('getter Alarm/Events falliti non cancellano Privacy, Detection e batteria', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  let now = 1000; let reads = 0;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(), now: () => now, telemetryTtlMs: 10,
    async readTelemetry() {
      reads++;
      if (reads === 1) return { battery: { available: true, percent: 77 }, events: { available: true, count: 3 }, privacy: { available: true, enabled: true }, detection: false, alarm: { available: true, enabled: true } };
      return { battery: { available: false }, events: { available: false }, privacy: { available: false, enabled: null }, detection: null, alarm: { available: false, enabled: null } };
    },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot(); await runtime.refreshTelemetryForLive(record);
    now += 20;
    await runtime.snapshot(); await runtime.refreshTelemetryForLive(record);
    const state = (await runtime.snapshot()).C1;
    assert.equal(state.privacy.enabled, true);
    assert.equal(state.detection, false);
    assert.equal(state.alarm.enabled, true);
    assert.equal(state.battery.percent, 77);
    assert.equal(state.events.count, 3);
  } finally { await runtime.close(); }
});

test('GET bootstrap riusa i controlli appena letti dal worker telemetria', async () => {
  const record = camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01');
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() { return { privacy: { available: true, enabled: true }, detection: false, alarm: { available: true, enabled: false } }; },
    async readPrivacy() { calls.push('privacy'); throw new Error('duplicate'); },
    async readDetection() { calls.push('detection'); throw new Error('duplicate'); },
    async readAlarm() { calls.push('alarm'); throw new Error('duplicate'); },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot(); await runtime.refreshTelemetryForLive(record);
    assert.equal((await runtime.getPrivacyMode('C1')).enabled, true);
    assert.equal((await runtime.getDetectionMode('C1')).enabled, false);
    assert.equal((await runtime.getAlarmMode('C1')).enabled, false);
    assert.deepEqual(calls, []);
  } finally { await runtime.close(); }
});

test('Privacy usa il ruolo richiesto, conserva solo il read-back e isola C1/C2/C3', async () => {
  const records = [
    camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'),
    camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02'),
  ];
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } },
    root: process.cwd(), readTelemetry: noTelemetry,
    async readPrivacy({ ip }) { return { available: true, enabled: ip.endsWith('.1') }; },
    async setPrivacy({ ip, enabled }) {
      calls.push([ip, enabled]);
      if (ip.endsWith('.2')) throw new Error('fixture failure');
      return { available: true, enabled };
    },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { configured: true, status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot();
    assert.deepEqual(await runtime.getPrivacyMode('C1'), { available: false, enabled: null });
    assert.deepEqual(await runtime.setPrivacyMode('C1', true), { available: true, enabled: true });
    assert.deepEqual(await runtime.getPrivacyMode('C1'), { available: true, enabled: true });
    assert.equal((await runtime.snapshot()).C1.privacy.enabled, true);
    await assert.rejects(runtime.setPrivacyMode('C2', false), /fixture failure/);
    await assert.rejects(runtime.setPrivacyMode('C3', true), /Camera non disponibile/);
    assert.deepEqual(calls, [['192.0.2.1', true], ['192.0.2.2', false]]);
  } finally { await runtime.close(); }
});

test('Rilevazione usa il master del ruolo richiesto, con read-back e C3 fail-safe', async () => {
  const records = [
    camera('c1', 'Terrazzo', '192.0.2.1', 'AA:BB:CC:DD:EE:01'),
    camera('c2', 'Pond', '192.0.2.2', 'AA:BB:CC:DD:EE:02'),
  ];
  const calls = [];
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: records }; } },
    roleStore: { async read() { return { c1: 'camera_terrazzo', c2: 'camera_pond' }; } },
    root: process.cwd(), readTelemetry: noTelemetry,
    async readDetection({ ip }) { calls.push(['read', ip]); return { available: true, enabled: ip.endsWith('.1') }; },
    async setDetection({ ip, enabled }) { calls.push(['set', ip, enabled]); return { available: true, enabled }; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { configured: true, status: 'READY', live: false }; }, async stop() {} });
  try {
    await runtime.snapshot();
    assert.deepEqual(await runtime.getDetectionMode('C1'), { available: false, enabled: null });
    assert.deepEqual(await runtime.setDetectionMode('C2', true), { available: true, enabled: true });
    assert.equal((await runtime.snapshot()).C2.detection, true);
    await assert.rejects(runtime.getDetectionMode('C3'), /Camera non disponibile/);
    assert.deepEqual(calls, [['set', '192.0.2.2', true]]);
  } finally { await runtime.close(); }
});

test('camera configuration exposes C1/C2/C3 as local roles and C2 media uses the local runtime', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-camera-api-'));
  const imagePath = path.join(directory, 'c2.jpg'); await writeFile(imagePath, new Uint8Array([0xff, 0xd8, 0xff]));
  const videoPath = path.join(directory, 'recording.mp4'); await writeFile(videoPath, new Uint8Array([0, 1, 2]));
  const hardwareStore = new HardwareRegistryStore({ filePath: path.join(directory, 'hardware.json'), defaults: defaultHardwareRegistry() });
  const roleStore = new DeviceRoleStore({ filePath: path.join(directory, 'roles.json') });
  const calls = []; let videoReleases = 0;
  const cameraRuntime = {
    async snapshot() { return {
      C1: { role: 'C1', configured: false, sourceType: 'owned', available: false },
      C2: { role: 'C2', configured: true, sourceType: 'owned', available: true, alias: 'Pond', model: 'C410' },
      C3: { role: 'C3', configured: false, sourceType: 'owned', available: false },
    }; },
    async imagePath(role) { calls.push(['image', role]); return role === 'C2' ? imagePath : null; },
    async setLive(role, active) { calls.push(['live', role, active]); return { role, active, sourceType: 'owned' }; },
    async getPrivacyMode(role) { calls.push(['privacy-read', role]); return { available: true, enabled: false }; },
    async setPrivacyMode(role, enabled) { calls.push(['privacy', role, enabled]); return { available: true, enabled }; },
    async getDetectionMode(role) { calls.push(['detection-read', role]); if (role === 'C3') throw new Error('Camera non disponibile'); return { available: true, enabled: role === 'C1' }; },
    async setDetectionMode(role, enabled) { calls.push(['detection', role, enabled]); if (role === 'C3') throw new Error('Camera non disponibile'); return { available: true, enabled }; },
    async getAlarmMode(role) { calls.push(['alarm-read', role]); if (role === 'C3') throw new Error('Camera non disponibile'); return { available: true, enabled: role === 'C1' }; },
    async setAlarmMode(role, enabled) { calls.push(['alarm', role, enabled]); if (role === 'C3') throw new Error('Camera non disponibile'); return { available: true, enabled }; },
    async toggleUnknownControl(role, kind) { calls.push(['toggle', role, kind]); if (role === 'C3') throw new Error('Camera non disponibile'); return { available: true, enabled: true }; },
    async getCameraEvents(role, hours) { calls.push(['events', role, hours]); if (role === 'C3') throw new Error('Camera non disponibile'); return { camera: role, hours, available: true, events: [] }; },
    async getCameraEventVideo(role, eventId) { calls.push(['video', role, eventId]); if (role === 'C3' || eventId !== '1-2') throw new Error('Registrazione non disponibile'); return { path: videoPath, size: 3, async release() { videoReleases++; } }; },
    getCameraEventAlerts() { return { C1: { active: true, version: '123', until: 15_000 }, C2: { active: false, version: null, until: null }, C3: { active: false, version: null, until: null } }; },
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
    const privacy = await fetch(`${base}/api/cameras/C1/privacy`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(privacy.status, 200); assert.deepEqual(await privacy.json(), { available: true, enabled: true });
    assert.deepEqual(calls.at(-1), ['privacy', 'C1', true]);
    for (const [role, kind] of [['C1', 'privacy'], ['C2', 'detection'], ['C1', 'alarm']]) {
      const toggle = await fetch(`${base}/api/cameras/${role}/${kind}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ toggle: true }) });
      assert.equal(toggle.status, 200); assert.deepEqual(await toggle.json(), { available: true, enabled: true });
      assert.deepEqual(calls.at(-1), ['toggle', role, kind]);
    }
    const privacyRead = await fetch(`${base}/api/cameras/C2/privacy`);
    assert.equal(privacyRead.status, 200); assert.deepEqual(await privacyRead.json(), { available: true, enabled: false });
    assert.deepEqual(calls.at(-1), ['privacy-read', 'C2']);
    const detection = await fetch(`${base}/api/cameras/C2/detection`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    assert.equal(detection.status, 200); assert.deepEqual(await detection.json(), { available: true, enabled: true });
    assert.deepEqual(calls.at(-1), ['detection', 'C2', true]);
    const detectionRead = await fetch(`${base}/api/cameras/C1/detection`);
    assert.equal(detectionRead.status, 200); assert.deepEqual(await detectionRead.json(), { available: true, enabled: true });
    assert.deepEqual(calls.at(-1), ['detection-read', 'C1']);
    const detectionC3 = await fetch(`${base}/api/cameras/C3/detection`);
    assert.equal(detectionC3.status, 503);
    const alarm = await fetch(`${base}/api/cameras/C1/alarm`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    assert.equal(alarm.status, 200); assert.deepEqual(await alarm.json(), { available: true, enabled: false });
    assert.deepEqual(calls.at(-1), ['alarm', 'C1', false]);
    const alarmRead = await fetch(`${base}/api/cameras/C2/alarm`);
    assert.equal(alarmRead.status, 200); assert.deepEqual(await alarmRead.json(), { available: true, enabled: false });
    const alarmC3 = await fetch(`${base}/api/cameras/C3/alarm`);
    assert.equal(alarmC3.status, 503);
    const events = await fetch(`${base}/api/cameras/C2/events?hours=12`);
    assert.equal(events.status, 200); assert.deepEqual((await events.json()).events, []);
    const eventsC3 = await fetch(`${base}/api/cameras/C3/events?hours=12`);
    assert.equal(eventsC3.status, 503);
    const video = await fetch(`${base}/api/cameras/C2/events/1-2/video`);
    assert.equal(video.status, 200); assert.equal(video.headers.get('content-type'), 'video/mp4'); assert.equal(video.headers.get('accept-ranges'), 'bytes'); assert.deepEqual([...new Uint8Array(await video.arrayBuffer())], [0, 1, 2]);
    const firstRange = await fetch(`${base}/api/cameras/C2/events/1-2/video`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(firstRange.status, 206); assert.equal(firstRange.headers.get('content-range'), 'bytes 0-1/3'); assert.equal(firstRange.headers.get('content-length'), '2'); assert.deepEqual([...new Uint8Array(await firstRange.arrayBuffer())], [0, 1]);
    const secondRange = await fetch(`${base}/api/cameras/C2/events/1-2/video`, { headers: { Range: 'bytes=2-2' } });
    assert.equal(secondRange.status, 206); assert.equal(secondRange.headers.get('content-range'), 'bytes 2-2/3'); assert.deepEqual([...new Uint8Array(await secondRange.arrayBuffer())], [2]);
    const invalidRange = await fetch(`${base}/api/cameras/C2/events/1-2/video`, { headers: { Range: 'bytes=7-8' } }); assert.equal(invalidRange.status, 416);
    assert.equal(videoReleases, 4);
    const unavailableVideo = await fetch(`${base}/api/cameras/C3/events/1-2/video`);
    assert.equal(unavailableVideo.status, 503);
    const eventAlerts = await fetch(`${base}/api/cameras/event-alerts`);
    assert.equal(eventAlerts.status, 200);
    assert.deepEqual(await eventAlerts.json(), { alerts: { C1: { active: true, version: '123', until: 15_000 }, C2: { active: false, version: null, until: null }, C3: { active: false, version: null, until: null } } });
    const home = await (await fetch(`${base}/api/home/status`)).json();
    assert.equal(home.cameras.C2.sourceType, 'owned'); assert.equal(home.cameras.C1.role, 'C1');
  } finally { server.close(); await once(server, 'close'); await rm(directory, { recursive: true, force: true }); }
});
