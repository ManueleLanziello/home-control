import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { normalizeCameraPrivacy } from '../src/camera-privacy.js';

test('Privacy normalizza solo read-back booleani reali', () => {
  assert.deepEqual(normalizeCameraPrivacy({ available: true, enabled: true }), { available: true, enabled: true });
  assert.deepEqual(normalizeCameraPrivacy({ available: true, enabled: false }), { available: true, enabled: false });
  assert.throws(() => normalizeCameraPrivacy({ available: false, enabled: null }), /Read-back Privacy/);
});

test('worker Privacy esegue getter e setter pubblici con read-back', async () => {
  const source = await readFile(new URL('../src/camera-privacy.py', import.meta.url), 'utf8');
  assert.match(source, /camera\.setPrivacyMode\(args\.enabled == "on"\)/);
  assert.match(source, /privacy = camera\.getPrivacyMode\(\)/);
  assert.match(source, /enabled not in \("on", "off"\)/);
});
