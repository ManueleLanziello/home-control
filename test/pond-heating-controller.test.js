import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { PondHeatingStore } from '../src/pond-heating-store.js';
import { PondHeatingController } from '../src/pond-heating-controller.js';

const pondSnapshot = (pump = 'ON', heater = 'OFF') => ({ plugs: [
  { role: 'pump', runtime: { state: pump, online: true, communicationDegraded: false, consecutiveFailures: 0 } },
  { role: 'heater', runtime: { state: heater, online: true, communicationDegraded: false, consecutiveFailures: 0 } },
] });

async function fixture(t, { stateFile = null } = {}) {
  const dir = stateFile ? null : await mkdtemp(path.join(os.tmpdir(), 'pond-heating-'));
  if (dir) t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new PondHeatingStore({ filePath: stateFile || path.join(dir, 'pond-heating.json') });
  const calls = []; const timers = [];
  const controller = new PondHeatingController({
    store,
    pondController: { async set(role, on) { calls.push([role, on]); return { role, state: on ? 'ON' : 'OFF' }; } },
    setTimeoutFn: operation => { timers.push(operation); return operation; },
    clearTimeoutFn: () => {},
  });
  await controller.initialize();
  await controller.observePondState(pondSnapshot());
  return { store, calls, timers, controller };
}

const live = (value, updatedAt) => ({ temperature: value, updatedAt, online: true, available: true, confirmed: true });

test('un ciclo termostatico congela la configurazione, alterna ON/OFF e richiede una nuova misura dopo il completamento', async t => {
  const { controller, calls, timers } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 2, onMinutes: 1, offMinutes: 1 });
  await controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  assert.deepEqual(calls, [['heater', true]]);
  assert.equal((await controller.snapshot()).activeCycle.config.repetitions, 2);
  await controller.setConfig({ mode: 'thermostat', threshold: 22, repetitions: 5, onMinutes: 4, offMinutes: 6 });
  assert.equal((await controller.snapshot()).config.repetitions, 5);
  assert.equal((await controller.snapshot()).activeCycle.config.repetitions, 2);
  assert.deepEqual((await controller.snapshot()).latestMeasurement, { value: 17, updatedAt: '2026-10-23T10:00:00.000Z' });
  timers.shift()(); await controller.queue;
  assert.deepEqual(calls, [['heater', true], ['heater', false]]);
  timers.shift()(); await controller.queue;
  assert.deepEqual(calls, [['heater', true], ['heater', false], ['heater', true]]);
  timers.shift()(); await controller.queue;
  const completed = await controller.snapshot();
  assert.equal(completed.activeCycle, null);
  assert.equal(completed.history.length, 1);
  assert.equal(completed.history[0].result, 'COMPLETATO');
  await controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  assert.equal((await controller.snapshot()).activeCycle, null);
  await controller.observeS5(live(17, '2026-10-23T10:01:00.000Z'));
  assert.equal((await controller.snapshot()).activeCycle?.phase, 'on');
});

test('il passaggio a manuale interrompe subito il ciclo, spegne il riscaldatore e conserva la configurazione attiva nello storico', async t => {
  const { controller, calls } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 3, onMinutes: 20, offMinutes: 30 });
  await controller.observeS5(live(16, '2026-10-23T10:00:00.000Z'));
  await controller.setConfig({ mode: 'manual', threshold: 19, repetitions: 1, onMinutes: 2, offMinutes: 0 });
  const state = await controller.snapshot();
  assert.deepEqual(calls, [['heater', true], ['heater', false]]);
  assert.equal(state.config.mode, 'manual');
  assert.equal(state.history[0].result, 'INTERROTTO — MODALITÀ MANUALE');
  assert.deepEqual(state.history[0].config, { mode: 'thermostat', threshold: 18, repetitions: 3, onMinutes: 20, offMinutes: 30 });
});

test('un errore durante lo spegnimento mantiene la modalità termostato e non rende disponibili i comandi manuali', async t => {
  const { controller, calls } = await fixture(t);
  await controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 1, onMinutes: 20, offMinutes: 0 });
  await controller.observeS5(live(16, '2026-10-23T10:00:00.000Z'));
  controller.pondController.set = async (role, on) => { calls.push([role, on]); if (!on) throw new Error('readback OFF non confermato'); };
  await assert.rejects(controller.setConfig({ mode: 'manual' }), /readback OFF non confermato/);
  const state = await controller.snapshot();
  assert.equal(state.config.mode, 'thermostat');
  assert.equal(state.activeCycle?.phase, 'interrupting');
});

test('un ciclo persistente viene registrato come interrotto al riavvio senza riattivare il riscaldatore', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pond-heating-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'pond-heating.json');
  const first = await fixture(t, { stateFile });
  await first.controller.setConfig({ mode: 'thermostat', threshold: 18, repetitions: 1, onMinutes: 1, offMinutes: 0 });
  await first.controller.observeS5(live(17, '2026-10-23T10:00:00.000Z'));
  const second = await fixture(t, { stateFile });
  const state = await second.controller.snapshot();
  assert.equal(state.activeCycle, null);
  assert.equal(state.deviceVerified, true);
  assert.equal(state.history.at(-1).result, 'INTERROTTO — RIAVVIO');
  assert.deepEqual(second.calls, []);
});
