import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { HomeZigbeeSensorRuntime } from '../src/zigbee-sensor-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';
import { createHomeControlServer } from '../server.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';

globalThis.window = { addEventListener() {} };
const { ledbarLayerFor } = await import('../public/js/floorplan.js');

function fixture() {
  let now = Date.parse('2026-09-19T12:00:00Z');
  const client = new EventEmitter();
  const subscriptions = []; const publishes = [];
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null); };
  client.publish = (topic, payload, options, callback) => { publishes.push([topic, JSON.parse(payload)]); callback(null); };
  client.end = () => {};
  const runtime = new HomeZigbeeSensorRuntime({ now: () => now, connect: () => client });
  return { runtime, client, subscriptions, publishes, now: () => now, message: payload => client.emit('message', 'zigbee2mqtt/SmartHomeLB1', Buffer.from(JSON.stringify(payload))), l1Message: payload => client.emit('message', 'zigbee2mqtt/cucina-L1', Buffer.from(JSON.stringify(payload))), l2Message: payload => client.emit('message', 'zigbee2mqtt/camera-L2', Buffer.from(JSON.stringify(payload))), l3Message: payload => client.emit('message', 'zigbee2mqtt/salotto-L3', Buffer.from(JSON.stringify(payload))), lightMessage: payload => client.emit('message', 'zigbee2mqtt/bagno-L5', Buffer.from(JSON.stringify(payload))), l6Message: payload => client.emit('message', 'zigbee2mqtt/cameretta-L6', Buffer.from(JSON.stringify(payload))), l8Message: payload => client.emit('message', 'zigbee2mqtt/giardino-L8', Buffer.from(JSON.stringify(payload))), l11Message: payload => client.emit('message', 'zigbee2mqtt/terrazzo-L11', Buffer.from(JSON.stringify(payload))), l12Message: payload => client.emit('message', 'zigbee2mqtt/terrazzo-L12', Buffer.from(JSON.stringify(payload))), sensorMessage: (id, payload) => client.emit('message', `zigbee2mqtt/SmartHome${id}`, Buffer.from(JSON.stringify(payload))), advance: milliseconds => { now += milliseconds; } };
}

test('LB1 e luci Zigbee richiedono lo stato solo dopo subscribe riuscita, una volta per connessione', () => {
  const f = fixture(); const callbacks = []; const raw = [];
  f.client.subscribe = (topics, options, callback) => callbacks.push(callback);
  f.client.publish = (topic, payload, options, callback) => { raw.push([topic, payload, options]); callback(null); };
  f.runtime.start(); f.client.emit('connect'); f.client.emit('connect');
  assert.equal(callbacks.length, 1); assert.equal(raw.length, 0);
  callbacks[0](null); callbacks[0](null);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('SmartHomeLB1/get')), [['zigbee2mqtt/SmartHomeLB1/get', '{"state":"","brightness":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('cucina-L1/get')), [['zigbee2mqtt/cucina-L1/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('camera-L2/get')), [['zigbee2mqtt/camera-L2/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('salotto-L3/get')), [['zigbee2mqtt/salotto-L3/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('bagno-L5/get')), [['zigbee2mqtt/bagno-L5/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('cameretta-L6/get')), [['zigbee2mqtt/cameretta-L6/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('giardino-L8/get')), [['zigbee2mqtt/giardino-L8/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('terrazzo-L11/get')), [['zigbee2mqtt/terrazzo-L11/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('terrazzo-L12/get')), [['zigbee2mqtt/terrazzo-L12/get', '{"state":""}', { qos: 0 }]]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('pond-temp-acqua/get')), [['zigbee2mqtt/pond-temp-acqua/get', '{"temperature":""}', { qos: 0 }]]);
  assert.equal(raw.filter(([topic]) => /SmartHomeS[124]\/get$/.test(topic)).length, 0);
  assert.equal(raw.length, 10);
  assert.equal(f.runtime.readLedbarSnapshot().known, false);
  f.client.emit('close'); f.client.emit('connect');
  callbacks[0](null); assert.equal(raw.length, 10);
  callbacks[1](null); assert.equal(raw.length, 20);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('cucina-L1/get')), [
    ['zigbee2mqtt/cucina-L1/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/cucina-L1/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('camera-L2/get')), [
    ['zigbee2mqtt/camera-L2/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/camera-L2/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('salotto-L3/get')), [
    ['zigbee2mqtt/salotto-L3/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/salotto-L3/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('bagno-L5/get')), [
    ['zigbee2mqtt/bagno-L5/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/bagno-L5/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('cameretta-L6/get')), [
    ['zigbee2mqtt/cameretta-L6/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/cameretta-L6/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('giardino-L8/get')), [
    ['zigbee2mqtt/giardino-L8/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/giardino-L8/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('terrazzo-L11/get')), [
    ['zigbee2mqtt/terrazzo-L11/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/terrazzo-L11/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('terrazzo-L12/get')), [
    ['zigbee2mqtt/terrazzo-L12/get', '{"state":""}', { qos: 0 }],
    ['zigbee2mqtt/terrazzo-L12/get', '{"state":""}', { qos: 0 }],
  ]);
  assert.deepEqual(raw.filter(([topic]) => topic.endsWith('pond-temp-acqua/get')), [
    ['zigbee2mqtt/pond-temp-acqua/get', '{"temperature":""}', { qos: 0 }],
    ['zigbee2mqtt/pond-temp-acqua/get', '{"temperature":""}', { qos: 0 }],
  ]);
  f.advance(24 * 60 * 60 * 1000);
  for (let i = 0; i < 10; i += 1) f.runtime.readLedbarSnapshot();
  assert.equal(raw.length, 20);
  f.runtime.close();
});

test('LB1 subscribe fallita/rifiutata o callback obsoleto/shutdown non inviano get', () => {
  for (const result of [[Error('subscribe failed')], [null, [{ qos: 128 }]]]) {
    const f = fixture(); f.client.subscribe = (topics, options, callback) => callback(...result);
    f.runtime.start(); f.client.emit('connect');
    assert.equal(f.publishes.length, 0); assert.equal(f.runtime.connected, false); f.runtime.close();
  }
  const f = fixture(); const callbacks = [];
  f.client.subscribe = (topics, options, callback) => callbacks.push(callback);
  f.runtime.start(); f.client.emit('connect'); f.client.emit('offline'); f.client.emit('connect');
  callbacks[0](null); assert.equal(f.publishes.length, 0);
  f.runtime.close(); callbacks[1](null); f.client.emit('connect');
  assert.equal(f.publishes.length, 0);
});

test('LB1 risposta normale notifica subscriber e freshness non disabilita lo stato conosciuto', async () => {
  const f = fixture(); const updates = [];
  f.runtime.subscribeState(() => updates.push(f.runtime.readLedbarSnapshot()));
  f.runtime.start(); f.client.emit('connect');
  assert.equal(f.runtime.readLedbarSnapshot().available, false);
  f.message({ state: 'OFF', brightness: 254 });
  assert.equal(updates.at(-1).state, 'OFF'); assert.equal(updates.at(-1).brightness, 254);
  f.advance(120 * 60 * 1000); assert.equal(f.runtime.readLedbarSnapshot().fresh, true);
  f.advance(1);
  const stale = f.runtime.readLedbarSnapshot();
  assert.equal(stale.fresh, false); assert.equal(stale.known, true);
  assert.equal(stale.available, true); assert.equal(stale.online, true);
  await f.runtime.setLedbarPower(true);
  assert.equal(f.runtime.readLedbarSnapshot().state, 'OFF');
  f.client.emit('offline');
  assert.equal(f.runtime.readLedbarSnapshot().available, false);
  assert.equal(f.runtime.readLedbarSnapshot().state, 'OFF'); f.runtime.close();
});

test('recovery LB1 non introduce timer o polling', async () => {
  const source = await readFile(new URL('../src/zigbee-sensor-runtime.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /setInterval|setTimeout/);
});

test('API luci autorizza gli ID registrati nel config Zigbee, inclusi L3 e L12 con identità stabile', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(source, /ZIGBEE_SENSOR_CONFIG\.lights\.some\(light => light\.id === lightPowerMatch\[1\]\)/);
  assert.deepEqual(ZIGBEE_SENSOR_CONFIG.lights.map(light => light.id), ['L1', 'L2', 'L3', 'L5', 'L6', 'L8', 'L11', 'L12']);
  assert.deepEqual(ZIGBEE_SENSOR_CONFIG.lights.find(light => light.id === 'L3'), { id: 'L3', name: 'salotto-L3', topic: 'zigbee2mqtt/salotto-L3', setTopic: 'zigbee2mqtt/salotto-L3/set', getTopic: 'zigbee2mqtt/salotto-L3/get', getPayload: { state: '' }, ieeeAddress: '0x7c31fafffef24d6c', model: 'ZBMINIL2', manufacturer: 'SONOFF' });
  assert.deepEqual(ZIGBEE_SENSOR_CONFIG.lights.at(-1), { id: 'L12', name: 'terrazzo-L12', topic: 'zigbee2mqtt/terrazzo-L12', setTopic: 'zigbee2mqtt/terrazzo-L12/set', getTopic: 'zigbee2mqtt/terrazzo-L12/get', getPayload: { state: '' }, ieeeAddress: '0x07c31faffffec2a2', model: 'ZBMINIL2', manufacturer: 'SONOFF' });
  const registry = JSON.parse(await readFile(new URL('../data/config/hardware.json', import.meta.url), 'utf8'));
  assert.deepEqual(registry.inventory.find(device => device.marker === 'L3'), { marker: 'L3', name: 'SONOFF L3 — Salotto', model: 'ZBMINIL2', manufacturer: 'SONOFF', type: 'Relè punto luce', protocol: 'Zigbee', identity: { ieeeAddress: '0x7c31fafffef24d6c' }, friendlyName: 'salotto-L3', topic: 'zigbee2mqtt/salotto-L3', presenceEnabled: false });
});

test('LB1 interpreta MQTT, conserva brightness durante OFF e pubblica i comandi Zigbee2MQTT', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/SmartHomeLB1'));
  f.message({ state: 'ON', brightness: 180 });
  assert.deepEqual(f.runtime.readLedbarSnapshot().state, 'ON');
  assert.equal(f.runtime.readLedbarSnapshot().brightness, 180);
  f.message({ state: 'OFF' });
  assert.equal(f.runtime.readLedbarSnapshot().state, 'OFF');
  assert.equal(f.runtime.readLedbarSnapshot().brightness, 180);
  await f.runtime.setLedbarPower(true); await f.runtime.setLedbarBrightness(254);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/SmartHomeLB1/set'), [['zigbee2mqtt/SmartHomeLB1/set', { state: 'ON' }], ['zigbee2mqtt/SmartHomeLB1/set', { brightness: 254 }]]);
  assert.equal(f.runtime.readLedbarSnapshot().state, 'OFF');
  assert.equal(f.runtime.readLedbarSnapshot().brightness, 180);
  f.runtime.close();
});

test('L5 riceve ON/OFF da bagno-L5 e pubblica il toggle sul topic Zigbee corretto', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/bagno-L5'));
  f.lightMessage({ state: 'ON' });
  assert.equal(f.runtime.readLightsSnapshot().L5.state, 'ON');
  assert.equal(f.runtime.readLightsSnapshot().L5.available, true);
  await f.runtime.setLightPower('L5', false);
  f.lightMessage({ state: 'OFF' });
  await f.runtime.setLightPower('L5', true);
  f.lightMessage({ state: 'ON' });
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/bagno-L5/set'), [['zigbee2mqtt/bagno-L5/set', { state: 'OFF' }], ['zigbee2mqtt/bagno-L5/set', { state: 'ON' }]]);
  assert.equal(f.runtime.readLightsSnapshot().L5.state, 'ON');
  f.runtime.close();
});

test('L1 riceve ON/OFF da cucina-L1 e pubblica il toggle sul topic Zigbee corretto', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/cucina-L1'));
  f.l1Message({ state: 'ON' }); assert.equal(f.runtime.readLightsSnapshot().L1.state, 'ON');
  await f.runtime.setLightPower('L1', false); f.l1Message({ state: 'OFF' });
  await f.runtime.setLightPower('L1', true); f.l1Message({ state: 'ON' });
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/cucina-L1/set'), [['zigbee2mqtt/cucina-L1/set', { state: 'OFF' }], ['zigbee2mqtt/cucina-L1/set', { state: 'ON' }]]);
  assert.equal(f.runtime.readLightsSnapshot().L1.state, 'ON'); f.runtime.close();
});

test('L2 riceve ON/OFF da camera-L2 e pubblica il toggle sul topic Zigbee corretto', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/camera-L2'));
  f.l2Message({ state: 'ON' }); assert.equal(f.runtime.readLightsSnapshot().L2.state, 'ON');
  await f.runtime.setLightPower('L2', false); f.l2Message({ state: 'OFF' });
  await f.runtime.setLightPower('L2', true); f.l2Message({ state: 'ON' });
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/camera-L2/set'), [['zigbee2mqtt/camera-L2/set', { state: 'OFF' }], ['zigbee2mqtt/camera-L2/set', { state: 'ON' }]]);
  assert.equal(f.runtime.readLightsSnapshot().L2.state, 'ON'); f.runtime.close();
});

test('L3 usa salotto-L3, verifica l IEEE e aggiorna solo dal feedback MQTT reale', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/salotto-L3'));
  assert.equal(f.runtime.readLightsSnapshot().L3.available, false);
  assert.equal(f.runtime.readLightsSnapshot().L3.identityStatus, 'unknown');
  f.client.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([{ friendly_name: 'salotto-L3', ieee_address: '0x7c31fafffef24d6c', definition: { model: 'ZBMINIL2', vendor: 'SONOFF' } }])));
  assert.equal(f.runtime.readLightsSnapshot().L3.identityStatus, 'verified');
  await f.runtime.setLightPower('L3', true);
  assert.equal(f.runtime.readLightsSnapshot().L3.state, null);
  f.l3Message({ state: 'ON' });
  assert.equal(f.runtime.readLightsSnapshot().L3.state, 'ON');
  await f.runtime.setLightPower('L3', false);
  f.l3Message({ state: 'OFF' });
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/salotto-L3/set'), [['zigbee2mqtt/salotto-L3/set', { state: 'ON' }], ['zigbee2mqtt/salotto-L3/set', { state: 'OFF' }]]);
  assert.equal(f.runtime.readLightsSnapshot().L3.state, 'OFF');
  f.runtime.close();
});

test('L6 riceve ON/OFF da cameretta-L6 e pubblica il toggle sul topic Zigbee corretto', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/cameretta-L6'));
  f.l6Message({ state: 'ON' }); assert.equal(f.runtime.readLightsSnapshot().L6.state, 'ON');
  await f.runtime.setLightPower('L6', false); f.l6Message({ state: 'OFF' });
  await f.runtime.setLightPower('L6', true); f.l6Message({ state: 'ON' });
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/cameretta-L6/set'), [['zigbee2mqtt/cameretta-L6/set', { state: 'OFF' }], ['zigbee2mqtt/cameretta-L6/set', { state: 'ON' }]]);
  assert.equal(f.runtime.readLightsSnapshot().L6.state, 'ON'); f.runtime.close();
});

test('L8, L11 e L12 ricevono ON/OFF dagli interruttori fisici e pubblicano sui topic Zigbee corretti', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/giardino-L8'));
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/terrazzo-L11'));
  assert.ok(f.subscriptions[0].includes('zigbee2mqtt/terrazzo-L12'));
  f.l8Message({ state: 'ON' }); f.l11Message({ state: 'OFF' }); f.l12Message({ state: 'ON' });
  assert.equal(f.runtime.readLightsSnapshot().L8.state, 'ON');
  assert.equal(f.runtime.readLightsSnapshot().L11.state, 'OFF');
  assert.equal(f.runtime.readLightsSnapshot().L12.state, 'ON');
  await f.runtime.setLightPower('L8', false); await f.runtime.setLightPower('L11', true); await f.runtime.setLightPower('L12', false);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/giardino-L8/set'), [['zigbee2mqtt/giardino-L8/set', { state: 'OFF' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/terrazzo-L11/set'), [['zigbee2mqtt/terrazzo-L11/set', { state: 'ON' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/terrazzo-L12/set'), [['zigbee2mqtt/terrazzo-L12/set', { state: 'OFF' }]]);
  f.runtime.close();
});

test('L12 resta sconosciuta prima del feedback reale e verifica l’identità bridge', () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  assert.equal(f.runtime.readLightsSnapshot().L12.known, false);
  assert.equal(f.runtime.readLightsSnapshot().L12.available, false);
  assert.equal(f.runtime.readLightsSnapshot().L12.identityStatus, 'unknown');
  f.client.emit('message', 'zigbee2mqtt/bridge/devices', Buffer.from(JSON.stringify([{ friendly_name: 'terrazzo-L12', ieee_address: '0x07c31faffffec2a2', definition: { model: 'ZBMINIL2', vendor: 'SONOFF' } }])));
  assert.equal(f.runtime.readLightsSnapshot().L12.identityStatus, 'verified');
  f.l12Message({ state: 'OFF' });
  assert.equal(f.runtime.readLightsSnapshot().L12.state, 'OFF');
  assert.equal(f.runtime.readLightsSnapshot().L12.available, true);
  f.runtime.close();
});

test('L5 è esposto nello snapshot Home e gli aggiornamenti MQTT invalidano il valore', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect'); f.lightMessage({ state: 'ON' });
  const home = new HomeStatusRuntime({ now: () => Date.parse('2026-09-19T12:00:00Z'), hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeLedbar: () => f.runtime.readLedbarSnapshot(), readZigbeeLights: () => f.runtime.readLightsSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }) });
  assert.equal((await home.readSnapshot()).lights.L5.state, 'ON');
  f.lightMessage({ state: 'OFF' }); home.invalidate();
  assert.equal((await home.readSnapshot()).lights.L5.state, 'OFF');
  f.runtime.close();
});

test('gli attuatori Zigbee conservano ON e OFF oltre la freshness dei sensori, mentre S1 diventa stale', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const home = new HomeStatusRuntime({ now: f.now, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeSensors: () => f.runtime.readSnapshot(), readZigbeeLights: () => f.runtime.readLightsSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }), readPresence: async () => ({}) });
  f.l1Message({ state: 'ON' }); f.l2Message({ state: 'OFF' }); f.lightMessage({ state: 'ON' }); f.l6Message({ state: 'OFF' }); f.l8Message({ state: 'ON' }); f.l11Message({ state: 'OFF' }); f.sensorMessage('S1', { temperature: 21.5, humidity: 50 });
  let snapshot = await home.readSnapshot();
  assert.equal(snapshot.lights.L1.available, true); assert.equal(snapshot.lights.L1.online, true);
  assert.equal(snapshot.lights.L1.state, 'ON'); assert.equal(snapshot.lights.L1.value, true);
  assert.equal(snapshot.lights.L2.available, true); assert.equal(snapshot.lights.L2.online, true);
  assert.equal(snapshot.lights.L2.state, 'OFF'); assert.equal(snapshot.lights.L2.value, false);
  assert.equal(snapshot.lights.L5.available, true); assert.equal(snapshot.lights.L5.online, true);
  assert.equal(snapshot.lights.L5.state, 'ON'); assert.equal(snapshot.lights.L5.value, true);
  assert.equal(snapshot.lights.L6.available, true); assert.equal(snapshot.lights.L6.online, true);
  assert.equal(snapshot.lights.L6.state, 'OFF'); assert.equal(snapshot.lights.L6.value, false);
  assert.equal(snapshot.lights.L8.available, true); assert.equal(snapshot.lights.L8.state, 'ON'); assert.equal(snapshot.lights.L8.value, true);
  assert.equal(snapshot.lights.L11.available, true); assert.equal(snapshot.lights.L11.state, 'OFF'); assert.equal(snapshot.lights.L11.value, false);
  assert.equal(snapshot.sensors.S1.available, true);
  f.advance(ZIGBEE_SENSOR_CONFIG.freshnessMs + 1); home.invalidate();
  snapshot = await home.readSnapshot();
  assert.equal(snapshot.lights.L1.available, true); assert.equal(snapshot.lights.L1.online, true);
  assert.equal(snapshot.lights.L1.state, 'ON'); assert.equal(snapshot.lights.L1.value, true);
  assert.equal(snapshot.lights.L2.available, true); assert.equal(snapshot.lights.L2.online, true);
  assert.equal(snapshot.lights.L2.state, 'OFF'); assert.equal(snapshot.lights.L2.value, false);
  assert.equal(snapshot.lights.L5.available, true); assert.equal(snapshot.lights.L5.online, true);
  assert.equal(snapshot.lights.L5.state, 'ON'); assert.equal(snapshot.lights.L5.value, true);
  assert.equal(snapshot.lights.L6.available, true); assert.equal(snapshot.lights.L6.online, true);
  assert.equal(snapshot.lights.L6.state, 'OFF'); assert.equal(snapshot.lights.L6.value, false);
  assert.equal(snapshot.lights.L8.available, true); assert.equal(snapshot.lights.L8.state, 'ON'); assert.equal(snapshot.lights.L8.value, true);
  assert.equal(snapshot.lights.L11.available, true); assert.equal(snapshot.lights.L11.state, 'OFF'); assert.equal(snapshot.lights.L11.value, false);
  assert.equal(snapshot.sensors.S1.available, false); assert.equal(snapshot.sensors.S1.online, false);
  f.lightMessage({ state: 'OFF' }); home.invalidate(); snapshot = await home.readSnapshot();
  f.advance(ZIGBEE_SENSOR_CONFIG.freshnessMs + 1); home.invalidate(); snapshot = await home.readSnapshot();
  assert.equal(snapshot.lights.L5.available, true); assert.equal(snapshot.lights.L5.online, true);
  assert.equal(snapshot.lights.L5.state, 'OFF'); assert.equal(snapshot.lights.L5.value, false);
  f.runtime.close();
});

test('lo store planimetria converte gli stati Zigbee senza alterare le luci simulate', () => {
  const store = createFloorplanState();
  store.applyHomeSnapshot({ lights: { L1: { source: 'zigbee', available: true, state: 'ON' }, L2: { source: 'zigbee', available: true, state: 'OFF' }, L5: { source: 'zigbee', available: true, state: 'ON' }, L6: { source: 'zigbee', available: true, state: 'OFF' }, L8: { source: 'zigbee', available: true, state: 'ON' }, L11: { source: 'zigbee', available: true, state: 'OFF' } } });
  assert.equal(store.snapshot().lights.L1, true);
  assert.equal(store.snapshot().lights.L2, false);
  assert.equal(store.snapshot().lights.L5, true);
  assert.equal(store.snapshot().lights.L6, false);
  assert.equal(store.snapshot().lights.L8, true);
  assert.equal(store.snapshot().lights.L11, false);
  assert.equal(store.snapshot().lightSources.L5, 'zigbee');
  assert.equal(store.snapshot().lightSources.L1, 'zigbee');
  assert.equal(store.snapshot().lightSources.L2, 'zigbee');
  assert.equal(store.snapshot().lightSources.L6, 'zigbee');
  assert.equal(store.snapshot().lightSources.L8, 'zigbee');
  assert.equal(store.snapshot().lightSources.L11, 'zigbee');
});

test('API luci Zigbee e SSE ricevono feedback fisico senza un secondo client MQTT', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = await fetch(base + '/api/lights/events'); const reader = events.body.getReader(); await reader.read();
  f.l1Message({ state: 'ON' });
  const l1Event = new TextDecoder().decode((await reader.read()).value);
  assert.match(l1Event, /"L1"/); assert.match(l1Event, /"state":"ON"/);
  f.l2Message({ state: 'OFF' });
  const l2Event = new TextDecoder().decode((await reader.read()).value);
  assert.match(l2Event, /"L2"/); assert.match(l2Event, /"state":"OFF"/);
  f.lightMessage({ state: 'ON' });
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /"L5"/); assert.match(event, /"state":"ON"/);
  f.l6Message({ state: 'OFF' });
  const l6Event = new TextDecoder().decode((await reader.read()).value);
  assert.match(l6Event, /"L6"/); assert.match(l6Event, /"state":"OFF"/); await reader.cancel();
  f.l8Message({ state: 'ON' });
  f.l11Message({ state: 'OFF' });
  assert.equal((await fetch(base + '/api/lights/L1/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) })).status, 202);
  assert.equal((await fetch(base + '/api/lights/L2/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })).status, 202);
  assert.equal((await fetch(base + '/api/lights/L5/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) })).status, 202);
  assert.equal((await fetch(base + '/api/lights/L6/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })).status, 202);
  assert.equal((await fetch(base + '/api/lights/L8/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) })).status, 202);
  assert.equal((await fetch(base + '/api/lights/L11/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })).status, 202);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/cucina-L1/set'), [['zigbee2mqtt/cucina-L1/set', { state: 'OFF' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/camera-L2/set'), [['zigbee2mqtt/camera-L2/set', { state: 'ON' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/bagno-L5/set'), [['zigbee2mqtt/bagno-L5/set', { state: 'OFF' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/cameretta-L6/set'), [['zigbee2mqtt/cameretta-L6/set', { state: 'ON' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/giardino-L8/set'), [['zigbee2mqtt/giardino-L8/set', { state: 'OFF' }]]);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/terrazzo-L11/set'), [['zigbee2mqtt/terrazzo-L11/set', { state: 'ON' }]]);
});

test('LB1 è esposto nello snapshot Home e ogni aggiornamento MQTT invalida lo stato', async () => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect'); f.message({ state: 'ON', brightness: 1 });
  const home = new HomeStatusRuntime({ now: () => Date.parse('2026-09-19T12:00:00Z'), hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, readZigbeeLedbar: () => f.runtime.readLedbarSnapshot(), readThermostat: async () => ({ online: false, thermostat: {} }) });
  assert.deepEqual((await home.readSnapshot()).ledbar.state, 'ON');
  assert.equal((await home.readSnapshot()).ledbar.brightness, 1);
  f.runtime.close();
});

test('API LB1 convalida e inoltra ON/OFF e brightness senza creare un secondo client MQTT', async t => {
  const f = fixture(); f.runtime.start(); f.client.emit('connect');
  const server = createHomeControlServer({ zigbeeRuntime: f.runtime, hardwareStore: { async read() { return { devices: [] }; } }, roleStore: { async read() { return {}; } }, thermostatRuntime: { async readSnapshot() { return { online: false, thermostat: {} }; } }, cameraRuntime: { snapshot: async () => ({}), close: async () => {} } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const events = await fetch(base + '/api/ledbar/events');
  const reader = events.body.getReader();
  await reader.read(); // Initial unknown snapshot, not a confirmation from /get.
  f.message({ state: 'OFF', brightness: 254 });
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /"state":"OFF"/); assert.match(event, /"brightness":254/);
  await reader.cancel();
  assert.equal((await fetch(base + '/api/ledbar/power', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) })).status, 202);
  assert.equal((await fetch(base + '/api/ledbar/brightness', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brightness: 255 }) })).status, 400);
  assert.equal((await fetch(base + '/api/ledbar/brightness', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brightness: 0 }) })).status, 202);
  assert.deepEqual(f.publishes.filter(([topic]) => topic === 'zigbee2mqtt/SmartHomeLB1/set'), [['zigbee2mqtt/SmartHomeLB1/set', { state: 'OFF' }], ['zigbee2mqtt/SmartHomeLB1/set', { brightness: 0 }]]);
});

test('la scelta del layer LB1 usa le quattro soglie richieste', () => {
  assert.equal(ledbarLayerFor({ state: 'OFF', brightness: 180 }), 'off');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 0 }), 'off');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 1 }), 'low');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 127 }), 'low');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 128 }), 'medium');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 222 }), 'medium');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 223 }), 'high');
  assert.equal(ledbarLayerFor({ state: 'ON', brightness: 254 }), 'high');
});

test('LB1 usa state per il toggle e dichiara esplicitamente hit-area SVG e slider', async () => {
  const [floorplan, style] = await Promise.all([readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'), readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8')]);
  assert.match(floorplan, /const ledbarOn = ledbar\.state === 'ON'/);
  assert.match(floorplan, /onLedbarPower\(ledbar\.state !== 'ON'\)/);
  assert.match(floorplan, /placeHtml\(ledbarMapping, config\.ledbar\.marker, ledbarMarker, true\)/);
  assert.match(floorplan, /placeHtml\(ledbarMapping, config\.ledbar\.slider, ledbarSlider, true\)/);
  assert.match(style, /\.floorplan-interaction-host \{ pointer-events: auto; \}/);
  assert.match(style, /\.floorplan-ledbar-slider \{[^}]*pointer-events: auto;[^}]*touch-action: none;/);
});

test('le room luce attive includono L3 reale, LB1 usa Layer-18..21 e Layer-17 è invisibile', async () => {
  const [config, floorplan] = await Promise.all([readFile(new URL('../public/js/floorplan-config.js', import.meta.url), 'utf8'), readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8')]);
  assert.match(config, /rooms: \['L1', 'L2', 'L3', 'L5', 'L6', 'L13'\]/);
  assert.doesNotMatch(config, /lightId: 'L4'/);
  assert.match(config, /ledbar: \{/);
  assert.match(config, /LAYER-18-OFF\.svg.*LAYER-19-ON-25\.svg.*LAYER-20-ON-75\.svg.*LAYER-21-ON-100\.svg/s);
  assert.match(floorplan, /loadMapping\(config\.mappings\.ledbar/);
  const staticLayers = floorplan.match(/const staticLayerNames = ([^\n]+)/)?.[1] || '';
  assert.doesNotMatch(staticLayers, /config\.mappings\.ledbar/);
});
