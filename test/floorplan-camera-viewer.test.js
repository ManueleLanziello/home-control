import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const scriptPath = new URL('../public/js/floorplan.js', import.meta.url);
const stylePath = new URL('../public/floorplan.css', import.meta.url);

test('camera viewer autostarts and closes both owned and shared cameras without waiting for STOP', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const closeCamera = script.slice(script.indexOf('async function closeCamera'), script.indexOf('async function refreshCameraFrame'));
  assert.match(script, /const CAMERA_FRAME_INTERVAL_MS = 250/);
  assert.match(script, /data-camera-close/);
  assert.doesNotMatch(script, /data-camera-live/);
  assert.match(script, /JSON\.stringify\(\{ active: true \}\)/);
  assert.match(closeCamera, /JSON\.stringify\(\{ active: false \}\)/);
  assert.match(closeCamera, /cameraEndpoint\(session\.id, 'live'\)/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(closeCamera, /clearTimeout\(session\.timer\)/);
  assert.match(closeCamera, /session\.controller\.abort\(\)/);
  assert.match(closeCamera, /if \(dialog\.open\) dialog\.close\(\);/);
  assert.ok(closeCamera.indexOf('if (dialog.open) dialog.close();') < closeCamera.indexOf('await stopRequest'));
  assert.match(script, /window\.addEventListener\('pagehide'/);
  assert.match(script, /cameraEndpoint\(session\.id, 'image'\)/);
  assert.match(script, /session\.hasFrame/);
});

test('camera dialog preserves width and follows the image height without artificial bands', async () => {
  const style = await readFile(stylePath, 'utf8');
  const script = await readFile(scriptPath, 'utf8');
  const dialogRule = style.match(/\.floorplan-camera-dialog \{([^}]*)\}/)[1];
  const imageRule = style.match(/\.floorplan-camera-dialog img \{([^}]*)\}/)[1];
  assert.match(script, /floorplan-camera-header/);
  assert.match(script, />×<\/button>/);
  assert.doesNotMatch(script, /Chiudi ×/);
  assert.match(style, /width: min\(990px, 94vw\)/);
  assert.match(style, /max-width: 94vw/);
  assert.match(style, /max-height: 90dvh/);
  assert.match(style, /padding: 10px/);
  assert.doesNotMatch(dialogRule, /(?:^|;)\s*(?:height|min-height)\s*:/);
  assert.doesNotMatch(imageRule, /flex:/);
  assert.match(imageRule, /height: auto/);
  assert.match(imageRule, /margin: 0/);
  assert.match(imageRule, /object-fit: contain/);
});
