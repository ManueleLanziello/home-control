import assert from 'node:assert/strict';
import test from 'node:test';
import { ALARM_AUDIO_FILES, createAlarmAudio } from '../public/js/alarm-audio.js';

test('declares the nine required alarm files', () => assert.equal(ALARM_AUDIO_FILES.length, 9));
test('audio settings are local and volume is applied to every preloaded player', () => {
  const values = new Map(); const players = []; const audio = createAlarmAudio({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, createAudio: () => { const player = { load() {}, volume: 0 }; players.push(player); return player; } });
  audio.setVolume(42); audio.setEnabled(false); assert.equal(audio.settings().volume, 42); assert.equal(audio.settings().enabled, false); assert.ok(players.every(player => player.volume === .42));
});
