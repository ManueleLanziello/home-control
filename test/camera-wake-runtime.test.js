import assert from 'node:assert/strict';
import test from 'node:test';
import { HomeCameraRuntime } from '../src/camera-runtime.js';

const camera = (id, role) => ({
  id, alias: id, model: 'C410', connection: { ip: id === 'c1' ? '192.0.2.1' : '192.0.2.2' }, identity: {},
  metadata: { adapter: 'tapo-c410-owned' }, configurationStatus: 'complete', verificationStatus: 'verified', role,
});

test('scheduled wake reuses Live telemetry, always closes its session, and preserves valid cached battery data', async () => {
  const record = camera('c1', 'camera_terrazzo'); const calls = []; let reads = 0;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } }, roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() {
      reads += 1;
      if (reads === 1) return { battery: { available: true, percent: 78, charging: false } };
      return { battery: { available: false, percent: null, charging: null } };
    },
  });
  let live = false;
  runtime.owned.createRuntime = async () => ({
    async snapshot() { return { status: live ? 'LIVE' : 'READY', live }; },
    async start() { calls.push('start'); live = true; }, async stop() { calls.push('stop'); live = false; },
  });
  try {
    await runtime.wakeForTelemetry('C1');
    await runtime.wakeForTelemetry('C1');
    assert.deepEqual(calls, ['start', 'stop', 'start', 'stop']);
    assert.equal((await runtime.snapshot()).C1.battery.percent, 78);
    assert.equal(live, false);
  } finally { await runtime.close(); }
});

test('scheduled wake does not terminate a dashboard Live session', async () => {
  const record = camera('c1', 'camera_terrazzo'); let stopCalls = 0; let telemetry = 0;
  const runtime = new HomeCameraRuntime({
    hardwareStore: { async read() { return { devices: [record] }; } }, roleStore: { async read() { return { c1: 'camera_terrazzo' }; } }, root: process.cwd(),
    async readTelemetry() { telemetry += 1; return {}; },
  });
  runtime.owned.createRuntime = async () => ({ async snapshot() { return { status: 'LIVE', live: true }; }, async start() { throw new Error('must not start'); }, async stop() { stopCalls += 1; } });
  try {
    assert.deepEqual(await runtime.wakeForTelemetry('C1'), { skipped: 'live' });
    assert.equal(stopCalls, 0); assert.equal(telemetry, 0);
  } finally { await runtime.close(); }
});
