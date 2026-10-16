import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('alarm markers use the camera immediate-icon path and never use marker IDs as fallbacks', async () => {
  const source = await readFile(new URL('../public/js/alarm-floorplan.js', import.meta.url), 'utf8');
  assert.equal((source.match(/immediate: true/g) || []).length, 4);
  assert.doesNotMatch(source, /createIcon\([^\n]+, item\.id\)/);
  assert.doesNotMatch(source, /createIcon\([^\n]+, 'A'\)/);
});
