import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createHomeControlServer } from '../server.js';
import { HomeWt200Runtime, mergeWt200Snapshots } from '../src/wt200-runtime.js';

const schedule = {
  weekPattern: '5+2',
  weekPatternRaw: '1',
  normalPeriods: Array.from({ length: 6 }, (_, hour) => ({ hour, minute: 0, unknownByte: 0, temperature: 2 })),
  restDayPeriods: Array.from({ length: 2 }, (_, hour) => ({ hour, minute: 0, unknownByte: 0, temperature: 1.5 })),
  raw: 'fixture-base64',
};
const SCHEDULE_RAW = 'BgAAFAgAAA8LEgAPDRwADxEAABYWAAAPBgAAFBYAAA8=';
const UPDATED_SCHEDULE_RAW = 'BgAAFAgAAA8LEgAPDR4ADxEAABYWAAAPBgAAFBYAAA8=';

const cloudSnapshot = {
  deviceId: 'wt200-cloud-id',
  online: true,
  name: 'Temp-3',
  category: 'wk',
  thermostat: { currentTemperature: 27.8, setpointTemperature: 31.5 },
  rawDatapoints: [{ code: 'temp_current', value: 278 }],
  updatedAt: '2026-09-07T10:00:00.000Z',
};

test('unisce dati Cloud esistenti e dati LAN verificati', () => {
  const merged = mergeWt200Snapshots({
    cloudSnapshot,
    lanSnapshot: { deviceId: 'wt200-lan-id', heatingActive: true, rawDps: { 5: '1', 107: '1' }, schedule },
  });
  assert.equal(merged.thermostat.currentTemperature, 27.8);
  assert.equal(merged.heatingActive, true);
  assert.deepEqual(merged.rawDps, { 5: '1', 107: '1' });
  assert.equal(merged.schedule, schedule);
});

test('LAN senza DP105 conserva lo schedule persistito', () => {
  const merged = mergeWt200Snapshots({
    lanSnapshot: { deviceId: 'wt200-lan-id', heatingActive: false, rawDps: { 5: '0', 107: '1' }, schedule: null },
    persistedSchedule: { deviceId: 'wt200-lan-id', schedule, updatedAt: '2026-09-07T11:00:00.000Z' },
  });
  assert.equal(merged.online, true);
  assert.equal(merged.heatingActive, false);
  assert.equal(merged.schedule, schedule);
});

test('Cloud valido e schedule persistito restano disponibili se la LAN cade', async () => {
  const runtime = new HomeWt200Runtime({
    cloudAdapter: { async read() { return cloudSnapshot; } },
    lanAdapter: { async read() { throw new Error('LAN disconnected'); } },
    scheduleStore: { async read() { return { deviceId: cloudSnapshot.deviceId, schedule, updatedAt: '2026-09-07T11:00:00.000Z' }; } },
  });
  const result = await runtime.readSnapshot();
  assert.equal(result.online, true);
  assert.equal(result.thermostat.currentTemperature, 27.8);
  assert.equal(result.thermostat.setpointTemperature, 31.5);
  assert.equal(result.heatingActive, null);
  assert.equal(result.schedule.raw, schedule.raw);
});

test('ultimo Cloud valido resta disponibile se LAN e Cloud falliscono nel recovery', async () => {
  let cloudReads = 0;
  const runtime = new HomeWt200Runtime({
    cloudAdapter: { async read() { if (cloudReads++ === 0) return cloudSnapshot; throw new Error('Cloud unavailable'); } },
    lanAdapter: { async read() { throw new Error('LAN disconnected'); } },
    scheduleStore: { async read() { return { deviceId: cloudSnapshot.deviceId, schedule, updatedAt: null }; } },
  });
  await runtime.readSnapshot();
  const recovered = await runtime.readSnapshot();
  assert.equal(recovered.online, true);
  assert.equal(recovered.thermostat.currentTemperature, 27.8);
  assert.equal(recovered.schedule.raw, schedule.raw);
});

test('runtime persiste DP105 e lo conserva dopo status LAN senza DP105', async () => {
  const listeners = new Map();
  const saved = [];
  const lanAdapter = {
    deviceId: 'wt200-lan-id',
    rawDps: { 5: '0', 107: '1' },
    scheduleRaw: null,
    device: { on(event, listener) { listeners.set(event, listener); } },
    async connect() {},
    async read() { return { deviceId: 'wt200-lan-id', heatingActive: false, rawDps: this.rawDps, schedule: null }; },
  };
  const runtime = new HomeWt200Runtime({
    lanAdapter,
    scheduleStore: {
      async read() { return null; },
      async write(value) { saved.push(value); return value; },
    },
  });
  const before = await runtime.readSnapshot();
  assert.equal(before.schedule, null);

  lanAdapter.scheduleRaw = SCHEDULE_RAW;
  lanAdapter.rawDps['105'] = SCHEDULE_RAW;
  listeners.get('dp-refresh')({ dps: { 105: SCHEDULE_RAW } });
  await runtime.persistenceQueue;
  assert.equal(saved.length, 1);
  const afterStatusWithoutDp105 = await runtime.readSnapshot();
  assert.equal(afterStatusWithoutDp105.schedule.raw, SCHEDULE_RAW);

  lanAdapter.scheduleRaw = UPDATED_SCHEDULE_RAW;
  lanAdapter.rawDps['105'] = UPDATED_SCHEDULE_RAW;
  listeners.get('data')({ dps: { 105: UPDATED_SCHEDULE_RAW } });
  await runtime.persistenceQueue;
  assert.equal(saved.length, 2);
  assert.equal(saved[1].schedule.raw, UPDATED_SCHEDULE_RAW);
});

test('GET /api/thermostat restituisce il runtime WT200 iniettato', async () => {
  const snapshot = { ...cloudSnapshot, heatingActive: null, rawDps: null, schedule: null };
  const server = createHomeControlServer({
    thermostatRuntime: { async readSnapshot() { return snapshot; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/thermostat`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('runtime persiste lo schedule soltanto dopo write DP105 riuscito', async () => {
  const saved = [];
  const lanAdapter = {
    deviceId: 'wt200-lan-id', rawDps: { 107: '1' }, scheduleRaw: SCHEDULE_RAW,
    async writeSchedule(value) { this.scheduleRaw = UPDATED_SCHEDULE_RAW; return { deviceId: this.deviceId, rawDps: this.rawDps, schedule: { ...schedule, ...value, raw: UPDATED_SCHEDULE_RAW } }; },
  };
  const runtime = new HomeWt200Runtime({ lanAdapter, scheduleStore: { async read() { return { schedule }; }, async write(value) { saved.push(value); return value; } } });
  const result = await runtime.updateSchedule({ normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods });
  assert.equal(result.raw, UPDATED_SCHEDULE_RAW);
  assert.equal(saved.length, 1);
});

test('schedule appena scritta resta disponibile se la LAN cade dopo il write', async () => {
  const saved = [];
  const lanAdapter = {
    deviceId: 'wt200-lan-id', rawDps: { 107: '1' }, scheduleRaw: SCHEDULE_RAW,
    async writeSchedule(value) { this.scheduleRaw = UPDATED_SCHEDULE_RAW; return { schedule: { ...schedule, ...value, raw: UPDATED_SCHEDULE_RAW } }; },
    async read() { throw new Error('LAN disconnected'); },
  };
  const runtime = new HomeWt200Runtime({
    cloudAdapter: { async read() { return cloudSnapshot; } }, lanAdapter,
    scheduleStore: { async read() { return { schedule }; }, async write(value) { saved.push(value); return value; } },
  });
  await runtime.updateSchedule({ normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods });
  const afterDisconnect = await runtime.readSnapshot();
  assert.equal(saved.at(-1).schedule.raw, UPDATED_SCHEDULE_RAW);
  assert.equal(afterDisconnect.online, true);
  assert.equal(afterDisconnect.schedule.raw, UPDATED_SCHEDULE_RAW);
});

test('PUT schedule valida il payload e inoltra un solo salvataggio', async () => {
  let calls = 0;
  const server = createHomeControlServer({ thermostatRuntime: { async updateSchedule(value) { calls += 1; return { ...schedule, ...value }; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const invalid = await fetch(`http://127.0.0.1:${port}/api/thermostat/schedule`, { method: 'PUT', body: '{}' });
    assert.equal(invalid.status, 400);
    const valid = await fetch(`http://127.0.0.1:${port}/api/thermostat/schedule`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods }),
    });
    assert.equal(valid.status, 200);
    assert.equal(calls, 1);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('PUT mode accetta manual e rifiuta valori arbitrari', async () => {
  let mode = null;
  const server = createHomeControlServer({ thermostatRuntime: { async setMode(value) { mode = value; return value; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const invalid = await fetch(`http://127.0.0.1:${port}/api/thermostat/mode`, { method: 'PUT', body: JSON.stringify({ mode: 'smart' }) });
    assert.equal(invalid.status, 400);
    const valid = await fetch(`http://127.0.0.1:${port}/api/thermostat/mode`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'manual' }) });
    assert.equal(valid.status, 200);
    assert.equal(mode, 'manual');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
