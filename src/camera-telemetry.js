import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { defaultCameraPython } from '@smarthome/core';

const execFileAsync = promisify(execFile);
export const CAMERA_TELEMETRY_TTL_MS = 5 * 60 * 1000;
export const CAMERA_EVENT_WINDOW_MS = 12 * 60 * 60 * 1000;

function localDate(value) {
  const date = new Date(value);
  const part = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}`;
}

export function recordingDatesForWindow(now = Date.now(), windowMs = CAMERA_EVENT_WINDOW_MS) {
  return [...new Set([localDate(now - windowMs), localDate(now)])];
}

export function countRecentRecordings(clips, now = Date.now(), windowMs = CAMERA_EVENT_WINDOW_MS) {
  const start = Math.floor((now - windowMs) / 1000);
  const end = Math.floor(now / 1000);
  const unique = new Set();
  for (const clip of Array.isArray(clips) ? clips : []) {
    const startTime = Number(clip?.startTime);
    if (!Number.isFinite(startTime) || startTime < start || startTime > end) continue;
    unique.add(`${startTime}:${clip?.endTime ?? ''}:${clip?.vedio_type ?? ''}`);
  }
  return unique.size;
}

function chargingValue(primary, statistic) {
  const positive = new Set(['charging', 'charge', 'on', 'true', '1']);
  return positive.has(String(primary || '').toLowerCase()) || positive.has(String(statistic || '').toLowerCase());
}

export function normalizeCameraTelemetry(payload, now = Date.now()) {
  const percent = Number(payload?.battery?.percent);
  const batteryAvailable = payload?.battery?.available === true && Number.isFinite(percent);
  const recordingsAvailable = payload?.recordings?.available === true;
  return {
    battery: {
      available: batteryAvailable,
      percent: batteryAvailable ? Math.max(0, Math.min(100, percent)) : null,
      charging: batteryAvailable ? chargingValue(payload.battery.chargingState) : null,
    },
    events: {
      available: recordingsAvailable,
      count: recordingsAvailable ? countRecentRecordings(payload.recordings.clips, now) : null,
      windowHours: 12,
    },
    privacy: {
      available: payload?.privacy?.available === true && ['on', 'off'].includes(payload.privacy.enabled),
      enabled: payload?.privacy?.available === true && payload.privacy.enabled === 'on' ? true : payload?.privacy?.available === true ? false : null,
    },
    detection: payload?.detection?.available === true && ['on', 'off'].includes(payload.detection.enabled) ? payload.detection.enabled === 'on' : null,
    alarm: {
      available: payload?.alarm?.available === true && ['on', 'off'].includes(payload.alarm.enabled),
      enabled: payload?.alarm?.available === true && ['on', 'off'].includes(payload.alarm.enabled) ? payload.alarm.enabled === 'on' : null,
    },
    telemetryUpdatedAt: new Date(now).toISOString(),
  };
}

export async function readCameraTelemetry({ ip, root, env = process.env, now = Date.now(), timeoutMs = 45_000, onPartial, execute = execFileAsync }) {
  const dates = recordingDatesForWindow(now);
  const worker = path.join(root, 'src', 'camera-readonly-telemetry.py');
  const execution = execute(defaultCameraPython(root, { env }), [worker, '--ip', ip, ...dates.flatMap(date => ['--date', date])], {
    cwd: root,
    env,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  let partial = {};
  const normalized = payload => ({ ...normalizeCameraTelemetry(payload, now), recordings: payload.recordings });
  let pending = '';
  execution.child.stderr.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (line.startsWith('[CAM-RESULT] ')) {
          try {
            const update = JSON.parse(line.slice(13));
            for (const field of ['battery', 'recordings', 'privacy', 'detection', 'alarm']) {
              if (Object.hasOwn(update, field)) partial[field] = update[field];
            }
            const value = normalized(update);
            const fields = Object.keys(update).flatMap(field => field === 'recordings' ? ['recordings', 'events'] : [field]);
            onPartial?.(Object.fromEntries(['telemetryUpdatedAt', ...fields].filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])));
          } catch { /* Invalid partial output must not break the final JSON protocol. */ }
        }
      }
    });
  let stdout;
  try { ({ stdout } = await execution); }
  catch (error) {
    if (!Object.keys(partial).length) throw error;
    return { ...normalized(partial), telemetryOutcome: error?.killed ? 'TIMEOUT' : 'FAIL' };
  }
  const payload = JSON.parse(stdout);
  return normalized(payload);
}
