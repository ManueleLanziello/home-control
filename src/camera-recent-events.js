import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultCameraPython } from '@smarthome/core';

const execFileAsync = promisify(execFile);

export function normalizeRecentEvents(payload) {
  const seen = new Set(); const events = [];
  for (const event of payload?.events || []) {
    const startTime = Number(event?.start_time); const endTime = Number(event?.end_time);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime || seen.has(startTime)) continue;
    seen.add(startTime); events.push({ startTime, endTime });
  }
  events.sort((a, b) => b.startTime - a.startTime);
  return { available: payload?.available === true, events };
}

export async function readCameraRecentEvents({ ip, root, env = process.env }) {
  const worker = path.join(root, 'src', 'camera-recent-events.py');
  const { stdout } = await execFileAsync(defaultCameraPython(root, { env }), [worker, '--ip', ip], { cwd: root, env, windowsHide: true, timeout: 20_000, maxBuffer: 256 * 1024 });
  return normalizeRecentEvents(JSON.parse(stdout));
}
