import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeCameraDetection } from '../src/camera-detection.js';

test('Rilevazione normalizza solo il read-back master on/off', () => {
  assert.deepEqual(normalizeCameraDetection({ available: true, enabled: true }), { available: true, enabled: true });
  assert.deepEqual(normalizeCameraDetection({ available: true, enabled: false }), { available: true, enabled: false });
  assert.throws(() => normalizeCameraDetection({ available: false, enabled: null }), /Read-back Rilevazione/);
});

test('worker Rilevazione usa soltanto il master Motion e il suo read-back', async () => {
  const source = await readFile(new URL('../src/camera-detection.py', import.meta.url), 'utf8');
  assert.match(source, /camera\.setMotionDetection\(args\.enabled == "on"\)/);
  assert.match(source, /detection = camera\.getMotionDetection\(\)/);
  assert.doesNotMatch(source, /sensitivity|people_enabled|vehicle_enabled|non_vehicle_enabled/);
});
