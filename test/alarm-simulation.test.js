import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlarmSimulationStore } from '../src/alarm-simulation.js';

const fixture = async () => { let now = 1_000_000; const directory = await mkdtemp(path.join(os.tmpdir(), 'home-alarm-')); return { setNow: value => { now = value; }, store: new AlarmSimulationStore({ filePath: path.join(directory, 'alarm.json'), now: () => now }) }; };

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

test('partial ignores motion while complete turns motion into a delayed simulated intrusion', async () => {
  const { store, setNow } = await fixture();
  await store.selectMode('partial'); let state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion, null);
  await store.selectMode('none'); await store.simulate({ sensors: { PR1: { motion: false } } }); await store.selectMode('complete'); setNow(1_060_000); await store.read(); state = await store.simulate({ sensors: { PR1: { motion: true } } }); assert.equal(state.intrusion.sensorId, 'PR1');
});

test('SR1 remains unavailable by default and only becomes active after the simulated alarm delay', async () => {
  const { store, setNow } = await fixture();
  let state = await store.read(); assert.equal(state.sensors.SR1.available, false); assert.equal(state.sensors.SR1.active, false);
  await store.simulate({ sensors: { SR1: { available: true }, DW1: { closed: false } } }); await store.selectMode('none');
  await store.simulate({ sensors: { DW1: { closed: true } } }); await store.selectMode('partial'); state = await store.simulate({ sensors: { DW1: { closed: false } } });
  setNow(state.intrusion.alarmAt); state = await store.read(); assert.equal(state.sensors.SR1.active, true);
  state = await store.selectMode('none'); assert.equal(state.sensors.SR1.active, false);
});
