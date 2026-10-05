import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraEventStateStore, cameraEventIdentity } from '../src/camera-event-state-store.js';
import { HomeCameraRuntime } from '../src/camera-runtime.js';

const clip = (startTime, endTime, vedio_type = 1) => ({ startTime, endTime, vedio_type });
const storeFor = async options => {
  let serialized;
  const readState = async () => {
    if (serialized === undefined) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
    return serialized;
  };
  const writeState = async value => { serialized = value; };
  return { storage: { readState, writeState }, store: new CameraEventStateStore({ filePath: 'memory-camera-event-state.json', readState, writeState, ...options }) };
};

test('eventi camera persistenti stabiliscono baseline, deduplicano e fanno ACK senza rete', async () => {
  let now = 1_000_000;
  const { storage, store } = await storeFor({ now: () => now });
  {
    const a = clip(10, 20, 1); const b = clip(30, 40, 2); const c = clip(50, 60, 1);
    assert.equal(cameraEventIdentity(a), '10-20-1');
    assert.equal(cameraEventIdentity({ ...a, vedio_type: 2 }), '10-20-2');
    assert.deepEqual(await store.observe('C1', [a, b]), { unreadCount: 0, active: false, version: null });
    assert.equal((await store.observe('C1', [a, b])).unreadCount, 0);
    assert.equal((await store.observe('C1', [a, b, c, c])).unreadCount, 1);
    const d = clip(70, 80); const e = clip(90, 100); const f = clip(110, 120);
    assert.equal((await store.observe('C1', [a, b, c, d])).unreadCount, 2);
    assert.equal((await store.observe('C1', [a, b, c, d])).unreadCount, 2);
    assert.equal((await store.observe('C1', [a, b, c, d, e])).unreadCount, 3);
    assert.equal((await store.observe('C1', [a, b, c, d, e, f])).unreadCount, 4);
    assert.equal((await store.acknowledge('C1')).unreadCount, 0);
    assert.equal((await store.observe('C1', [a, b, c])).unreadCount, 0);
    const afterAck = await store.observe('C1', [a, b, c, d, e, f, clip(130, 140)]);
    assert.equal(afterAck.unreadCount, 1); assert.equal(afterAck.active, true);
    assert.equal((await store.observe('C2', [a])).unreadCount, 0);
    assert.equal((await store.observe('C2', [a, b])).unreadCount, 1);
    const restored = new CameraEventStateStore({ filePath: 'memory-camera-event-state.json', now: () => now, ...storage });
    assert.equal((await restored.summaries()).C1.unreadCount, 1);
    assert.equal((await restored.summaries()).C2.unreadCount, 1);
  }
});

test('retention elimina soltanto eventi già ACK, mai unread', async () => {
  let now = 1_000_000;
  const { store } = await storeFor({ now: () => now, retentionMs: 100 });
  {
    const old = clip(10, 20); const unread = clip(30, 40); const later = clip(50, 60);
    await store.observe('C1', [old]);
    await store.observe('C1', [old, unread]);
    now += 101;
    await store.observe('C1', [later]);
    const state = (await store.read()).cameras.C1;
    assert.equal(Object.hasOwn(state.known, cameraEventIdentity(old)), false);
    assert.equal(Object.hasOwn(state.unread, cameraEventIdentity(unread)), true);
  }
});

test('la telemetria Live usa soltanto recordings già ricevuti e non crea letture aggiuntive', async () => {
  const { store } = await storeFor({ now: () => 1_000_000 });
  let telemetryCalls = 0; let eventReads = 0;
  const runtime = new HomeCameraRuntime({
    root: process.cwd(),
    hardwareStore: { read: async () => ({ devices: [] }) },
    roleStore: { read: async () => ({}) },
    eventStateStore: store,
    now: () => 1_000_000,
    readTelemetry: async () => { telemetryCalls += 1; return { recordings: { available: true, clips: [clip(10, 20)] }, telemetryUpdatedAt: new Date().toISOString() }; },
    readEvents: async () => { eventReads += 1; return { available: true, events: [] }; },
  });
  {
    await runtime.refreshTelemetryForLive({ id: 'camera-c1', connection: { ip: '192.0.2.10' } }, 'C1');
    assert.equal(telemetryCalls, 1);
    assert.equal(eventReads, 0);
    assert.deepEqual(runtime.getCameraEventAlerts().C1, { active: false, version: null, unreadCount: 0 });
    runtime.readTelemetry = async () => ({ recordings: { available: true, clips: [clip(10, 20), clip(30, 40)] }, telemetryUpdatedAt: new Date().toISOString() });
    await runtime.refreshTelemetryForLive({ id: 'camera-c1', connection: { ip: '192.0.2.10' } }, 'C1');
    assert.equal(runtime.getCameraEventAlerts().C1.unreadCount, 1);
    assert.equal((await runtime.acknowledgeCameraEvents('C1')).unread, 0);
    assert.equal(runtime.getCameraEventAlerts().C1.active, false);
    assert.equal(eventReads, 0);
  } await runtime.close();
});
