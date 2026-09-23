import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultCameraPython } from '@smarthome/core';

const execFileAsync = promisify(execFile);
const MAX_DURATION_SECONDS = 5 * 60;

export async function readCameraRecording({ ip, root, env = process.env, startTime, endTime, exec = execFileAsync, createTemporaryDirectory = mkdtemp, remove = rm, fileStat = stat }) {
  if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || endTime <= startTime || endTime - startTime > MAX_DURATION_SECONDS) throw new Error('Registrazione non valida');
  const directory = await createTemporaryDirectory(path.join(os.tmpdir(), 'home-control-camera-recording-'));
  const outputPath = path.join(directory, 'recording.mp4');
  const cleanup = async () => { await remove(directory, { recursive: true, force: true }); };
  try {
    const worker = path.join(root, 'src', 'camera-recording-download.py');
    await exec(defaultCameraPython(root, { env }), [worker, '--ip', ip, '--start-time', String(startTime), '--end-time', String(endTime), '--output', outputPath], {
      cwd: root, env, windowsHide: true, timeout: 90_000, maxBuffer: 256 * 1024,
    });
    const output = await fileStat(outputPath);
    if (!output.isFile() || output.size <= 0) throw new Error('Registrazione non disponibile');
    return { path: outputPath, size: output.size, cleanup };
  } catch (error) {
    await cleanup();
    if (error?.killed || error?.code === 'ETIMEDOUT') throw new Error('Download registrazione scaduto');
    try {
      const payload = JSON.parse(error?.stdout || '{}');
      if (['Scaricamento MPEG-TS non riuscito', 'Remux MP4 non riuscito'].includes(payload?.error)) throw new Error(payload.error);
    } catch (detail) { if (detail?.message && detail.message !== 'Unexpected end of JSON input') throw detail; }
    throw new Error('Download o remux registrazione non riuscito');
  }
}
