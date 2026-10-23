import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alarmVisualState, motionSensorVisualState } from '../public/js/alarm-floorplan.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';

test('alarm icon background state follows the documented priority', () => {
  assert.equal(alarmVisualState('DW1', { available: false, batteryLow: true, closed: false }, { sensorId: 'DW1' }), 'alarm');
  assert.equal(alarmVisualState('DW1', { available: false, batteryLow: true, closed: false }), 'unknown');
  assert.equal(alarmVisualState('DW1', { available: true, batteryLow: true, closed: false }), 'battery-low');
  assert.equal(alarmVisualState('DW1', { available: true, batteryLow: false, closed: false }), 'active');
  assert.equal(alarmVisualState('DW1', { available: true, batteryLow: false, closed: true }), 'normal');
});

test('motion sensor and siren use their existing state fields', () => {
  assert.equal(alarmVisualState('PR1', { available: true, motion: true }), 'active');
  assert.equal(alarmVisualState('PR1', { available: true, motion: false }), 'normal');
  assert.equal(alarmVisualState('SR1', { available: true, active: true }), 'alarm');
  assert.equal(alarmVisualState('SR1', { available: true, active: false }), 'normal');
});

test('PR1 reale conserva gli stessi colori senza trasformare lo sconosciuto in assenza di movimento', () => {
  assert.equal(motionSensorVisualState({ available: true, occupancy: true, battery: 70 }), 'active');
  assert.equal(motionSensorVisualState({ available: true, occupancy: false, battery: 70 }), 'normal');
  assert.equal(motionSensorVisualState({ available: true, occupancy: null, battery: 70 }), 'unknown');
  assert.equal(motionSensorVisualState({ available: false, occupancy: false, battery: 70 }), 'unknown');
  assert.equal(motionSensorVisualState({ available: true, occupancy: true, battery: 20 }), 'battery-low');
});

test('alarm sensors no longer depend on removed LED markers', () => {
  assert.ok(floorplanConfig.alarm.sensors.every(sensor => !Object.hasOwn(sensor, 'led')));
});

test('only PR1 blinks orange for movement while alarm priority remains red', async () => {
  const [css, floorplan] = await Promise.all([readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'), readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8')]);
  assert.match(floorplan, /element\.dataset\.alarmSensorId = item\.id/);
  assert.match(css, /\.floorplan-marker-alarm-sensor\[data-alarm-sensor-id="PR1"\]\[data-alarm-state="active"\] \{[^}]*animation: alarm-flash 1\.6s ease-in-out infinite/);
  assert.match(css, /@keyframes alarm-flash \{ 50% \{ border-color: var\(--alarm-border-color, #e55663\)/);
  assert.equal(alarmVisualState('PR1', { available: false, batteryLow: true, motion: true }, { sensorId: 'PR1' }), 'alarm');
  assert.equal(alarmVisualState('PR1', { available: false, batteryLow: true, motion: true }), 'unknown');
  assert.equal(alarmVisualState('PR1', { available: true, batteryLow: true, motion: true }), 'battery-low');
});

test('DW backgrounds are opaque while SR1 and PR1 retain their 40 percent transparency', async () => {
  const css = await readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8');
  for (const color of ['rgb(119 136 150)', 'rgb(41 223 146)', 'rgb(255 157 61)', 'rgb(255 229 106)']) {
    assert.match(css, new RegExp(`\\.floorplan-marker-alarm-sensor\\[data-alarm-sensor-id\\^="DW"\\][^{]*\\{ background: ${color.replace(/[()]/g, '\\$&')};`));
  }
  assert.match(css, /data-alarm-sensor-id\^="DW"\] \{ --alarm-background: rgb\(155 31 40\)/);
  assert.match(css, /data-alarm-sensor-id="PR1"[^}]*--alarm-background: rgb\(255 157 61 \/ 40%\)/);
});

test('popup ANTIFURTO usa close.svg e card modalità ingrandite senza cambiare la logica', async () => {
  const [css, floorplan] = await Promise.all([readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'), readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8')]);
  assert.match(floorplan, /homeControlPath\('\/design\/close\.svg'\)/);
  assert.doesNotMatch(floorplan, /STATI ZIGBEE REALI/);
  assert.match(css, /\.alarm-dialog header button \{ display:grid; width:40px; height:40px/);
  assert.match(css, /\.alarm-mode img \{ width:64px; height:64px/);
  assert.match(css, /\.alarm-mode \{ display:grid; gap:7px; justify-items:center; padding:12px 5px/);
});

test('popup SR1 mantiene la configurazione esistente e aggiunge pausa e numero cicli', async () => {
  const floorplan = await readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /name="duration"[^>]*min="1"[^>]*max="900"/);
  assert.match(floorplan, /Pausa <span><input name="pauseSeconds" type="number" min="0" max="900"/);
  assert.match(floorplan, /Numero cicli <input name="cycleCount" type="number" min="1" max="20" step="1"/);
  assert.match(floorplan, /pauseSeconds: Number\(data\.get\('pauseSeconds'\)\)/);
  assert.match(floorplan, /cycleCount: Number\(data\.get\('cycleCount'\)\)/);
  assert.match(floorplan, /result\.durationSeconds \* 1000/);
});
