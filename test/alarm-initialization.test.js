import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('the floorplan readiness gate waits for the authoritative alarm snapshot', async () => {
  const [css, floorplan, alarm] = await Promise.all(['public/floorplan.css', 'public/js/floorplan.js', 'public/js/alarm-floorplan.js'].map(file => readFile(new URL(file, root), 'utf8')));
  assert.match(css, /\.layered-floorplan-stage\[data-ready="true"\] \{ visibility: visible; \}/);
  assert.match(floorplan, /const alarmControls = await initAlarmFloorplan/);
  assert.match(floorplan, /stage\.dataset\.ready = 'true'/);
  assert.match(alarm, /await refresh\(\); const refreshTimer/);
});
