import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { defaultCameraPython } from '@smarthome/core';

const execFileAsync = promisify(execFile);

export function normalizeCameraPrivacy(payload) {
  if (payload?.available !== true || typeof payload.enabled !== 'boolean') throw new Error('Read-back Privacy non disponibile');
  return { available: true, enabled: payload.enabled };
}

async function runPrivacyWorker({ ip, root, env = process.env, enabled = null }) {
  const worker = path.join(root, 'src', 'camera-privacy.py');
  const args = [worker, '--ip', ip];
  if (typeof enabled === 'boolean') args.push('--enabled', enabled ? 'on' : 'off');
  const { stdout } = await execFileAsync(defaultCameraPython(root, { env }), args, {
    cwd: root, env, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
  });
  return normalizeCameraPrivacy(JSON.parse(stdout));
}

export const readCameraPrivacy = options => runPrivacyWorker(options);
export const setCameraPrivacy = ({ enabled, ...options }) => runPrivacyWorker({ ...options, enabled });
