import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { normalizeCameraAlarm } from '../src/camera-alarm.js';

test('Alarm normalizza solo il master booleano', () => {
  assert.deepEqual(normalizeCameraAlarm({ available: true, enabled: true }), { available: true, enabled: true });
  assert.throws(() => normalizeCameraAlarm({ available: false, enabled: false }));
});

test('worker Alarm preserva modalità, tipo luce e tipo allarme nel payload PyTapo', async () => {
  const source = await readFile(new URL('../src/camera-alarm.py', import.meta.url), 'utf8');
  assert.match(source, /current = camera\.getAlarm\(\)/);
  assert.match(source, /"alarm_type", "light_type", "alarm_mode"/);
  assert.match(source, /camera\.performRequest\(\{"method": "set", "msg_alarm": \{"chn1_msg_alarm_info": settings\}\}\)/);
  assert.match(source, /confirmed = camera\.getAlarm\(\)/);
});
