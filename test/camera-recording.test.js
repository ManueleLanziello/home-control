import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCameraRecording } from '../src/camera-recording.js';

test('registrazione crea MP4 temporaneo e cleanup rimuove TS/MP4 fuori dal repository', async () => {
  const root = process.cwd(); let output;
  const recording = await readCameraRecording({
    ip: '192.0.2.1', root, startTime: 100, endTime: 110,
    createTemporaryDirectory: prefix => mkdtemp(prefix),
    async exec(_python, args) { output = args[args.indexOf('--output') + 1]; await writeFile(output, Buffer.from([1, 2, 3])); },
  });
  assert.equal(recording.path, output); assert.equal(recording.size, 3); assert.equal(recording.path.startsWith(root), false);
  await recording.cleanup(); await assert.rejects(access(recording.path));
});

test('errore FFmpeg o MP4 vuoto viene rifiutato e pulisce la directory temporanea', async () => {
  let directory;
  await assert.rejects(readCameraRecording({
    ip: '192.0.2.1', root: process.cwd(), startTime: 100, endTime: 110,
    async createTemporaryDirectory(prefix) { directory = await mkdtemp(prefix); return directory; },
    async exec() { throw new Error('ffmpeg failed'); },
  }), /Download o remux registrazione non riuscito/);
  await assert.rejects(access(directory));
});

test('propaga il punto di failure MPEG-TS o remux senza esporre dettagli sensibili', async () => {
  const failure = Object.assign(new Error('worker failed'), { stdout: JSON.stringify({ error: 'Scaricamento MPEG-TS non riuscito' }) });
  await assert.rejects(readCameraRecording({
    ip: '192.0.2.1', root: process.cwd(), startTime: 100, endTime: 110, async exec() { throw failure; },
  }), /Scaricamento MPEG-TS non riuscito/);
});

test('non accetta intervalli arbitrari o troppo lunghi prima di avviare il worker', async () => {
  let invoked = false;
  await assert.rejects(readCameraRecording({ ip: '192.0.2.1', root: process.cwd(), startTime: 10, endTime: 400, async exec() { invoked = true; } }), /Registrazione non valida/);
  assert.equal(invoked, false);
});
