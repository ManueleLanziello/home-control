import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { HomeZigbeeSensorRuntime } from '../src/zigbee-sensor-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { AlarmRuntime } from '../src/alarm-runtime.js';
import { createHomeControlServer } from '../server.js';

function fixture() {
  let now = Date.parse('2026-10-18T12:00:00Z');
  const client = new EventEmitter(); const subscriptions = []; const publications = [];
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null, topics.map(topic => ({ topic, qos: 0 }))); };
  client.publish = (...args) => { publications.push(args); args.at(-1)?.(null); }; client.end = () => {};
  const runtime = new HomeZigbeeSensorRuntime({ now: () => now, connect: () => client });
  const message = (payload, packet = {}) => client.emit('message', 'zigbee2mqtt/terrazzo-SR1', Buffer.from(JSON.stringify(payload)), packet);
  return { runtime, client, subscriptions, publications, message, now: () => now, advance: ms => { now += ms; } };
}

test('SR1 osserva il catalogo e tutta la telemetria senza un IEEE inventato o comandi MQTT', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/terrazzo-SR1'));
  assert.equal(f.publications.some(([topic]) => String(topic).includes('terrazzo-SR1')), false);
  f.client.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([{ friendly_name: 'terrazzo-SR1', ieee_address: '0x00124b0025010203', definition: { model: 'SNZB-09P', vendor: 'SONOFF' } }])));
  f.message({ power_supply_mode: 'battery', battery: 15, alarm_sound_enable: 'ON', alarm_light_enable: 'OFF', tamper: false, alarm_sound_type: 'siren_classic', alarm_volume_level: 'high', alarm_duration: 180, linkquality: 112 });
  const siren = f.runtime.readSirenSnapshot();
  assert.equal(siren.id, 'SR1'); assert.equal(siren.identity.ieeeAddress, '0x00124b0025010203'); assert.equal(siren.identityStatus, 'verified');
  assert.equal(siren.sirenOn, null); assert.equal(siren.powerSupplyMode, 'battery'); assert.equal(siren.battery, 15); assert.equal(siren.soundEnabled, true); assert.equal(siren.lightEnabled, false); assert.equal(siren.tamperState, 'normal'); assert.equal(siren.soundType, 'siren_classic'); assert.equal(siren.volumeLevel, 'high'); assert.equal(siren.duration, 180); assert.equal(siren.linkQuality, 112); assert.equal(siren.available, true);
  assert.equal(f.publications.some(([topic]) => String(topic).includes('terrazzo-SR1')), false);
});

test('SR1 pubblica solo le cinque impostazioni autorizzate e mai siren_on', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  await f.runtime.setSirenConfiguration({ soundEnabled: true, lightEnabled: false, soundType: 'siren_warning', volumeLevel: 'max', duration: 120 });
  const sirenWrites = f.publications.filter(([topic]) => topic === 'zigbee2mqtt/terrazzo-SR1/set');
  assert.deepEqual(sirenWrites.map(([, payload]) => JSON.parse(payload)), [{ alarm_sound_enable: 'ON', alarm_light_enable: 'OFF', alarm_sound_type: 'siren_warning', alarm_volume_level: 'max', alarm_duration: 120 }]);
  await assert.rejects(f.runtime.setSirenConfiguration({ sirenOn: true })); assert.equal(sirenWrites[0][1].includes('siren_on'), false);
});

test('SR1 pubblica ON e OFF esclusivamente sul topic della sirena', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  await f.runtime.setSirenActive(true); await f.runtime.setSirenActive(false);
  const writes = f.publications.filter(([topic]) => topic === 'zigbee2mqtt/terrazzo-SR1/set').map(([, payload]) => JSON.parse(payload));
  assert.deepEqual(writes, [{ siren_on: 'ON' }, { siren_on: 'OFF' }]);
});

test('SR1 preserva pacchetti parziali, tratta retained come storico e segnala offline', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  f.message({ battery: 88, alarm_volume_level: 'low' }, { retain: true });
  let siren = f.runtime.readSirenSnapshot(); assert.equal(siren.confirmed, false); assert.equal(siren.available, false); assert.equal(siren.reason, 'historical');
  f.message({ alarm_duration: 60 }); siren = f.runtime.readSirenSnapshot(); assert.equal(siren.confirmed, true); assert.equal(siren.battery, 88); assert.equal(siren.volumeLevel, 'low'); assert.equal(siren.duration, 60); assert.equal(siren.available, true);
  f.client.emit('offline'); siren = f.runtime.readSirenSnapshot(); assert.equal(siren.available, false); assert.equal(siren.reason, 'broker_offline');
});

test('SR1 raggiunge snapshot Home, SSE esistente e AlarmRuntime come telemetria senza attivare la sirena logica', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect'); f.message({ battery: 15, tamper: true, linkquality: 80 });
  const home = new HomeStatusRuntime({ now: f.now, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeSiren: () => f.runtime.readSirenSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }) });
  assert.equal((await home.readSnapshot()).siren.battery, 15);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-siren-')); const alarmStore = new AlarmRuntime({ now: f.now, filePath: path.join(directory, 'alarm.json') }); const state = await alarmStore.syncSensors({ siren: f.runtime.readSirenSnapshot() });
  assert.equal(state.sensors.SR1.active, false); assert.equal(state.sensors.SR1.physical.batteryLow, true); assert.equal(state.sensors.SR1.physical.tamperState, 'detected');
  const server = createHomeControlServer({ alarmStore, zigbeeRuntime: f.runtime, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/alarm/events`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let event = '';
  for (let index = 0; index < 3 && !event.includes('event: state'); index += 1) { const chunk = await Promise.race([reader.read(), new Promise((resolve, reject) => setTimeout(() => reject(new Error('SSE SR1 non ricevuto')), 2000))]); event += decoder.decode(chunk.value); }
  assert.match(event, /event: state/); assert.match(event, /"id":"SR1"/); assert.match(event, /"battery":15/); assert.doesNotMatch(event, /terrazzo-SR1\/set/);
  await reader.cancel();
});
