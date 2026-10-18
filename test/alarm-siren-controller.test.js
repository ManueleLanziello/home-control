import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmSirenController } from '../src/alarm-siren-controller.js';

const flush = () => new Promise(resolve => queueMicrotask(resolve));

test('SR1 invia un solo ON per allarme e non si attiva a riavvio o riconnessione', async () => {
  const writes = []; const siren = new AlarmSirenController({ send: active => writes.push(active) });
  await flush(); assert.deepEqual(writes, []);
  siren.activate(); siren.activate(); await flush(); assert.deepEqual(writes, [true]);
  // No lifecycle hook exists for reconnect: only an AlarmRuntime active event invokes activate.
  await flush(); assert.deepEqual(writes, [true]);
});

test('STOP invalida un ON in attesa, ha priorita e consente un nuovo allarme legittimo', async () => {
  const writes = []; const siren = new AlarmSirenController({ send: active => writes.push(active) });
  siren.activate(); await siren.stop({ force: true }); await flush(); assert.deepEqual(writes, [false]);
  siren.activate(); await flush(); assert.deepEqual(writes, [false, true]);
  await siren.stop(); assert.deepEqual(writes, [false, true, false]);
});

test('errori MQTT non trasformano una pubblicazione in conferma fisica', async () => {
  const errors = []; const siren = new AlarmSirenController({ send: () => Promise.reject(Error('offline')), logError: error => errors.push(error.message) });
  siren.activate(); await flush(); await flush(); assert.deepEqual(errors, ['offline']);
});

test('test manuale invia ON, programma STOP backend e non duplica il comando', async () => {
  const writes = []; let timer; let cleared = false;
  const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: callback => { timer = callback; return 1; }, clearTimeoutFn: () => { cleared = true; } });
  assert.equal(await siren.startTest(), true); assert.deepEqual(writes, [true]); assert.equal(siren.testActive, true);
  timer(); await flush(); assert.deepEqual(writes, [true, false]); assert.equal(siren.testActive, false);
  assert.equal(await siren.stopTest(), false); assert.deepEqual(writes, [true, false]); assert.equal(cleared, true);
});

test('STOP manuale annulla il test e un allarme reale ne prende il controllo senza STOP tardivo', async () => {
  const writes = []; let timer;
  const siren = new AlarmSirenController({ send: active => writes.push(active), setTimeoutFn: callback => { timer = callback; return 1; }, clearTimeoutFn: () => {} });
  await siren.startTest(); assert.equal(await siren.stopTest(), true); assert.deepEqual(writes, [true, false]);
  await siren.startTest(); siren.activate(); await flush(); timer(); await flush();
  assert.deepEqual(writes, [true, false, true]); assert.equal(siren.testActive, false);
});

test('test manuale fallito non resta attivo con MQTT non disponibile', async () => {
  const siren = new AlarmSirenController({ send: () => Promise.reject(Error('offline')), logError: () => {} });
  await assert.rejects(siren.startTest(), /offline/); assert.equal(siren.testActive, false);
});
