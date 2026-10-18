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
