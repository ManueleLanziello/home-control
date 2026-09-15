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

test('unisce le misure LAN e la programmazione verificata', () => {
  const merged = mergeWt200Snapshots({
    lanSnapshot: { deviceId: 'wt200-lan-id', heatingActive: true, thermostat: { currentTemperature: 25.9, setpointTemperature: 5.5, mode: 'manual' }, rawDps: { 5: '1', 107: '1' }, schedule },
  });
  assert.equal(merged.thermostat.currentTemperature, 25.9);
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

test('schedule persistito resta disponibile ma il WT200 e offline se la LAN cade', async () => {
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async read() { throw new Error('LAN disconnected'); } },
    scheduleStore: { async read() { return { deviceId: cloudSnapshot.deviceId, schedule, updatedAt: '2026-09-07T11:00:00.000Z' }; } },
  });
  const result = await runtime.readSnapshot();
  assert.equal(result.online, false);
  assert.equal(result.thermostat.currentTemperature, undefined);
  assert.equal(result.thermostat.setpointTemperature, undefined);
  assert.equal(result.heatingActive, null);
  assert.equal(result.schedule.raw, schedule.raw);
});

test('letture LAN precedenti non tornano online se la LAN fallisce', async () => {
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async read() { throw new Error('LAN disconnected'); } },
    scheduleStore: { async read() { return { deviceId: cloudSnapshot.deviceId, schedule, updatedAt: null }; } },
  });
  const recovered = await runtime.readSnapshot();
  assert.equal(recovered.online, false);
  assert.equal(recovered.thermostat.currentTemperature, undefined);
  assert.equal(recovered.schedule.raw, schedule.raw);
});

test('setpoint usa read-back LAN reali e restituisce soltanto lo stato WT200 stabilizzato', async () => {
  const calls = [];
  const updatedAt = '2026-09-07T10:00:00.000Z';
  const snapshots = [
    { updatedAt, heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 19, mode: 'manual' } },
    { updatedAt, heatingActive: true, thermostat: { currentTemperature: 20, setpointTemperature: 21, mode: 'manual' } },
    { updatedAt, heatingActive: true, thermostat: { currentTemperature: 20, setpointTemperature: 21, mode: 'manual' } },
    { updatedAt, heatingActive: true, thermostat: { currentTemperature: 20, setpointTemperature: 21, mode: 'manual' } },
  ];
  const runtime = new HomeWt200Runtime({
    lanAdapter: {
      async setSetpointTemperature(value) { calls.push(['write', value]); },
      async read() { calls.push(['read']); return snapshots.shift(); },
    },
    postWriteReadbackDelayMs: 0,
    wait: async () => {},
  });

  const confirmed = await runtime.setSetpointTemperature(21);
  assert.deepEqual(calls, [['write', 21], ['read'], ['read'], ['read'], ['read']]);
  assert.equal(confirmed.thermostat.setpointTemperature, 21);
  assert.equal(confirmed.thermostat.currentTemperature, 20);
  assert.equal(confirmed.thermostat.mode, 'manual');
  assert.equal(confirmed.heatingActive, true);
  assert.equal(confirmed.cloudUpdatedAt, null);
});

test('setpoint non confermato espone l ultimo snapshot LAN reale per il rollback UI', async () => {
  const actual = { updatedAt: '2026-09-07T10:00:00.000Z', heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 19, mode: 'manual' } };
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setSetpointTemperature() {}, async read() { return actual; } },
    postWriteReadbackAttempts: 2,
    postWriteReadbackDelayMs: 0,
    wait: async () => {},
  });

  await assert.rejects(runtime.setSetpointTemperature(21), error => {
    assert.equal(error.code, 'SETPOINT_NOT_CONFIRMED');
    assert.equal(error.snapshot.thermostat.setpointTemperature, 19);
    assert.equal(error.snapshot.heatingActive, false);
    return true;
  });
});

test('setpoint non usa una conferma DP2 precedente se l ultima lettura LAN torna al valore vecchio', async () => {
  const snapshot = (rawSetpoint) => ({
    updatedAt: '2026-09-15T10:00:00.000Z',
    heatingActive: false,
    thermostat: { currentTemperature: 25.9, setpointTemperature: rawSetpoint / 10, mode: 'manual' },
  });
  const snapshots = [snapshot(55), snapshot(220), snapshot(55), snapshot(55), snapshot(55)];
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setSetpointTemperature() {}, async read() { return snapshots.shift(); } },
    postWriteReadbackAttempts: 5,
    postWriteReadbackDelayMs: 0,
    wait: async () => {},
  });

  await assert.rejects(runtime.setSetpointTemperature(22), error => {
    assert.equal(error.code, 'SETPOINT_NOT_CONFIRMED');
    assert.equal(error.snapshot.thermostat.setpointTemperature, 5.5);
    return true;
  });
});

test('setpoint viene confermato sulla stabilita DP2 anche se DP3 oscilla', async () => {
  const snapshots = [25.9, 26, 25.9].map(currentTemperature => ({
    updatedAt: '2026-09-15T10:00:00.000Z',
    heatingActive: false,
    thermostat: { currentTemperature, setpointTemperature: 22, mode: 'manual' },
  }));
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setSetpointTemperature() {}, async read() { return snapshots.shift(); } },
    postWriteReadbackAttempts: 3,
    postWriteReadbackDelayMs: 0,
    wait: async () => {},
  });

  const confirmed = await runtime.setSetpointTemperature(22);
  assert.equal(confirmed.thermostat.setpointTemperature, 22);
  assert.equal(confirmed.thermostat.currentTemperature, 25.9);
});

test('mutazioni DP2 e DP4 sono serializzate per l intera transazione write e conferma', async () => {
  const calls = [];
  let releaseSetpointWrite;
  const setpointWriteBlocked = new Promise(resolve => { releaseSetpointWrite = resolve; });
  const setpointSnapshot = { heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 22, mode: 'manual' } };
  const modeSnapshot = { heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 22, mode: 'auto' } };
  let modeStarted = false;
  const runtime = new HomeWt200Runtime({
    lanAdapter: {
      async setSetpointTemperature() { calls.push('setpoint-write'); await setpointWriteBlocked; },
      async setOperatingMode() { modeStarted = true; calls.push('mode-write'); },
      async read() { calls.push('read'); return modeStarted ? modeSnapshot : setpointSnapshot; },
    },
    postWriteReadbackAttempts: 3,
    postWriteReadbackDelayMs: 0,
    wait: async () => {},
  });

  const setpointCommand = runtime.setSetpointTemperature(22);
  const modeCommand = runtime.setMode('auto');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ['setpoint-write']);
  releaseSetpointWrite();
  await Promise.all([setpointCommand, modeCommand]);
  assert.deepEqual(calls, ['setpoint-write', 'read', 'read', 'read', 'mode-write', 'read', 'read', 'read']);
});

test('MANUALE verso AUTO attende DP4 reale e restituisce DP2, DP3 e DP5 completi', async () => {
  const calls = [];
  const updatedAt = '2026-09-15T10:00:00.000Z';
  const manual = { updatedAt, heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 20, mode: 'manual' } };
  const automatic = { updatedAt, heatingActive: true, thermostat: { currentTemperature: 20.5, setpointTemperature: 22, mode: 'auto' } };
  const snapshots = [manual, automatic, automatic, automatic];
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setOperatingMode(value) { calls.push(['write', value]); }, async read() { calls.push(['read']); return snapshots.shift(); } },
    postWriteReadbackAttempts: 4, postWriteReadbackDelayMs: 0, wait: async () => {},
  });
  const confirmed = await runtime.setMode('auto');
  assert.deepEqual(calls, [['write', 'auto'], ['read'], ['read'], ['read'], ['read']]);
  assert.deepEqual(confirmed.thermostat, automatic.thermostat);
  assert.equal(confirmed.heatingActive, true);
});

test('AUTO verso MANUALE attende DP4 reale e conserva DP2, DP3 e DP5 completi', async () => {
  const calls = [];
  const updatedAt = '2026-09-15T10:00:00.000Z';
  const automatic = { updatedAt, heatingActive: true, thermostat: { currentTemperature: 20.5, setpointTemperature: 22, mode: 'auto' } };
  const manual = { updatedAt, heatingActive: false, thermostat: { currentTemperature: 20, setpointTemperature: 19, mode: 'manual' } };
  const snapshots = [automatic, manual, manual, manual];
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setOperatingMode(value) { calls.push(['write', value]); }, async read() { calls.push(['read']); return snapshots.shift(); } },
    postWriteReadbackAttempts: 4, postWriteReadbackDelayMs: 0, wait: async () => {},
  });
  const confirmed = await runtime.setMode('manual');
  assert.deepEqual(calls, [['write', 'home'], ['read'], ['read'], ['read'], ['read']]);
  assert.deepEqual(confirmed.thermostat, manual.thermostat);
  assert.equal(confirmed.heatingActive, false);
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

test('runtime rende subito disponibile ai subscriber un evento LAN con DP5 reale', () => {
  let publishAdapterState;
  const runtime = new HomeWt200Runtime({
    deviceId: 'wt200-lan-id',
    lanAdapter: {
      subscribeState(listener) { publishAdapterState = listener; },
    },
  });
  let received;
  runtime.subscribeState(snapshot => { received = snapshot; });
  publishAdapterState({
    deviceId: 'wt200-lan-id', updatedAt: '2026-09-15T10:00:00.000Z', heatingActive: true,
    thermostat: { currentTemperature: 25.9, setpointTemperature: 22, mode: 'manual' },
  }, { changedDps: { 5: '1' } });
  assert.equal(received.heatingActive, true);
  assert.equal(received.thermostat.currentTemperature, 25.9);
  assert.equal(received.thermostat.setpointTemperature, 22);
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
    const payload = await response.json();
    // This fixture is stale: no measurements or physical datapoints may reach the UI.
    assert.equal(payload.online, false);
    assert.equal(payload.thermostat.currentTemperature, null);
    assert.equal(payload.thermostat.setpointTemperature, null);
    assert.equal(payload.updatedAt, snapshot.updatedAt);
    assert.equal(payload.deviceId, 'thermostat');
    assert.equal(Object.hasOwn(payload, 'rawDatapoints'), false);
    assert.equal(Object.hasOwn(payload, 'rawDps'), false);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('GET /api/thermostat/live esegue ogni volta una lettura runtime LAN non cached', async () => {
  let reads = 0;
  const server = createHomeControlServer({
    thermostatRuntime: {
      subscribeState() {},
      async readSnapshot() {
        reads += 1;
        const updatedAt = new Date().toISOString();
        return { online: true, lanUpdatedAt: updatedAt, updatedAt, heatingActive: reads === 2,
          thermostat: { currentTemperature: 25.9, setpointTemperature: 22, mode: 'manual' } };
      },
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const first = await (await fetch(`http://127.0.0.1:${port}/api/thermostat/live`)).json();
    const second = await (await fetch(`http://127.0.0.1:${port}/api/thermostat/live`)).json();
    assert.equal(reads, 2);
    assert.equal(first.heatingActive, false);
    assert.equal(second.heatingActive, true);
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
    lanAdapter,
    scheduleStore: { async read() { return { schedule }; }, async write(value) { saved.push(value); return value; } },
  });
  await runtime.updateSchedule({ normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods });
  const afterDisconnect = await runtime.readSnapshot();
  assert.equal(saved.at(-1).schedule.raw, UPDATED_SCHEDULE_RAW);
  assert.equal(afterDisconnect.online, false);
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

test('PUT setpoint restituisce lo snapshot LAN completo confermato', async () => {
  const confirmed = { online: true, lanUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), heatingActive: true,
    thermostat: { currentTemperature: 20, setpointTemperature: 21, mode: 'manual' } };
  const server = createHomeControlServer({ thermostatRuntime: {
    async setSetpointTemperature(value) { assert.equal(value, 21); return confirmed; },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/thermostat/setpoint`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ temperature: 21 }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.snapshot.thermostat.setpointTemperature, 21);
    assert.equal(payload.snapshot.thermostat.currentTemperature, 20);
    assert.equal(payload.snapshot.thermostat.mode, 'manual');
    assert.equal(payload.snapshot.heatingActive, true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('runtime usa esclusivamente il canale LAN e persiste solo dopo conferma DP105', async () => {
  const saved = [];
  const lanAdapter = {
    async writeSchedule(value) {
      assert.equal(value.weekPattern, '7');
      assert.equal(value.restDayPeriods, undefined);
      return { deviceId: 'wt200-lan-id', schedule: { ...schedule, weekPattern: '7', weekPatternRaw: '3' }, updatedAt: '2026-09-10T10:00:00.000Z' };
    },
  };
  const runtime = new HomeWt200Runtime({
    lanAdapter,
    scheduleStore: { async read() { return { schedule: { ...schedule, weekPattern: '7' } }; }, async write(value) { saved.push(value); return value; } },
  });
  const result = await runtime.updateSchedule({ weekPattern: '7', normalPeriods: schedule.normalPeriods });
  assert.equal(result.weekPattern, '7');
  assert.equal(saved.length, 1);
});

test('PUT week-pattern accetta 5+2, 6+1, 7 e blocca Chiuso/arbitrari', async () => {
  const calls = [];
  const server = createHomeControlServer({ thermostatRuntime: {
    async setWeekPattern(value) { calls.push(value); return { ...schedule, weekPattern: value }; },
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    for (const weekPattern of ['5+2', '6+1', '7']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/thermostat/week-pattern`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekPattern }),
      });
      assert.equal(response.status, 200);
    }
    for (const weekPattern of ['Chiuso', '0', '8']) {
      const response = await fetch(`http://127.0.0.1:${port}/api/thermostat/week-pattern`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weekPattern }),
      });
      assert.equal(response.status, 400);
    }
    assert.deepEqual(calls, ['5+2', '6+1', '7']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('PUT schedule valida il payload in modo specifico per 5+2, 6+1 e 7', async () => {
  const calls = [];
  const server = createHomeControlServer({ thermostatRuntime: { async updateSchedule(value) { calls.push(value); return { ...schedule, ...value }; } } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const put = (body) => fetch(`http://127.0.0.1:${port}/api/thermostat/schedule`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal((await put({ weekPattern: '5+2', normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods })).status, 200);
    assert.equal((await put({ weekPattern: '6+1', normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods })).status, 200);
    assert.equal((await put({ weekPattern: '7', normalPeriods: schedule.normalPeriods })).status, 200);
    assert.equal((await put({ weekPattern: '6+1', normalPeriods: schedule.normalPeriods })).status, 400);
    assert.equal((await put({ weekPattern: 'Chiuso', normalPeriods: schedule.normalPeriods, restDayPeriods: schedule.restDayPeriods })).status, 400);
    assert.equal(calls.length, 3);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
