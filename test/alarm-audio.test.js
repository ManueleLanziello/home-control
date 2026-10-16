import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALARM_AUDIO_FILES, createAlarmAudio } from '../public/js/alarm-audio.js';

test('declares existing alarm files and the nine sensor announcements', () => {
  assert.equal(ALARM_AUDIO_FILES.length, 18);
  assert.deepEqual(ALARM_AUDIO_FILES.slice(-9), ['alarm-intrusion-dw1.ogg', 'alarm-intrusion-dw2.ogg', 'alarm-intrusion-dw3.ogg', 'alarm-intrusion-dw4.ogg', 'alarm-intrusion-dw5.ogg', 'alarm-intrusion-dw6.ogg', 'alarm-intrusion-dw7.ogg', 'alarm-intrusion-dw8.ogg', 'alarm-intrusion-pr1.ogg']);
});

test('every declared alarm audio asset is present', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds', 'alarm');
  await Promise.all(ALARM_AUDIO_FILES.map(file => access(path.join(root, file))));
});
test('audio settings are local and volume is applied to every preloaded player', () => {
  const values = new Map(); const players = []; const audio = createAlarmAudio({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, createAudio: () => { const player = { load() {}, volume: 0 }; players.push(player); return player; } });
  audio.setVolume(42); audio.setEnabled(false); assert.equal(audio.settings().volume, 42); assert.equal(audio.settings().enabled, false); assert.ok(players.every(player => player.volume === .42));
});
