import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCameraDiagnosticWriter } from '../src/camera-diagnostics.js';

test('diagnostic append creates directories and preserves identical console/file lines', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cam-diag-'));
  try {
    const file = path.join(dir, 'data', 'camera-diagnostics.log');
    const output = [];
    const write = createCameraDiagnosticWriter(file, line => output.push(line));
    const first = '[CAM-DIAG] C1 2026-09-28T15:00:00.000Z +0.123s telemetry start OK';
    const second = '[CAM-DIAG] C2 epoch=123.456 +1.234s getter getAlarm end duration=0.123s FAIL';
    await Promise.all([write(first), write(second)]);
    await createCameraDiagnosticWriter(file, line => output.push(line))(first);
    assert.deepEqual(output, [first, second, first]);
    assert.equal(await readFile(file, 'utf8'), `${first}\n${second}\n${first}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('filesystem/output failures never propagate and do not poison later appends', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cam-diag-failure-'));
  try {
    const blocker = path.join(dir, 'data');
    await writeFile(blocker, 'not a directory');
    const file = path.join(blocker, 'camera-diagnostics.log');
    const write = createCameraDiagnosticWriter(file, () => { throw Error('console failure'); });
    await assert.doesNotReject(write('[CAM-DIAG] C1 fail'));
    await rm(blocker);
    await assert.doesNotReject(write('[CAM-DIAG] C1 recovered'));
    assert.equal(await readFile(file, 'utf8'), '[CAM-DIAG] C1 recovered\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
