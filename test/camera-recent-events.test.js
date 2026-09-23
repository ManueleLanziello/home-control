import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeRecentEvents } from '../src/camera-recent-events.js';

test('normalizza eventi recenti con start_time come identità e ignora payload non validi', () => {
  assert.deepEqual(normalizeRecentEvents({ available: true, events: [
    { start_time: 20, end_time: 25, alarm_type: 6, events_1: 34 }, { start_time: 20, end_time: 28 }, { start_time: 10, end_time: 12 }, { start_time: 'bad', end_time: 30 },
  ] }), { available: true, events: [{ startTime: 20, endTime: 25 }, { startTime: 10, endTime: 12 }] });
});

test('layer alert usa SVG preparati, pulsazione morbida e reduced-motion senza alterare SVG', async () => {
  const [config, css, floorplan] = await Promise.all([
    readFile(new URL('../public/js/floorplan-config.js', import.meta.url), 'utf8'), readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'), readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
  ]);
  for (const name of ['LAYER-C1-ALARM.svg', 'LAYER-C2-ALARM.svg', 'LAYER-C3-ALARM.svg']) assert.match(config, new RegExp(name));
  assert.match(css, /floorplan-camera-event-pulse 1s ease-in-out infinite/); assert.match(css, /50% \{ opacity: \.05; \}/); assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(floorplan, /api\/cameras\/event-alerts/); assert.match(floorplan, /15_000/);
});
