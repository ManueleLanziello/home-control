import assert from 'node:assert/strict';
import test from 'node:test';
import { CameraOperationQueue } from '../src/camera-operation-queue.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('stessa camera serializzata, altra camera indipendente e PUT davanti al background in attesa', async () => {
  const queue = new CameraOperationQueue();
  const gate = deferred(); const order = [];
  const first = queue.run('c1', async () => { order.push('c1-first'); await gate.promise; });
  const background = queue.run('c1', () => { order.push('c1-background'); }, { background: true });
  const write = queue.run('c1', () => { order.push('c1-write'); });
  await queue.run('c2', () => { order.push('c2'); });
  assert.deepEqual(order, ['c1-first', 'c2']);
  gate.resolve(); await Promise.all([first, background, write]);
  assert.deepEqual(order, ['c1-first', 'c2', 'c1-write', 'c1-background']);
});

test('errore libera la queue per la prossima operazione', async () => {
  const queue = new CameraOperationQueue();
  const failed = queue.run('c1', () => { throw new Error('timeout'); });
  const next = queue.run('c1', () => 'ready');
  await assert.rejects(failed, /timeout/);
  assert.equal(await next, 'ready');
});
