import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AlarmRuntime } from '../src/alarm-runtime.js';
import { createHomeControlServer } from '../server.js';

const DW_IDS = ['DW1', 'DW2', 'DW3', 'DW4', 'DW5', 'DW6', 'DW7', 'DW8'];
const fixture = async () => {
  let now = 1_000_000;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-alarm-'));
  const store = new AlarmRuntime({ filePath: path.join(directory, 'alarm.json'), now: () => now });
  const sensors = () => ({ doorContacts: Object.fromEntries(DW_IDS.map(id => [id, { available: true, contact: true, updatedAt: new Date(now).toISOString() }])), motionSensor: { available: true, confirmed: true, occupancy: false, updatedAt: new Date(now).toISOString() } });
  return { store, sensors, setNow: value => { now = value; }, now: () => now, filePath: path.join(directory, 'alarm.json') };
};

test('disinserito conserva i sensori reali ma non genera intrusioni', async () => {
  const f = await fixture(); const input = f.sensors(); input.doorContacts.DW2.contact = false;
  const state = await f.store.syncSensors(input);
  assert.equal(state.mode, 'none'); assert.equal(state.sensors.DW2.closed, false); assert.equal(state.intrusion, null);
});

test('parziale monitora tutti i DW reali ma non PR1', async () => {
  const f = await fixture(); const input = f.sensors(); await f.store.syncSensors(input); await f.store.selectMode('partial');
  input.motionSensor.occupancy = true; let state = await f.store.syncSensors(input); assert.equal(state.intrusion, null);
  input.doorContacts.DW3.contact = false; state = await f.store.syncSensors(input); assert.deepEqual(state.intrusion.sensorIds, ['DW3']);
  input.doorContacts.DW3.contact = true; state = await f.store.syncSensors(input); assert.deepEqual(state.intrusion.sensorIds, ['DW3']);
});

test('completo mantiene la regola di uscita DW1 e arma PR1 solo dopo inattivita reale', async () => {
  const f = await fixture(); const input = f.sensors(); input.doorContacts.DW1.contact = false; await f.store.syncSensors(input);
  let state = await f.store.selectMode('complete'); assert.equal(state.armingUntil, 1_060_000);
  input.doorContacts.DW1.contact = true; input.motionSensor.occupancy = true; await f.store.syncSensors(input); f.setNow(1_060_000); state = await f.store.read();
  assert.equal(state.mode, 'complete'); assert.equal(state.pr1Ready, false); assert.equal(state.intrusion, null);
  input.motionSensor.occupancy = false; state = await f.store.syncSensors(input); assert.equal(state.pr1Ready, true);
  input.motionSensor.occupancy = true; state = await f.store.syncSensors(input); assert.equal(state.intrusion.sensorId, 'PR1');
});

test('offline e sconosciuto bloccano inserimento e non diventano chiusure implicite', async () => {
  const f = await fixture(); const input = f.sensors(); input.doorContacts.DW4 = { available: false, contact: true, reason: 'broker_offline' }; input.doorContacts.DW5 = { available: true, contact: null };
  await f.store.syncSensors(input);
  await assert.rejects(f.store.selectMode('partial'), error => error.blocked.includes('DW4') && error.blocked.includes('DW5'));
});

test('temporizzazione esistente attiva l allarme e il disinserimento la annulla', async () => {
  const f = await fixture(); const input = f.sensors(); await f.store.syncSensors(input); await f.store.setSettings({ armingMinutes: 1, delayMinutes: 1 }); await f.store.selectMode('partial');
  input.doorContacts.DW1.contact = false; let state = await f.store.syncSensors(input); assert.equal(state.intrusion.active, false);
  f.setNow(state.intrusion.alarmAt); state = await f.store.read(); assert.equal(state.intrusion.active, true); assert.equal(state.sensors.SR1.active, true);
  state = await f.store.selectMode('none'); assert.equal(state.intrusion, null); assert.equal(state.sensors.SR1.active, false);
});

test('riavvio conserva i valori solo come storici e non genera falsi allarmi finche MQTT non conferma', async () => {
  const f = await fixture(); const input = f.sensors(); await f.store.syncSensors(input); await f.store.selectMode('partial');
  const restarted = new AlarmRuntime({ filePath: f.filePath, now: f.now }); let state = await restarted.read();
  assert.equal(state.sensors.DW1.available, false); assert.equal(state.sensors.DW1.historical, true); assert.equal(state.intrusion, null);
  state = await restarted.syncSensors(input); assert.equal(state.sensors.DW1.available, true); assert.equal(state.sensors.DW1.historical, false);
});

test('eventi audio identificano il sensore reale responsabile senza endpoint di simulazione', async () => {
  const f = await fixture(); const input = f.sensors(); await f.store.syncSensors(input); await f.store.selectMode('partial'); input.doorContacts.DW8.contact = false;
  const state = await f.store.syncSensors(input); assert.deepEqual(state.events.slice(-2).map(event => event.audio), ['alarm-intrusion.ogg', 'alarm-intrusion-dw8.ogg']);
});

test('il runtime non espone piu ingressi manuali di simulazione', async () => {
  const { readFile } = await import('node:fs/promises');
  const [serverSource, floorplanSource] = await Promise.all([readFile(new URL('../server.js', import.meta.url), 'utf8'), readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8')]);
  assert.doesNotMatch(serverSource, /\/api\/alarm\/simulation/); assert.doesNotMatch(floorplanSource, /data-simulation|Controlli simulazione/);
});

test('il listener Zigbee del backend inoltra i DW reali allo store antifurto senza browser', async t => {
  const f = await fixture(); const input = f.sensors(); let listener;
  const zigbeeRuntime = { subscribeState(next) { listener = next; return () => {}; }, readDoorContactSnapshot: () => input.doorContacts, readMotionSensorSnapshot: () => input.motionSensor, close() {} };
  const server = createHomeControlServer({ alarmStore: f.store, zigbeeRuntime, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve))); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  await new Promise(resolve => setImmediate(resolve)); await f.store.selectMode('partial'); input.doorContacts.DW6.contact = false; listener('doorContacts'); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.store.read()).intrusion.sensorId, 'DW6');
});
