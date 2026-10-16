import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlarmSimulationStore } from '../src/alarm-simulation.js';

const fixture = async () => { let now = 1_000_000; const directory = await mkdtemp(path.join(os.tmpdir(), 'home-alarm-')); const filePath = path.join(directory, 'alarm.json'); return { filePath, setNow: value => { now = value; }, store: new AlarmSimulationStore({ filePath, now: () => now }) }; };

test('partial arming refuses opened and unavailable door sensors', async () => {
  const { store } = await fixture();
  await store.simulate({ sensors: { DW2: { closed: false }, DW3: { available: false } } });
  await assert.rejects(store.selectMode('partial'), error => error.blocked.includes('DW2') && error.blocked.includes('DW3'));
});

test('complete mode uses an absolute arming timestamp and survives a new store', async () => {
  const { store, setNow } = await fixture();
  await store.setSettings({ armingMinutes: 1, delayMinutes: 1 });
  const arming = await store.selectMode('complete'); assert.equal(arming.armingUntil, 1_060_000);
  setNow(1_060_001); const armed = await store.read(); assert.equal(armed.mode, 'complete'); assert.equal(armed.armingUntil, null);
});

test('DW1 is an exit door during complete arming but must be closed at expiry', async () => {
  const { store, setNow } = await fixture();
  await store.simulate({ sensors: { DW1: { closed: false } } }); let state = await store.selectMode('complete');
  assert.equal(state.armingUntil, 1_060_000); assert.equal(state.armingError, null);
  state = await store.simulate({ sensors: { DW1: { closed: true } } }); assert.equal(state.armingUntil, 1_060_000);
  setNow(1_060_000); state = await store.read(); assert.equal(state.mode, 'complete');
  await store.selectMode('none'); await store.simulate({ sensors: { DW1: { closed: false } } }); state = await store.selectMode('complete');
  setNow(state.armingUntil); state = await store.read(); assert.equal(state.mode, 'none'); assert.deepEqual(state.armingError, ['DW1']);
  state = await store.simulate({ sensors: { DW1: { closed: true } } }); assert.equal(state.mode, 'none'); assert.equal(state.armingUntil, null);
});

test('partial still refuses DW1 and DW1 starts the configured delay after complete arming', async () => {
  const { store, setNow } = await fixture();
  await store.simulate({ sensors: { DW1: { closed: false } } }); await assert.rejects(store.selectMode('partial'), error => error.blocked.includes('DW1'));
  await store.selectMode('complete'); await store.simulate({ sensors: { DW1: { closed: true } } }); setNow(1_060_000); await store.read();
  let state = await store.simulate({ sensors: { DW1: { closed: false } } }); assert.equal(state.intrusion.sensorId, 'DW1'); assert.equal(state.intrusion.active, false);
  state = await store.selectMode('none'); assert.equal(state.intrusion, null); assert.equal(state.sensors.SR1.active, false);
});

test('partial ignores motion while complete arms PR1 only after an observed idle state', async () => {
  const { store, setNow } = await fixture();
  await store.selectMode('partial'); let state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion, null);
  await store.selectMode('none'); await store.selectMode('complete');
  state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion, null); assert.equal(state.armingUntil, 1_060_000);
  setNow(1_060_000); state = await store.read(); assert.equal(state.mode, 'complete'); assert.equal(state.pr1Ready, false); assert.equal(state.intrusion, null);
  state = await store.simulate({ sensors: { PR1: { motion: false } } }); assert.equal(state.pr1Ready, true); assert.equal(state.intrusion, null);
  state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion.sensorId, 'PR1');
});

test('PR1 remains excluded while unavailable and during the complete arming countdown', async () => {
  const { store, setNow } = await fixture();
  await store.simulate({ sensors: { PR1: { available: false, motion: true } } }); await store.selectMode('complete');
  let state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion, null);
  setNow(1_060_000); state = await store.read(); assert.equal(state.pr1Ready, false); assert.equal(state.intrusion, null);
  state = await store.simulate({ sensors: { PR1: { available: true, motion: false } } }); assert.equal(state.pr1Ready, true);
});

test('keeps the first intrusion sensor, adds later sensors once, and persists them after refresh', async () => {
  const { store, filePath } = await fixture();
  await store.selectMode('partial'); let state = await store.simulate({ sensors: { DW1: { closed: false } } });
  assert.deepEqual(state.intrusion.sensorIds, ['DW1']);
  state = await store.simulate({ sensors: { DW1: { closed: true }, DW2: { closed: false } } });
  assert.deepEqual(state.intrusion.sensorIds, ['DW1', 'DW2']);
  state = await store.simulate({ sensors: { DW2: { closed: false } } }); assert.deepEqual(state.intrusion.sensorIds, ['DW1', 'DW2']);
  const reloaded = new AlarmSimulationStore({ filePath, now: () => 1_000_000 }); state = await reloaded.read(); assert.deepEqual(state.intrusion.sensorIds, ['DW1', 'DW2']);
  state = await reloaded.selectMode('none'); assert.equal(state.intrusion, null);
});

test('SR1 remains unavailable by default and only becomes active after the simulated alarm delay', async () => {
  const { store, setNow } = await fixture();
  let state = await store.read(); assert.equal(state.sensors.SR1.available, false); assert.equal(state.sensors.SR1.active, false);
  await store.simulate({ sensors: { SR1: { available: true }, DW1: { closed: false } } }); await store.selectMode('none');
  await store.simulate({ sensors: { DW1: { closed: true } } }); await store.selectMode('partial'); state = await store.simulate({ sensors: { DW1: { closed: false } } });
  setNow(state.intrusion.alarmAt); state = await store.read(); assert.equal(state.sensors.SR1.active, true);
  state = await store.selectMode('none'); assert.equal(state.sensors.SR1.active, false);
});

test('records one audio event for each alarm transition', async () => {
  const { store, setNow } = await fixture();
  await store.selectMode('partial'); await store.simulate({ sensors: { DW1: { closed: false } } });
  let state = await store.read(); assert.deepEqual(state.events.map(event => event.audio), ['alarm-partial.ogg', 'alarm-intrusion.ogg', 'alarm-intrusion-dw1.ogg']);
  setNow(state.intrusion.alarmAt); state = await store.read(); assert.equal(state.events.at(-1).audio, 'alarm-active.ogg');
  state = await store.selectMode('none'); assert.equal(state.events.at(-1).audio, 'alarm-disarmed.ogg');
});
