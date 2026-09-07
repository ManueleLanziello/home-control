import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Wt200ScheduleStore } from '../src/wt200-schedule-store.js';
import {
  createWt200ScheduleModel,
  initialWt200SetpointForDate,
  selectWt200PeriodsForDate,
} from '../public/js/boiler-schedule.js';

const schedule = {
  weekPattern: '5+2',
  weekPatternRaw: '1',
  normalPeriods: [
    { hour: 6, minute: 0, unknownByte: 0, temperature: 2 },
    { hour: 8, minute: 0, unknownByte: 0, temperature: 1.5 },
    { hour: 11, minute: 18, unknownByte: 0, temperature: 1.5 },
    { hour: 13, minute: 28, unknownByte: 0, temperature: 1.5 },
    { hour: 17, minute: 0, unknownByte: 0, temperature: 2.2 },
    { hour: 22, minute: 0, unknownByte: 0, temperature: 1.5 },
  ],
  restDayPeriods: [
    { hour: 6, minute: 0, unknownByte: 0, temperature: 2 },
    { hour: 22, minute: 0, unknownByte: 0, temperature: 1.5 },
  ],
  raw: 'BgAAFAgAAA8LEgAPDRwADxEAABYWAAAPBgAAFBYAAA8=',
};

test('store gestisce file assente, corrotto e schedule persistito', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wt200-schedule-'));
  const filePath = path.join(directory, 'schedule.json');
  const store = new Wt200ScheduleStore({ filePath });
  assert.equal(await store.read(), null);
  await writeFile(filePath, '{not-json', 'utf8');
  assert.equal(await store.read(), null);
  await store.write({ deviceId: 'wt200-1', schedule, updatedAt: '2026-09-07T12:00:00.000Z' });
  assert.deepEqual(await store.read(), { deviceId: 'wt200-1', schedule, updatedAt: '2026-09-07T12:00:00.000Z' });
});

test('sceglie fasce normali e riposo e calcola il setpoint ereditato a mezzanotte', () => {
  const monday = new Date(2026, 8, 7, 0, 0);
  const saturday = new Date(2026, 8, 12, 0, 0);
  const sunday = new Date(2026, 8, 13, 0, 0);
  assert.equal(selectWt200PeriodsForDate(schedule, monday), schedule.normalPeriods);
  assert.equal(selectWt200PeriodsForDate(schedule, saturday), schedule.restDayPeriods);
  assert.equal(selectWt200PeriodsForDate(schedule, sunday), schedule.restDayPeriods);
  assert.equal(initialWt200SetpointForDate(schedule, monday), 1.5);
  assert.equal(initialWt200SetpointForDate(schedule, saturday), 1.5);
  assert.equal(initialWt200SetpointForDate(schedule, sunday), 1.5);
  assert.equal(createWt200ScheduleModel(schedule, monday).initialTemperature, 1.5);
});
