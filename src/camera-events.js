import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { defaultCameraPython } from '@smarthome/core';
import { recordingDatesForWindow, CAMERA_EVENT_WINDOW_MS } from './camera-telemetry.js';

const execFileAsync = promisify(execFile);
const seconds = value => { const number = Number(value); return Number.isFinite(number) ? (number > 1e12 ? number / 1000 : number) : null; };

export function normalizeCameraEvents(payload, now = Date.now(), windowMs = CAMERA_EVENT_WINDOW_MS) {
  const start = Math.floor((now - windowMs) / 1000); const end = Math.floor(now / 1000); const unique = new Set(); const events = [];
  for (const clip of payload?.recordings?.clips || []) {
    const startTime = seconds(clip?.startTime); const endTime = seconds(clip?.endTime);
    if (startTime === null || startTime < start || startTime > end || endTime === null || endTime < startTime) continue;
    const key = `${startTime}:${endTime}:${clip?.vedio_type ?? ''}`; if (unique.has(key)) continue; unique.add(key);
    events.push({ startTime, endTime, durationSeconds: Math.max(0, Math.round(endTime - startTime)) });
  }
  events.sort((a, b) => b.startTime - a.startTime);
  events.forEach(event => { event.id = `${event.startTime}-${event.endTime}`; });
  return { available: payload?.recordings?.available === true, hours: 12, events };
}

export async function readCameraEvents({ ip, root, env = process.env, now = Date.now() }) {
  const worker = path.join(root, 'src', 'camera-readonly-telemetry.py');
  const { stdout } = await execFileAsync(defaultCameraPython(root, { env }), [worker, '--ip', ip, '--recordings-only', ...recordingDatesForWindow(now).flatMap(date => ['--date', date])], { cwd: root, env, windowsHide: true, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  return normalizeCameraEvents(JSON.parse(stdout), now);
}
