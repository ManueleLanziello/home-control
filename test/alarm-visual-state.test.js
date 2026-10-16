import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { alarmVisualState } from '../public/js/alarm-floorplan.js';
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
