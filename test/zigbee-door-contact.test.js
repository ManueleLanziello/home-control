import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { HomeZigbeeSensorRuntime } from '../src/zigbee-sensor-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { validateHardwareRegistry } from '../src/hardware-registry.js';
import { readFile } from 'node:fs/promises';
import { createHomeControlServer } from '../server.js';

function fixture() {
  let now = Date.parse('2026-10-17T12:00:00Z');
  const client = new EventEmitter();
  const subscriptions = [];
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null); };
  client.publish = () => assert.fail('I contatti porta/finestra non devono pubblicare comandi MQTT');
  client.end = () => {};
  const runtime = new HomeZigbeeSensorRuntime({ now: () => now, connect: () => client });
  const message = (topic, payload) => client.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  return { runtime, client, subscriptions, message, advance: ms => { now += ms; }, now: () => now };
}

test('gli otto SNZB-04PR2 usano friendly name esatti e acquisiscono l IEEE dal catalogo retained', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const topics = f.subscriptions[0];
  for (const name of ['sala-dw1', 'sala-dw2', 'sala-dw3', 'cucina-dw4', 'cucina-dw5', 'camera-dw6', 'bagno-dw7', 'cameretta-dw8']) assert.ok(topics.includes(`zigbee2mqtt/${name}`));
  assert.ok(topics.includes('zigbee2mqtt/bridge/devices'));
  f.message('zigbee2mqtt/bridge/devices', [{ friendly_name: 'sala-dw1', ieee_address: '0x00124b0026000001', definition: { model: 'SNZB-04PR2', vendor: 'SONOFF' } }]);
  const snapshot = f.runtime.readDoorContactSnapshot();
  assert.equal(Object.keys(snapshot).length, 8);
  assert.equal(snapshot.DW1.identity.ieeeAddress, '0x00124b0026000001');
  assert.equal(snapshot.DW1.identityStatus, 'verified');
  assert.equal(snapshot.DW1.reportedModel, 'SNZB-04PR2');
  assert.equal(snapshot.DW2.identity.ieeeAddress, null);
});

test('una identita IEEE duplicata o un modello inatteso restano diagnosticabili', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  f.message('zigbee2mqtt/bridge/devices', [
    { friendly_name: 'sala-dw1', ieee_address: '0x00124b0026000001', definition: { model: 'SNZB-04PR2', vendor: 'SONOFF' } },
    { friendly_name: 'sala-dw2', ieee_address: '0x00124b0026000001', definition: { model: 'SNZB-04PR2', vendor: 'SONOFF' } },
    { friendly_name: 'sala-dw3', ieee_address: '0x00124b0026000003', definition: { model: 'ALTRO', vendor: 'SONOFF' } },
  ]);
  const snapshot = f.runtime.readDoorContactSnapshot();
  assert.equal(snapshot.DW1.identityStatus, 'duplicate'); assert.equal(snapshot.DW2.identityStatus, 'duplicate');
  assert.equal(snapshot.DW3.identityStatus, 'model_mismatch');
});

test('aggiornamenti parziali preservano contact e separano normalita, manomissione e valori sconosciuti', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  f.message('zigbee2mqtt/sala-dw1', { contact: true, battery: 100, voltage: 3200, linkquality: 116 });
  f.message('zigbee2mqtt/sala-dw1', { tamper: true, battery_low: false });
  let contact = f.runtime.readDoorContactSnapshot().DW1;
  assert.equal(contact.contact, true); assert.equal(contact.closed, true);
  assert.equal(contact.tamper, true); assert.equal(contact.tamperState, 'detected');
  assert.equal(contact.batteryLow, false); assert.equal(contact.battery, 100); assert.equal(contact.voltage, 3200); assert.equal(contact.linkQuality, 116);
  f.message('zigbee2mqtt/sala-dw2', { contact: false });
  contact = f.runtime.readDoorContactSnapshot().DW2;
  assert.equal(contact.contact, false); assert.equal(contact.closed, false); assert.equal(contact.tamper, null); assert.equal(contact.tamperState, 'unknown');
});

test('assenza di dati non viene scambiata per chiusura e la disponibilita torna sconosciuta dopo disconnessione o freshness', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.equal(f.runtime.readDoorContactSnapshot().DW1.contact, null);
  f.message('zigbee2mqtt/sala-dw1', { contact: false });
  assert.equal(f.runtime.readDoorContactSnapshot().DW1.available, true);
  f.client.emit('offline');
  let contact = f.runtime.readDoorContactSnapshot().DW1;
  assert.equal(contact.contact, false); assert.equal(contact.available, false); assert.equal(contact.reason, 'broker_offline');
  f.client.emit('connect'); f.advance(120 * 60 * 1000 + 1);
  contact = f.runtime.readDoorContactSnapshot().DW1;
  assert.equal(contact.contact, false); assert.equal(contact.available, false); assert.equal(contact.reason, 'stale');
});

test('lo snapshot Home espone i contatti senza trasformarli in eventi dell antifurto', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect'); f.message('zigbee2mqtt/sala-dw1', { contact: true, tamper: false });
  const home = new HomeStatusRuntime({ now: f.now, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeDoorContacts: () => f.runtime.readDoorContactSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }) });
  const snapshot = await home.readSnapshot();
  assert.equal(snapshot.doorContacts.DW1.closed, true); assert.equal(snapshot.doorContacts.DW1.tamperState, 'normal');
  assert.equal(snapshot.intrusion, undefined);
});

test('un cambio MQTT del contatto viene inoltrato subito sul canale SSE dedicato', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const events = await fetch(`http://127.0.0.1:${server.address().port}/api/door-contacts/events`);
  const reader = events.body.getReader(); await reader.read();
  f.message('zigbee2mqtt/sala-dw1', { contact: false });
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /"DW1"/); assert.match(event, /"contact":false/); assert.match(event, /"available":true/);
  await reader.cancel();
});

test('il registro dichiara otto marker DW senza duplicazioni', async () => {
  const registry = validateHardwareRegistry(JSON.parse(await readFile(new URL('../data/config/hardware.json', import.meta.url), 'utf8')));
  const contacts = registry.inventory.filter(item => /^DW[1-8]$/.test(item.marker));
  assert.deepEqual(contacts.map(item => item.friendlyName), ['sala-dw1', 'sala-dw2', 'sala-dw3', 'cucina-dw4', 'cucina-dw5', 'camera-dw6', 'bagno-dw7', 'cameretta-dw8']);
  assert.equal(new Set(contacts.map(item => item.marker)).size, 8);
});
