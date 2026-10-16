import test from 'node:test';
import assert from 'node:assert/strict';
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
