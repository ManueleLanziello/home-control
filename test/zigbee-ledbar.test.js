import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { HomeZigbeeSensorRuntime } from '../src/zigbee-sensor-runtime.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { createHomeControlServer } from '../server.js';

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
  return { runtime, client, subscriptions, publishes, message: payload => client.emit('message', 'zigbee2mqtt/SmartHomeLB1', Buffer.from(JSON.stringify(payload))), advance: milliseconds => { now += milliseconds; } };
}

test('LB1 richiede state/brightness solo dopo subscribe riuscita, una volta per connessione', () => {
  const f = fixture(); const callbacks = []; const raw = [];
  f.client.subscribe = (topics, options, callback) => callbacks.push(callback);
  f.client.publish = (topic, payload, options, callback) => { raw.push([topic, payload, options]); callback(null); };
  f.runtime.start(); f.client.emit('connect'); f.client.emit('connect');
  assert.equal(callbacks.length, 1); assert.equal(raw.length, 0);
  callbacks[0](null); callbacks[0](null);
  assert.deepEqual(raw, [['zigbee2mqtt/SmartHomeLB1/get', '{"state":"","brightness":""}', { qos: 0 }]]);
  assert.equal(f.runtime.readLedbarSnapshot().known, false);
  f.client.emit('close'); f.client.emit('connect');
  callbacks[0](null); assert.equal(raw.length, 1);
  callbacks[1](null); assert.equal(raw.length, 2);
  f.advance(24 * 60 * 60 * 1000);
  for (let i = 0; i < 10; i += 1) f.runtime.readLedbarSnapshot();
  assert.equal(raw.length, 2);
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
  assert.deepEqual(f.publishes.slice(1), [['zigbee2mqtt/SmartHomeLB1/set', { state: 'ON' }], ['zigbee2mqtt/SmartHomeLB1/set', { brightness: 254 }]]);
  assert.equal(f.runtime.readLedbarSnapshot().state, 'OFF');
  assert.equal(f.runtime.readLedbarSnapshot().brightness, 180);
  f.runtime.close();
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
  assert.deepEqual(f.publishes.slice(1), [['zigbee2mqtt/SmartHomeLB1/set', { state: 'OFF' }], ['zigbee2mqtt/SmartHomeLB1/set', { brightness: 0 }]]);
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

test('L1 resta limitata a Layer-01, LB1 ai Layer-18..21 e Layer-17 è invisibile', async () => {
  const [config, floorplan] = await Promise.all([readFile(new URL('../public/js/floorplan-config.js', import.meta.url), 'utf8'), readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8')]);
  assert.match(config, /lightId: 'L' \+ \(index \+ 1\).*LAYER-' \+ number/);
  assert.match(config, /ledbar: \{/);
  assert.match(config, /LAYER-18-OFF\.svg.*LAYER-19-ON-25\.svg.*LAYER-20-ON-75\.svg.*LAYER-21-ON-100\.svg/s);
  assert.match(floorplan, /loadMapping\(config\.mappings\.ledbar/);
  const staticLayers = floorplan.match(/const staticLayerNames = ([^\n]+)/)?.[1] || '';
  assert.doesNotMatch(staticLayers, /config\.mappings\.ledbar/);
});
