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
