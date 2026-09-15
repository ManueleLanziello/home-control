import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const scriptPath = new URL('../public/js/floorplan.js', import.meta.url);
const stylePath = new URL('../public/floorplan.css', import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadCloseCameraViewer(script, fetch) {
  const cameraEndpoint = script.match(/function cameraEndpoint[^\n]+/)[0];
  const closeCameraViewer = script.slice(script.indexOf('async function closeCameraViewer'), script.indexOf('async function refreshCameraFrame'));
  const clearedTimers = [];
  const context = { clearTimeout: timer => clearedTimers.push(timer), fetch, homeControlPath: value => value, URL: { revokeObjectURL: () => {} } };
  vm.runInNewContext(`${cameraEndpoint}\n${closeCameraViewer}\nglobalThis.closeCameraViewer = closeCameraViewer;`, context);
  return { close: context.closeCameraViewer, clearedTimers };
}

function viewerDialog(id) {
  const controller = { aborted: false, abort() { this.aborted = true; } };
  return {
    open: true,
    removed: false,
    closeCalls: 0,
    _cameraSession: { id, closing: false, timer: 1, controller, objectUrl: null },
    close() { this.closeCalls += 1; this.open = false; },
    remove() { this.removed = true; }
  };
}

test('camera viewer autostarts and closes C1/C2 immediately while STOP continues in background', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const closeCameraViewer = script.slice(script.indexOf('async function closeCameraViewer'), script.indexOf('async function refreshCameraFrame'));
  assert.match(script, /const CAMERA_FRAME_INTERVAL_MS = 250/);
  assert.match(script, /data-camera-close/);
  assert.match(script, /closeCameraViewer\(dialog\)/);
  assert.doesNotMatch(script, /data-camera-live/);
  assert.match(script, /JSON\.stringify\(\{ active: true \}\)/);
  assert.match(closeCameraViewer, /JSON\.stringify\(\{ active: false \}\)/);
  assert.match(closeCameraViewer, /cameraEndpoint\(session\.id, 'live'\)/);
  assert.match(script, /new AbortController\(\)/);
  assert.match(closeCameraViewer, /clearTimeout\(session\.timer\)/);
  assert.match(closeCameraViewer, /session\.controller\.abort\(\)/);
  assert.match(closeCameraViewer, /dialog\.remove\(\)/);
  assert.ok(closeCameraViewer.indexOf('dialog.remove();') < closeCameraViewer.indexOf('await stopRequest'));
  assert.match(script, /window\.addEventListener\('pagehide'/);
  assert.match(script, /cameraEndpoint\(session\.id, 'image'\)/);
  assert.match(script, /session\.hasFrame/);

  for (const id of ['C1', 'C2']) {
    const stop = deferred();
    const calls = [];
    const { close, clearedTimers } = loadCloseCameraViewer(script, (...args) => { calls.push(args); return stop.promise; });
    const dialog = viewerDialog(id);
    const controller = dialog._cameraSession.controller;
    const closing = close(dialog);
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], new RegExp(`/api/cameras/${id}/live$`));
    assert.equal(dialog._cameraSession, null);
    assert.equal(dialog.open, false);
    assert.equal(dialog.removed, true);
    assert.equal(dialog.closeCalls, 1);
    assert.deepEqual(clearedTimers, [1]);
    assert.equal(dialog._cameraSession, null);
    assert.equal(controller.aborted, true);
    stop.resolve();
    await closing;
    await close(dialog);
    assert.equal(calls.length, 1);
  }
});

test('a failed STOP cannot prevent the viewer from closing', async () => {
  const script = await readFile(scriptPath, 'utf8');
  const stop = deferred();
  const { close } = loadCloseCameraViewer(script, () => stop.promise);
  const dialog = viewerDialog('C1');
  const closing = close(dialog);
  assert.equal(dialog.open, false);
  assert.equal(dialog.removed, true);
  stop.reject(new Error('STOP timeout'));
  await closing;
});

test('camera dialog preserves width and follows the image height without artificial bands', async () => {
  const style = await readFile(stylePath, 'utf8');
  const script = await readFile(scriptPath, 'utf8');
  const dialogRule = style.match(/\.floorplan-camera-dialog \{([^}]*)\}/)[1];
  const imageRule = style.match(/\.floorplan-camera-dialog img \{([^}]*)\}/)[1];
  assert.match(script, /floorplan-camera-header/);
  assert.match(script, /assetUrl\('close\.svg'\)/);
  assert.match(script, /data-camera-close[^>]*><img/);
  assert.doesNotMatch(script, />×<\/button>/);
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
