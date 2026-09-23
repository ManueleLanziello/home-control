import assert from 'node:assert/strict';
import test from 'node:test';
import { countRecentRecordings, normalizeCameraTelemetry, recordingDatesForWindow } from '../src/camera-telemetry.js';

test('finestra eventi interroga uno o due giorni locali quando attraversa mezzanotte', () => {
  const midday = new Date(2026, 8, 22, 15, 0, 0).getTime();
  const morning = new Date(2026, 8, 22, 8, 0, 0).getTime();
  assert.deepEqual(recordingDatesForWindow(midday), ['20260922']);
  assert.deepEqual(recordingDatesForWindow(morning), ['20260921', '20260922']);
});

test('conteggio clip usa startTime nelle ultime 12 ore e rimuove duplicati', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
  const seconds = value => Math.floor(value / 1000);
  const clips = [
    { startTime: seconds(now - 12 * 60 * 60 * 1000), endTime: 1, vedio_type: 2 },
    { startTime: seconds(now - 60 * 60 * 1000), endTime: 2, vedio_type: 2 },
    { startTime: seconds(now - 60 * 60 * 1000), endTime: 2, vedio_type: 2 },
    { startTime: seconds(now - 13 * 60 * 60 * 1000), endTime: 3, vedio_type: 2 },
    { startTime: seconds(now + 60 * 1000), endTime: 4, vedio_type: 2 },
  ];
  assert.equal(countRecentRecordings(clips, now), 2);
});

test('normalizzazione espone solo batteria/carica e conteggio eventi utili alla UI', () => {
  const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
  const telemetry = normalizeCameraTelemetry({
    battery: { available: true, percent: 104, chargingState: 'NORMAL', statisticChargingState: 'charging' },
    recordings: { available: true, clips: [{ startTime: Math.floor((now - 1000) / 1000), endTime: 7, vedio_type: 2 }] },
    detection: { available: true, enabled: 'on' },
    alarm: { available: true, enabled: 'off' },
  }, now);
  assert.deepEqual(telemetry.battery, { available: true, percent: 100, charging: false });
  assert.deepEqual(telemetry.events, { available: true, count: 1, windowHours: 12 });
  assert.equal(telemetry.detection, true);
  assert.deepEqual(telemetry.alarm, { available: true, enabled: false });
  assert.equal(telemetry.telemetryUpdatedAt, '2026-09-22T10:00:00.000Z');
});
