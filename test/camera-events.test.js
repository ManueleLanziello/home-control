import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeCameraEvents } from '../src/camera-events.js';

test('storico usa ultime 12 ore, attraversa mezzanotte, deduplica e ordina', () => {
  const now = new Date(2026, 8, 22, 8, 0, 0).getTime();
  const seconds = value => Math.floor(value / 1000);
  const payload = { recordings: { available: true, clips: [
    { startTime: seconds(new Date(2026, 8, 22, 7, 55).getTime()), endTime: seconds(new Date(2026, 8, 22, 7, 55, 14).getTime()), vedio_type: 1 },
    { startTime: seconds(new Date(2026, 8, 22, 7, 55).getTime()), endTime: seconds(new Date(2026, 8, 22, 7, 55, 14).getTime()), vedio_type: 1 },
    { startTime: seconds(new Date(2026, 8, 21, 23, 58).getTime()), endTime: seconds(new Date(2026, 8, 21, 23, 58, 11).getTime()), vedio_type: 2 },
    { startTime: seconds(new Date(2026, 8, 21, 19, 0).getTime()), endTime: seconds(new Date(2026, 8, 21, 19, 0, 5).getTime()), vedio_type: 2 },
  ] } };
  assert.deepEqual(normalizeCameraEvents(payload, now).events.map(({ startTime, durationSeconds }) => ({ startTime, durationSeconds })), [
    { startTime: seconds(new Date(2026, 8, 22, 7, 55).getTime()), durationSeconds: 14 },
    { startTime: seconds(new Date(2026, 8, 21, 23, 58).getTime()), durationSeconds: 11 },
  ]);
});

test('storico senza dati o offline resta fail-safe', () => {
  assert.deepEqual(normalizeCameraEvents({ recordings: { available: false, clips: [] } }).events, []);
});

test('ogni evento espone un ID stabile backend-validabile senza esporre path', () => {
  const now = Date.now(); const startTime = Math.floor(now / 1000) - 20; const endTime = startTime + 10;
  const events = normalizeCameraEvents({ recordings: { available: true, clips: [{ startTime, endTime }] } }, now).events;
  assert.equal(events[0].id, `${startTime}-${endTime}`); assert.equal(Object.hasOwn(events[0], 'path'), false);
});

test('popup chiede il video solo al click e rilascia il player tornando alla lista o chiudendo', async () => {
  const source = await readFile(new URL('../public/js/camera-events-popup.js', import.meta.url), 'utf8');
  assert.match(source, /row\.addEventListener\('click'/);
  assert.match(source, /\/events\/\$\{encodeURIComponent\(event\.id\)\}\/video/);
  assert.match(source, /removeAttribute\('src'\)/);
  assert.match(source, /dialog\.addEventListener\('close'/);
});
