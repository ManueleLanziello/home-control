import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { HomeZigbeeSensorRuntime } from '../src/zigbee-sensor-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { createHomeControlServer } from '../server.js';

function fixture() {
  let now = Date.parse('2026-10-17T12:00:00Z');
  const client = new EventEmitter(); const subscriptions = [];
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null); };
  client.publish = () => {}; client.end = () => {};
  const runtime = new HomeZigbeeSensorRuntime({ now: () => now, connect: () => client });
  const message = (payload, packet = {}) => client.emit('message', 'zigbee2mqtt/sala-pr1', Buffer.from(JSON.stringify(payload)), packet);
  return { runtime, client, subscriptions, message, advance: ms => { now += ms; }, now: () => now };
}

test('PR1 usa sala-pr1 e verifica l IEEE dichiarato dal catalogo Zigbee2MQTT', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/sala-pr1'));
  f.client.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([{ friendly_name: 'sala-pr1', ieee_address: '0xf044d3fffef6cb7a', definition: { model: 'SNZB-03P', vendor: 'SONOFF' } }])));
  const sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.id, 'PR1'); assert.equal(sensor.identity.ieeeAddress, '0xf044d3fffef6cb7a'); assert.equal(sensor.identityStatus, 'verified');
});

test('PR1 conserva aggiornamenti MQTT parziali e distingue occupancy true false e null', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  f.message({ occupancy: true, illumination: 'low', battery: 71, voltage: 3000, linkquality: 102 });
  let sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.occupancy, true); assert.equal(sensor.illumination, 'low'); assert.equal(sensor.available, true);
  f.message({ occupancy: false }); sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.occupancy, false); assert.equal(sensor.illumination, 'low'); assert.equal(sensor.battery, 71);
  f.message({ occupancy: null }); sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.occupancy, null); assert.equal(sensor.available, true);
  f.client.emit('offline'); sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.available, false); assert.equal(sensor.reason, 'broker_offline');
});

test('un messaggio retained dopo riavvio resta storico finche non arriva una lettura corrente', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  f.message({ occupancy: false }, { retain: true });
  let sensor = f.runtime.readMotionSensorSnapshot(); assert.equal(sensor.confirmed, false); assert.equal(sensor.available, false); assert.equal(sensor.reason, 'historical');
  f.message({ occupancy: true }); sensor = f.runtime.readMotionSensorSnapshot();
  assert.equal(sensor.confirmed, true); assert.equal(sensor.available, true); assert.equal(sensor.occupancy, true);
});

test('snapshot Home e SSE propagano subito PR1 senza modificare lo stato dell antifurto', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const home = new HomeStatusRuntime({ now: f.now, hardwareStore: { async read() { return { devices: [], inventory: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeMotionSensor: () => f.runtime.readMotionSensorSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }) });
  f.message({ occupancy: true }); assert.equal((await home.readSnapshot()).motionSensor.occupancy, true);
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const events = await fetch(`http://127.0.0.1:${server.address().port}/api/motion-sensor/events`); const reader = events.body.getReader(); await reader.read();
  f.message({ occupancy: false }); const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /"id":"PR1"/); assert.match(event, /"occupancy":false/); assert.doesNotMatch(event, /intrusion/);
  await reader.cancel();
});
