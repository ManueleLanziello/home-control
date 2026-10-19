import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmSirenController } from '../src/alarm-siren-controller.js';

const flush = () => new Promise(resolve => queueMicrotask(resolve));
const timers = () => { const pending = []; return { set(callback, delay) { const timer = { callback, delay, cleared: false }; pending.push(timer); return timer; }, clear(timer) { timer.cleared = true; }, async next(delay) { const timer = pending.find(item => !item.cleared && item.delay === delay); assert.ok(timer, `timer ${delay} mancante`); timer.cleared = true; timer.callback(); await flush(); await flush(); }, pending }; };
const settings = Object.freeze({ soundEnabled: true, lightEnabled: true, soundType: 'siren_classic', volumeLevel: 'medium', duration: 30, pauseSeconds: 30, cycleCount: 5 });

test('SR1 esegue cinque cicli ON/OFF senza pausa finale e non riparte durante lo stesso allarme', async () => {
  const writes = []; const clock = timers(); const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  assert.equal(await siren.activate(settings), true); assert.equal(await siren.activate(settings), false); assert.deepEqual(writes, [true]);
  for (let cycle = 1; cycle <= 5; cycle += 1) { await clock.next(30_000); assert.equal(writes.at(-1), false); if (cycle < 5) { await clock.next(30_000); assert.equal(writes.at(-1), true); } }
  assert.equal(siren.sequenceActive, false); assert.equal(siren.alarmActive, true); assert.deepEqual(writes, [true, false, true, false, true, false, true, false, true, false]);
});

test('STOP ha priorita durante ON e durante pausa, annulla i timer e consente un nuovo allarme', async () => {
  const writes = []; const clock = timers(); const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  await siren.activate({ ...settings, cycleCount: 2 }); await siren.stop({ force: true }); assert.deepEqual(writes, [true, false]);
  await siren.activate({ ...settings, cycleCount: 2 }); await clock.next(30_000); await siren.stop({ force: true }); assert.deepEqual(writes, [true, false, true, false, false]);
});

test('STOP fallito resta pendente, blocca ogni ON e viene pubblicato una sola volta alla riconnessione', async () => {
  const writes = []; let connected = true; const clock = timers(); const siren = new AlarmSirenController({ send: active => { writes.push(active); return connected ? undefined : Promise.reject(Error('offline')); }, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  await siren.activate({ ...settings, cycleCount: 2 }); connected = false; assert.equal(await siren.stop({ force: true }), false); assert.equal(siren.stopPending, true); assert.equal(await siren.activate(settings), false); assert.equal(await siren.startTest(settings), false);
  connected = true; assert.equal(await siren.retryPendingStop(), true); assert.equal(siren.stopPending, false); assert.equal(await siren.retryPendingStop(), false); assert.deepEqual(writes, [true, false, false]);
});

test('uno ON gia in elaborazione non pianifica altri cicli dopo STOP', async () => {
  const writes = []; let resolveOn; const clock = timers(); const siren = new AlarmSirenController({ send: active => { writes.push(active); return active ? new Promise(resolve => { resolveOn = resolve; }) : undefined; }, setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  await siren.activate({ ...settings, cycleCount: 2 }); const stopped = siren.stop({ force: true }); resolveOn(); assert.equal(await stopped, true); await flush();
  assert.deepEqual(writes, [true, false]); assert.equal(clock.pending.filter(timer => !timer.cleared).length, 0);
});

test('lo snapshot configurato resta invariato durante una sequenza e gli errori MQTT non creano timer incontrollati', async () => {
  const configured = []; const errors = []; const clock = timers(); const siren = new AlarmSirenController({ send: active => active ? Promise.reject(Error('offline')) : undefined, configure: value => configured.push(value), logError: error => errors.push(error.message), setTimeoutFn: clock.set, clearTimeoutFn: clock.clear });
  await siren.activate({ ...settings, duration: 7, pauseSeconds: 9, cycleCount: 1 }); await flush(); await clock.next(7_000);
  assert.deepEqual(configured, [{ ...settings, duration: 7, pauseSeconds: 9, cycleCount: 1 }]); assert.deepEqual(errors, ['offline']); assert.equal(siren.sequenceActive, false);
});

test('test manuale invia una sola attivazione, usa la durata configurata e ignora pause e cicli', async () => {
  const writes = []; let timer; let delay; let cleared = false;
  const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: (callback, value) => { timer = callback; delay = value; return 1; }, clearTimeoutFn: () => { cleared = true; } });
  assert.equal(await siren.startTest({ ...settings, duration: 17, pauseSeconds: 99, cycleCount: 20 }), true); assert.deepEqual(writes, [true]); assert.equal(delay, 17_000); assert.equal(siren.testActive, true);
  timer(); await flush(); assert.deepEqual(writes, [true, false]); assert.equal(siren.testActive, false);
  assert.equal(await siren.stopTest(), false); assert.deepEqual(writes, [true, false]); assert.equal(cleared, true);
});

test('STOP manuale annulla il test e un allarme reale ne prende il controllo senza STOP tardivo', async () => {
  const writes = []; const callbacks = [];
  const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: callback => { callbacks.push(callback); return callbacks.length; }, clearTimeoutFn: () => {} });
  await siren.startTest(); assert.equal(await siren.stopTest(), true); assert.deepEqual(writes, [true, false]);
  await siren.startTest(); const staleTestTimer = callbacks.at(-1); await siren.activate({ ...settings, cycleCount: 1 }); staleTestTimer(); await flush();
  assert.deepEqual(writes, [true, false, true, true]); assert.equal(siren.testActive, false);
});

test('test manuale fallito non resta attivo con MQTT non disponibile', async () => {
  const siren = new AlarmSirenController({ send: () => Promise.reject(Error('offline')), logError: () => {} });
  await assert.rejects(siren.startTest(), /offline/); assert.equal(siren.testActive, false);
});
