import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { HomeZigbeeSensorRuntime, normalizeSnzb02ldPayload, normalizeSnzb02pPayload } from '../src/zigbee-sensor-runtime.js';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';
import { createHomeControlServer } from '../server.js';

function fixture() {
  let now = Date.parse('2026-09-16T12:00:00Z');
  const client = new EventEmitter();
  const subscriptions = [];
  const publishes = [];
  let ends = 0;
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null); };
  client.publish = (topic, payload, options, callback) => { publishes.push({ topic, payload, options }); callback(null); };
  client.end = force => { assert.equal(force, true); ends += 1; };
  let connects = 0;
  const runtime = new HomeZigbeeSensorRuntime({ now: () => now, connect: (url, options) => {
    assert.equal(url, 'mqtt://localhost:1883');
    assert.equal(options.reconnectPeriod, 5000);
    assert.equal(options.resubscribe, false);
    connects += 1; return client;
  } });
  const message = (topic, payload) => client.emit('message', topic, Buffer.from(JSON.stringify(payload)));
  return { runtime, client, message, subscriptions, publishes, advance: ms => { now += ms; }, now: () => now,
    ends: () => ends, connects: () => connects };
}

test('MQTT sottoscrive sensori, LB1 e luci configurate senza alterare il parsing dei sensori', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.deepEqual(f.subscriptions[0], ['zigbee2mqtt/SmartHomeS1', 'zigbee2mqtt/SmartHomeS2', 'zigbee2mqtt/SmartHomeS4', 'zigbee2mqtt/pond-temp-acqua', 'zigbee2mqtt/sala-dw1', 'zigbee2mqtt/sala-dw2', 'zigbee2mqtt/sala-dw3', 'zigbee2mqtt/cucina-dw4', 'zigbee2mqtt/cucina-dw5', 'zigbee2mqtt/camera-dw6', 'zigbee2mqtt/bagno-dw7', 'zigbee2mqtt/cameretta-dw8', 'zigbee2mqtt/sala-pr1', 'zigbee2mqtt/terrazzo-SR1', 'zigbee2mqtt/bridge/devices', 'zigbee2mqtt/SmartHomeLB1', 'zigbee2mqtt/cucina-L1', 'zigbee2mqtt/camera-L2', 'zigbee2mqtt/salotto-L3', 'zigbee2mqtt/bagno-L5', 'zigbee2mqtt/cameretta-L6', 'zigbee2mqtt/giardino-L8', 'zigbee2mqtt/terrazzo-L11', 'zigbee2mqtt/terrazzo-L12', 'zigbee2mqtt/bagno-L13']);
  for (const [id, temperature] of [['S1', 20], ['S2', 21], ['S4', 23]]) {
    f.message(`zigbee2mqtt/SmartHome${id}`, { temperature, humidity: 49.9, battery: 100, linkquality: 192 });
    const snapshot = f.runtime.readSnapshot()[id];
    assert.equal(snapshot.temperature, temperature); assert.equal(snapshot.online, true);
    assert.equal(snapshot.updatedAt, new Date(f.now()).toISOString());
  }
  const before = f.runtime.readSnapshot();
  f.message('zigbee2mqtt/SmartHomeS3', { temperature: 99, humidity: 50 });
  f.message('zigbee2mqtt/SmartHomeS1', { temperature: 'wrong', humidity: 50 });
  f.client.emit('message', 'zigbee2mqtt/SmartHomeS1', Buffer.from('invalid JSON'));
  const partial = f.runtime.readSnapshot();
  assert.equal(partial.S1.temperature, before.S1.temperature);
  assert.equal(partial.S1.humidity, 50);
  f.runtime.close();
});

test('S5 usa pond-temp-acqua, accetta solo temperatura e non considera online un retained', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.deepEqual(ZIGBEE_SENSOR_CONFIG.sensors.find(sensor => sensor.id === 'S5'), {
    id: 'S5', name: 'SONOFF — Temperatura acqua', friendlyName: 'pond-temp-acqua', topic: 'zigbee2mqtt/pond-temp-acqua', getTopic: 'zigbee2mqtt/pond-temp-acqua/get', getPayload: { temperature: '' }, ieeeAddress: '0xa4c1380cd121ffff', model: 'SNZB-02LD', manufacturer: 'SONOFF', humidity: false, requiresConfirmedMessage: true,
  });
  assert.equal(normalizeSnzb02ldPayload({ temperature: 12.4, battery: 87, linkquality: 93 }, { updatedAt: '2026-09-16T12:00:00Z', confirmed: true }).humidity, null);
  assert.equal(normalizeSnzb02ldPayload({ battery: 87 }), null);
  f.client.emit('message', 'zigbee2mqtt/pond-temp-acqua', Buffer.from(JSON.stringify({ temperature: 12.4, battery: 87, linkquality: 93 })), { retain: true });
  assert.equal(f.runtime.readSnapshot().S5.online, false);
  f.message('zigbee2mqtt/pond-temp-acqua', { temperature: 12.4, battery: 87, linkquality: 93 });
  const sensor = f.runtime.readSnapshot().S5;
  assert.equal(sensor.temperature, 12.4); assert.equal(sensor.battery, 87); assert.equal(sensor.linkQuality, 93);
  assert.equal(sensor.humidity, null); assert.equal(sensor.online, true); assert.equal(sensor.available, true);
  f.client.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([{ friendly_name: 'pond-temp-acqua', ieee_address: '0xa4c1380cd121ffff', definition: { model: 'SNZB-02LD', vendor: 'SONOFF' } }])));
  assert.equal(f.runtime.readSnapshot().S5.identityStatus, 'verified');
  f.runtime.close();
});

test('payload parziali conservano campi validi indipendenti e non arrotondano la temperatura', () => {
  const previous = { temperature: 20.1, humidity: 48.2, battery: 77, linkQuality: 100 };
  const next = normalizeSnzb02pPayload({ temperature: 20.34, humidity: 105, battery: 85, linkquality: 999 }, { previous, updatedAt: '2026-10-21T10:00:00Z' });
  assert.deepEqual(next, { temperature: 20.34, humidity: 48.2, battery: 85, linkQuality: 100, online: true, updatedAt: '2026-10-21T10:00:00Z', model: 'SONOFF SNZB-02P', protocol: 'Zigbee' });
  assert.equal(normalizeSnzb02pPayload({ humidity: -1 }, { previous }), null);
  assert.deepEqual(normalizeSnzb02ldPayload({ temperature: 12.45, battery: 101 }, { previous: { temperature: 12, battery: 55, linkQuality: 80 }, confirmed: true }).battery, 55);
});

test('S5 richiede una sola temperatura iniziale per connessione e per riconnessione', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const requests = () => f.publishes.filter(({ topic }) => topic === 'zigbee2mqtt/pond-temp-acqua/get');
  assert.deepEqual(requests().map(({ payload }) => payload), [JSON.stringify({ temperature: '' })]);
  f.client.emit('connect');
  assert.equal(requests().length, 1);
  f.client.emit('close'); f.client.emit('connect');
  assert.deepEqual(requests().map(({ payload }) => payload), [JSON.stringify({ temperature: '' }), JSON.stringify({ temperature: '' })]);
  assert.equal(f.runtime.readSnapshot().S5.available, false);
  f.client.emit('message', 'zigbee2mqtt/pond-temp-acqua', Buffer.from(JSON.stringify({ battery: 87 })), { retain: false });
  assert.equal(f.runtime.readSnapshot().S5.available, false);
  f.message('zigbee2mqtt/pond-temp-acqua', { temperature: 12.4, battery: 87 });
  assert.equal(f.runtime.readSnapshot().S5.available, true);
  f.runtime.close();
});

test('MQTT freshness 120 minuti, offline senza perdita del valore e timestamp', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.equal(f.runtime.readSnapshot().S1.online, false);
  f.message('zigbee2mqtt/SmartHomeS1', { temperature: 27.8, humidity: 49.9 });
  const updatedAt = f.runtime.readSnapshot().S1.updatedAt;
  f.advance(120 * 60 * 1000); assert.equal(f.runtime.readSnapshot().S1.online, true);
  f.advance(1);
  const stale = f.runtime.readSnapshot().S1;
  assert.equal(stale.online, false); assert.equal(stale.temperature, 27.8); assert.equal(stale.updatedAt, updatedAt);
  f.runtime.close();
});

test('MQTT errore/disconnessione/reconnect e cleanup non duplicano client', () => {
  const f = fixture(); let changes = 0;
  f.runtime.subscribeState(() => { changes += 1; });
  f.runtime.start(); f.runtime.start(); f.client.emit('connect');
  f.message('zigbee2mqtt/SmartHomeS1', { temperature: 20, humidity: 50 });
  f.client.emit('error', new Error('broker offline')); f.client.emit('offline'); f.client.emit('close');
  assert.equal(f.runtime.readSnapshot().S1.available, false);
  assert.equal(f.runtime.readSnapshot().S1.temperature, 20);
  f.client.emit('connect'); assert.equal(f.runtime.readSnapshot().S1.available, true);
  assert.equal(f.subscriptions.length, 2); assert.equal(f.connects(), 1); assert.ok(changes > 0);
  f.runtime.close(); f.runtime.close(); f.runtime.start(); f.client.emit('connect');
  assert.equal(f.ends(), 1); assert.equal(f.subscriptions.length, 2);
  const failed = new HomeZigbeeSensorRuntime({ connect() { throw Error('not available'); } });
  assert.doesNotThrow(() => failed.start()); assert.equal(failed.readSnapshot().S1.online, false); failed.close();
});

test('Home snapshot Zigbee completo e LS3/S3 continuano a provenire dal WT200', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  for (const id of ['S1', 'S2', 'S4']) f.message(`zigbee2mqtt/SmartHome${id}`, { temperature: 27.8, humidity: 49.9, battery: 100, linkquality: 192 });
  f.message('zigbee2mqtt/pond-temp-acqua', { temperature: 12.4, battery: 87, linkquality: 93 });
  let cloudReads = 0;
  const home = new HomeStatusRuntime({ now: f.now, hardwareStore: { async read() { return { devices: [] }; } },
    roleStore: { async read() { return {}; } }, readZigbeeSensors: () => f.runtime.readSnapshot(),
    createSensorRuntime() { cloudReads += 1; throw Error('not required'); },
    readThermostat: async () => ({ online: true, updatedAt: new Date(f.now()).toISOString(), thermostat: { currentTemperature: 22 } }) });
  f.runtime.subscribeState(() => home.invalidate());
  const snapshot = await home.readSnapshot();
  for (const id of ['S1', 'S2', 'S4']) {
    const sensor = snapshot.sensors[id];
    assert.equal(sensor.temperature, 27.8); assert.equal(sensor.humidity, 49.9);
    assert.equal(sensor.battery, 100); assert.equal(sensor.linkQuality, 192); assert.equal(sensor.online, true);
    assert.equal(sensor.model, 'SONOFF SNZB-02P'); assert.equal(sensor.protocol, 'Zigbee');
  }
  assert.deepEqual(snapshot.sensors.S5, {
    temperature: 12.4, humidity: null, battery: 87, linkQuality: 93, name: 'SONOFF — Temperatura acqua', model: 'SNZB-02LD', protocol: 'Zigbee', source: 'zigbee', configured: true, requiresFreshness: true, online: true, available: true, value: 12.4, updatedAt: new Date(f.now()).toISOString(), reason: null,
  });
  assert.equal(snapshot.sensors.S3.value, 22); assert.equal(snapshot.sensors.S3.source, 'thermostat');
  assert.equal(cloudReads, 0);
  const store = createFloorplanState(); store.applyHomeSnapshot(snapshot);
  assert.equal(store.snapshot().sensors.S3, 22); assert.equal(store.snapshot().sensorDetails.S1.humidity, 49.9);
  store.applyThermostatSnapshot({ thermostat: { currentTemperature: 23 } });
  assert.equal(store.snapshot().sensors.S3, 23); assert.equal(store.snapshot().sensorDetails.S1.temperature, 27.8);
  f.advance(90_001); assert.equal((await home.readSnapshot()).sensors.S1.online, true);
  f.client.emit('close'); const disconnected = await home.readSnapshot();
  assert.equal(disconnected.sensors.S1.available, false); assert.equal(disconnected.sensors.S1.value, null);
  assert.equal(disconnected.sensors.S1.temperature, 27.8);
  f.client.emit('connect'); f.advance(120 * 60 * 1000);
  const stale = await home.readSnapshot(); assert.equal(stale.sensors.S1.online, false);
  assert.equal(stale.sensors.S1.temperature, 27.8); f.runtime.close();
});

test('API Home serve dati MQTT normalizzati e modulo popup anche con broker offline', async t => {
  const f = fixture(); f.runtime.start();
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime,
    hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } },
    thermostatRuntime: { async readSnapshot() { return { online: true, updatedAt: new Date().toISOString(), thermostat: { currentTemperature: 22 } }; } },
    cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  f.client.emit('error', Error('broker unavailable')); f.client.emit('offline');
  let snapshot = await (await fetch(`${base}/api/home/status`)).json();
  assert.equal(snapshot.sensors.S1.online, false); assert.equal(snapshot.sensors.S3.value, 22);
  f.client.emit('connect');
  // API normalization uses the real wall clock; these are still simulated MQTT messages.
  f.advance(Date.now() - f.now());
  f.message('zigbee2mqtt/SmartHomeS1', { temperature: 27.8, humidity: 49.9, battery: 100, linkquality: 192, update: { state: 'idle' } });
  snapshot = await (await fetch(`${base}/api/home/status`)).json();
  assert.equal(snapshot.sensors.S1.temperature, 27.8); assert.equal(snapshot.sensors.S1.available, true);
  assert.equal(snapshot.sensors.S1.humidity, 49.9); assert.equal(snapshot.sensors.S1.update, undefined);
  const module = await fetch(`${base}/js/sensor-popup.js`); assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /javascript/);
});

test('SSE sensori inoltra subito MQTT e lo store planimetria applica il nuovo valore senza polling', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime,
    hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } },
    thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrongMethod = await fetch(base + '/api/sensors/events', { method: 'POST' }); assert.equal(wrongMethod.status, 405);
  const first = await fetch(base + '/api/sensors/events'); const reader = first.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value); assert.match(initial, /retry: 2000/);
  f.message('zigbee2mqtt/SmartHomeS1', { temperature: 20.34, humidity: 48.1, battery: 80, linkquality: 90 });
  const event = new TextDecoder().decode((await reader.read()).value); assert.match(event, /"temperature":20\.34/);
  const store = createFloorplanState(); store.applyZigbeeSensorsSnapshot(f.runtime.readSnapshot());
  assert.equal(store.snapshot().sensors.S1, 20.34); assert.equal(store.snapshot().sensorDetails.S1.humidity, 48.1);
  await reader.cancel();
  const reconnected = await fetch(base + '/api/sensors/events'); const reconnectReader = reconnected.body.getReader();
  const snapshot = new TextDecoder().decode((await reconnectReader.read()).value); assert.match(snapshot, /"temperature":20\.34/); await reconnectReader.cancel();
});
