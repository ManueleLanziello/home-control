import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { readCameraTelemetry } from '../src/camera-telemetry.js';
import { HomeCameraRuntime } from '../src/camera-runtime.js';
import { countRecentRecordings, normalizeCameraTelemetry, recordingDatesForWindow } from '../src/camera-telemetry.js';

function executionFixture(updates, payload, fail) {
  let calls = 0;
  const execute = (python, args, options) => {
    calls += 1;
    assert.equal(options.timeout, 8000);
    const stderr = new EventEmitter();
    const promise = new Promise((resolve, reject) => queueMicrotask(() => {
      for (const update of updates) {
        const line = '[CAM-RESULT] ' + JSON.stringify(update) + '\n';
        stderr.emit('data', Buffer.from(line.slice(0, 7)));
        stderr.emit('data', Buffer.from(line.slice(7)));
      }
      if (fail) reject(Object.assign(Error('timeout'), { killed: true }));
      else resolve({ stdout: JSON.stringify(payload) });
    }));
    promise.child = { stderr };
    return promise;
  };
  return { execute, calls: () => calls };
}

const successful = [
  { battery: { available: true, percent: 34, chargingState: 'off' } },
  { privacy: { available: true, enabled: 'off' } },
  { detection: { available: true, enabled: 'on' } },
  { alarm: { available: true, enabled: 'off' } },
  { battery: { available: true, percent: 34, chargingState: 'off', statisticChargingState: 'normal' } },
  { recordings: { available: true, clips: [] } },
];

test('full telemetry keeps final JSON semantics and timeout preserves only completed fields', async () => {
  for (const count of [1, 2, 4, 5]) {
    const f = executionFixture(successful.slice(0, count), null, true);
    const progress = [];
    const value = await readCameraTelemetry({ ip: 'fixture', root: '.', timeoutMs: 8000, execute: f.execute, onPartial: x => progress.push(x) });
    assert.equal(f.calls(), 1); assert.equal(progress.length, count);
    if (count >= 2) assert.equal(Object.hasOwn(progress[1], 'battery'), false);
    if (count >= 4) assert.equal(Object.hasOwn(progress[3], 'privacy'), false);
    assert.equal(value.battery.percent, 34);
    assert.equal(value.events.available, false);
    assert.equal(value.privacy.enabled, count >= 2 ? false : null);
    assert.equal(value.detection, count >= 3 ? true : null);
    assert.equal(value.alarm.enabled, count >= 4 ? false : null);
    assert.equal(value.telemetryOutcome, 'TIMEOUT');
  }
  const payload = Object.assign({}, ...successful, { alarm: { available: true, enabled: 'off' } });
  const full = executionFixture(successful, payload, false);
  const now = Date.now();
  assert.deepEqual(await readCameraTelemetry({ ip: 'fixture', root: '.', now, timeoutMs: 8000, execute: full.execute }), { ...normalizeCameraTelemetry(payload, now), recordings: payload.recordings });
  const empty = executionFixture([], null, true);
  await assert.rejects(readCameraTelemetry({ ip: 'fixture', root: '.', timeoutMs: 8000, execute: empty.execute }));
  assert.equal(empty.calls(), 1);
});

test('Live succeeds and progressive cache survives later telemetry failure without retries', async () => {
  let starts = 0, reads = 0;
  const record = { id: 'fixture', connection: { ip: 'fixture' }, metadata: { adapter: 'tapo-c410-owned' } };
  const runtime = new HomeCameraRuntime({ root: '.', readTelemetry: async options => {
    reads += 1; assert.equal(options.timeoutMs, 8000);
    options.onPartial(normalizeCameraTelemetry(successful[0]));
    assert.equal(runtime.telemetryFor(record).battery.percent, 34);
    throw Object.assign(Error('timeout'), { killed: true });
  } });
  runtime.reconcile = async () => ({ registry: { devices: [record] }, assignments: { fixture: 'camera_pond' } });
  runtime.owned = { has: () => true, start: async () => { starts += 1; } };
  runtime.snapshot = async () => ({ C2: runtime.telemetryFor(record) });
  assert.equal((await runtime.setLive('C2', true)).battery.percent, 34);
  assert.equal(starts, 1); assert.equal(reads, 1);
  assert.equal(runtime.telemetryFor(record).alarm.enabled, null);
});

test('last-known alarm is not reconfirmed and final JSON does not retimestamp progressive controls', async () => {
  let now = 1000;
  const record = { id: 'fixture', connection: { ip: 'fixture' } };
  const runtime = new HomeCameraRuntime({ root: '.', now: () => now, readTelemetry: async ({ onPartial }) => {
    now = 2000;
    onPartial({ privacy: { available: true, enabled: false }, telemetryUpdatedAt: new Date(now).toISOString() });
    now = 3000;
    onPartial({ detection: true, telemetryUpdatedAt: new Date(now).toISOString() });
    assert.equal(runtime.telemetryCache.get(record.id).controlUpdatedAt.privacy, 2000);
    now = 4000;
    return { ...normalizeCameraTelemetry({ privacy: { available: true, enabled: 'off' }, detection: { available: true, enabled: 'on' } }, now), telemetryOutcome: 'TIMEOUT' };
  } });
  runtime.cacheControl(record, { alarm: { available: true, enabled: false } });
  await runtime.refreshTelemetryForLive(record);
  const cached = runtime.telemetryCache.get(record.id);
  assert.equal(cached.value.alarm.enabled, false);
  assert.equal(cached.controlUpdatedAt.alarm, 1000);
  assert.equal(cached.controlUpdatedAt.privacy, 2000);
  assert.equal(cached.controlUpdatedAt.detection, 3000);
});

test('Live retains the 8 second telemetry budget and a single read', async () => {
  const runtime = await readFile(new URL('../src/camera-runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, /cameraProbeTimeoutMs = 8_000/);
  assert.equal((runtime.match(/await this\.readTelemetry\(/g) || []).length, 1);
});

test('finestra eventi interroga uno o due giorni locali quando attraversa mezzanotte', () => {
  const midday = new Date(2026, 8, 22, 15, 0, 0).getTime();
  const morning = new Date(2026, 8, 22, 8, 0, 0).getTime();
  assert.deepEqual(recordingDatesForWindow(midday), ['20260922']);
  assert.deepEqual(recordingDatesForWindow(morning), ['20260921', '20260922']);
});

test('conteggio clip usa startTime nelle ultime 12 ore e rimuove duplicati', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
  const seconds = value => Math.floor(value / 1000);
  const clips = [
    { startTime: seconds(now - 12 * 60 * 60 * 1000), endTime: 1, vedio_type: 2 },
    { startTime: seconds(now - 60 * 60 * 1000), endTime: 2, vedio_type: 2 },
    { startTime: seconds(now - 60 * 60 * 1000), endTime: 2, vedio_type: 2 },
    { startTime: seconds(now - 13 * 60 * 60 * 1000), endTime: 3, vedio_type: 2 },
    { startTime: seconds(now + 60 * 1000), endTime: 4, vedio_type: 2 },
  ];
  assert.equal(countRecentRecordings(clips, now), 2);
});

test('normalizzazione espone solo batteria/carica e conteggio eventi utili alla UI', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
  const telemetry = normalizeCameraTelemetry({
    battery: { available: true, percent: 104, chargingState: 'NORMAL', statisticChargingState: 'charging' },
    recordings: { available: true, clips: [{ startTime: Math.floor((now - 1000) / 1000), endTime: 7, vedio_type: 2 }] },
    detection: { available: true, enabled: 'on' },
    alarm: { available: true, enabled: 'off' },
  }, now);
  assert.deepEqual(telemetry.battery, { available: true, percent: 100, charging: false });
  assert.deepEqual(telemetry.events, { available: true, count: 1, windowHours: 12 });
  assert.equal(telemetry.detection, true);
  assert.deepEqual(telemetry.alarm, { available: true, enabled: false });
  assert.equal(telemetry.telemetryUpdatedAt, '2026-09-22T10:00:00.000Z');
});
