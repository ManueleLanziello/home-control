import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { defaultCameraPython } from '@smarthome/core';

const execFileAsync = promisify(execFile);

export function normalizeCameraDetection(payload) {
  if (payload?.available !== true || typeof payload.enabled !== 'boolean') throw new Error('Read-back Rilevazione non disponibile');
  return { available: true, enabled: payload.enabled };
}

async function runDetectionWorker({ ip, root, env = process.env, enabled = null }) {
  const worker = path.join(root, 'src', 'camera-detection.py');
  const args = [worker, '--ip', ip];
  if (typeof enabled === 'boolean') args.push('--enabled', enabled ? 'on' : 'off');
  const { stdout } = await execFileAsync(defaultCameraPython(root, { env }), args, {
    cwd: root, env, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
  });
  return normalizeCameraDetection(JSON.parse(stdout));
}

export const readCameraDetection = options => runDetectionWorker(options);
export const setCameraDetection = ({ enabled, ...options }) => runDetectionWorker({ ...options, enabled });
