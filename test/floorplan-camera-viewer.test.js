import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('../public/js/floorplan.js', import.meta.url);
const stylePath = new URL('../public/floorplan.css', import.meta.url);

test('camera viewer autostarts, preserves frames, and cleans up on close', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /const CAMERA_FRAME_INTERVAL_MS = 250/);
  assert.match(script, /data-camera-close/);
  assert.doesNotMatch(script, /data-camera-live/);
  assert.match(script, /JSON\.stringify\(\{ active: true \}\)/);
  assert.match(script, /JSON\.stringify\(\{ active: false \}\)/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(script, /clearTimeout\(session\.timer\)/);
  assert.match(script, /window\.addEventListener\('pagehide'/);
  assert.match(script, /cameraEndpoint\(session\.id, 'image'\)/);
  assert.match(script, /session\.hasFrame/);
});

test('camera dialog is larger while preserving responsive image bounds', async () => {
  const style = await readFile(stylePath, 'utf8');
  assert.match(style, /width: min\(660px, 94vw\)/);
  assert.match(style, /max-height: 72dvh/);
  assert.match(style, /object-fit: contain/);
});
