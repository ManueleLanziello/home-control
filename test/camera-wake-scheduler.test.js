import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraWakeScheduler } from '../src/camera-wake-scheduler.js';

const at = value => new Date(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('wake scheduler uses Europe/Rome at 00:00, 06:30 and 18:00 only', async () => {
  let now = at('2026-10-14T04:30:00.000Z'); // 06:30 in Europe/Rome
  const calls = [];
  const scheduler = new CameraWakeScheduler({ cameraRuntime: { async wakeForTelemetry(role) { calls.push(role); } }, now: () => now });
  assert.equal(await scheduler.check(), true);
  assert.deepEqual(calls, ['C1', 'C2']);
  assert.equal(await scheduler.check(), false);
  now = at('2026-10-14T16:00:00.000Z'); // 18:00 in Europe/Rome
  assert.equal(await scheduler.check(), true);
  now = at('2026-10-14T22:00:00.000Z'); // 00:00 in Europe/Rome
  assert.equal(await scheduler.check(), true);
  now = at('2026-10-14T22:01:00.000Z');
  assert.equal(await scheduler.check(), false);
  assert.deepEqual(calls, ['C1', 'C2', 'C1', 'C2', 'C1', 'C2']);
});

test('wake scheduler runs C1 then C2, continues after failure, and deduplicates concurrent checks', async () => {
  const gate = deferred(); const calls = []; const errors = [];
  const scheduler = new CameraWakeScheduler({
    cameraRuntime: { async wakeForTelemetry(role) {
      calls.push(role);
      if (role === 'C1') { await gate.promise; throw new Error('offline'); }
    } },
    now: () => at('2026-10-14T04:30:00.000Z'), logError: message => errors.push(message),
  });
  const first = scheduler.check();
  const duplicate = scheduler.check();
  gate.resolve();
  assert.deepEqual(await Promise.all([first, duplicate]), [true, false]);
  assert.deepEqual(calls, ['C1', 'C2']);
  assert.match(errors[0], /C1.*offline/);
});

test('start waits for the next minute boundary, so startup never replays a missed slot', () => {
  const timers = [];
  const scheduler = new CameraWakeScheduler({
    cameraRuntime: { async wakeForTelemetry() {} }, now: () => at('2026-10-14T04:30:30.000Z'),
    setTimeoutFn(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; }, clearTimeoutFn() {},
  });
  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30_000);
  scheduler.stop();
});
