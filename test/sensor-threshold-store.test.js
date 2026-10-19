import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SensorThresholdStore } from '../src/sensor-threshold-store.js';
import { createHomeControlServer } from '../server.js';

test('le soglie S1–S5 persistono separatamente e validano ID e valori', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sensor-thresholds-'));
  try {
    const filePath = path.join(directory, 'thresholds.json');
    const store = new SensorThresholdStore({ filePath });
    assert.deepEqual(await store.read(), { thresholds: {} });
    await store.set('S1', 12.5); await store.set('S3', 18);
    assert.deepEqual((await store.read()).thresholds, { S1: 12.5, S3: 18 });
    assert.deepEqual((await new SensorThresholdStore({ filePath }).read()).thresholds, { S1: 12.5, S3: 18 });
    await store.set('S1', null);
    assert.deepEqual((await store.read()).thresholds, { S3: 18 });
    await assert.rejects(store.set('DW1', 12), /Sensore non valido/);
    await assert.rejects(store.set('S2', 81), /Soglia temperatura non valida/);
    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).thresholds, { S3: 18 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('API soglie salva solo configurazione UI e non richiama runtime hardware', async t => {
  const saved = {};
  const sensorThresholdStore = {
    async read() { return { thresholds: { ...saved } }; },
    async set(id, value) { if (value === null) delete saved[id]; else saved[id] = value; return { thresholds: { ...saved } }; },
  };
  const server = createHomeControlServer({ sensorThresholdStore });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/sensor-thresholds`)).json(), { thresholds: {} });
  const response = await fetch(`${base}/api/sensors/S3/minimum-temperature`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minimumTemperature: 17.5 }) });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { thresholds: { S3: 17.5 } });
});
