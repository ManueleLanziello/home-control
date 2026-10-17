import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { doorContactLabel, doorContactVisualState } from '../public/js/alarm-floorplan.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';

test('DW1-DW8 retain the semantic SVG markers already owned by the alarm layer', () => {
  assert.deepEqual(floorplanConfig.alarm.sensors.slice(0, 8).map(sensor => [sensor.id, sensor.marker.label]), Array.from({ length: 8 }, (_, index) => [`DW${index + 1}`, `DW${index + 1}`]));
});

test('real contact visualization never falls back to the simulated alarm state', () => {
  assert.equal(doorContactVisualState({ available: true, contact: true }), 'normal');
  assert.equal(doorContactVisualState({ available: true, contact: false }), 'active');
  assert.equal(doorContactVisualState({ available: true, contact: null }), 'unknown');
  assert.equal(doorContactVisualState({ available: false, contact: true }), 'unknown');
  assert.equal(doorContactVisualState({ available: true, contact: false, batteryLow: true }), 'battery-low');
  assert.match(doorContactLabel('DW1', { available: false, contact: true, tamperState: 'detected' }), /non disponibile o stato storico; manomissione rilevata/);
});

test('Home snapshots retain door contacts separately from all alarm simulation fields', () => {
  const store = createFloorplanState();
  store.applyHomeSnapshot({ doorContacts: { DW1: { available: true, contact: false, tamperState: 'normal' } } });
  assert.deepEqual(store.snapshot().doorContacts.DW1, { available: true, contact: false, tamperState: 'normal' });
  store.applyHomeSnapshot({ doorContacts: { DW1: { available: true, contact: true, tamperState: 'detected' } } });
  assert.deepEqual(store.snapshot().doorContacts.DW1, { available: true, contact: true, tamperState: 'detected' });
  store.applyHomeSnapshot();
  assert.deepEqual(store.snapshot().doorContacts, {});
  assert.equal(store.snapshot().doorContacts.DW2, undefined);
});

test('the floorplan forwards its existing Home snapshot updates to alarm DW markers', async () => {
  const [floorplan, alarm] = await Promise.all(['../public/js/floorplan.js', '../public/js/alarm-floorplan.js'].map(file => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.match(floorplan, /alarmControls\.setDoorContacts\(state\.doorContacts\)/);
  assert.match(floorplan, /new EventSource\(homeControlPath\('\/api\/door-contacts\/events'\)\)/);
  assert.match(floorplan, /store\.applyDoorContactSnapshot\(JSON\.parse\(event\.data\)\)/);
  assert.match(floorplan, /new EventSource\(homeControlPath\('\/api\/motion-sensor\/events'\)\)/);
  assert.match(floorplan, /alarmControls\.setMotionSensor\(state\.motionSensor\)/);
  assert.match(alarm, /element\.dataset\.tamperState = realContact \? contact\.tamperState \|\| 'unknown' : ''/);
  assert.match(alarm, /element\.classList\.toggle\('is-alarm', !realContact && !realMotion && visualState === 'alarm'\)/);
});
