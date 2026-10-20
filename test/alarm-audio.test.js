import assert from 'node:assert/strict';
import test from 'node:test';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALARM_AUDIO_FILES, ALARM_WARNING_FILES, TEMPERATURE_VOICE_FILES, createAlarmAudio, warningFiles, warningFilesAfterDelay } from '../public/js/alarm-audio.js';

test('declares existing alarm files and the nine sensor announcements', () => {
  assert.equal(ALARM_AUDIO_FILES.length, 18);
  assert.deepEqual(ALARM_AUDIO_FILES.slice(-9), ['alarm-intrusion-dw1.ogg', 'alarm-intrusion-dw2.ogg', 'alarm-intrusion-dw3.ogg', 'alarm-intrusion-dw4.ogg', 'alarm-intrusion-dw5.ogg', 'alarm-intrusion-dw6.ogg', 'alarm-intrusion-dw7.ogg', 'alarm-intrusion-dw8.ogg', 'alarm-intrusion-pr1.ogg']);
});

test('uses a compact prerecorded composition for the authoritative remaining time', () => {
  assert.equal(ALARM_WARNING_FILES.length, 64);
  assert.deepEqual(warningFiles('1970-01-01T00:00:50.000Z', 0), ['alarm-warning-prefix.ogg', 'alarm-warning-seconds-50.ogg']);
  assert.deepEqual(warningFiles('1970-01-01T00:01:20.000Z', 0), ['alarm-warning-prefix.ogg', 'alarm-warning-minute-1.ogg', 'alarm-warning-and.ogg', 'alarm-warning-seconds-20.ogg']);
  assert.deepEqual(warningFiles('1970-01-01T00:02:00.000Z', 0), ['alarm-warning-prefix.ogg', 'alarm-warning-minute-2.ogg']);
  assert.deepEqual(warningFiles('1970-01-01T00:00:00.000Z', 0), []);
});

test('waits five seconds, then uses the current backend snapshot and skips ended alarms', async () => {
  const waits = []; const ready = await warningFilesAfterDelay({ intrusionId: 'intrusion-1', alarmAt: '1970-01-01T00:01:00.000Z', wait: async milliseconds => waits.push(milliseconds), readAlarmState: async () => ({ serverNow: 10_000, intrusion: { detectedAt: 'intrusion-1', alarmAt: '1970-01-01T00:01:00.000Z', active: false } }) });
  assert.deepEqual(waits, [5000]); assert.deepEqual(ready, ['alarm-warning-prefix.ogg', 'alarm-warning-seconds-50.ogg']);
  const expired = await warningFilesAfterDelay({ intrusionId: 'intrusion-1', alarmAt: '1970-01-01T00:01:00.000Z', wait: async () => {}, readAlarmState: async () => ({ serverNow: 61_000, intrusion: { detectedAt: 'intrusion-1', active: true } }) });
  assert.deepEqual(expired, []);
});

test('queues one warning only after the sensor audio ends and cancels it on disarm', async () => {
  let source; const played = []; const waits = []; const createAudio = () => ({ load() {}, volume: 0, play() { played.push(this.src); return Promise.resolve(); }, addEventListener(type, listener) { if (type === 'ended') queueMicrotask(listener); } });
  class EventSourceStub { constructor() { source = this; } }
  const audio = createAlarmAudio({ createAudio, EventSourceImpl: EventSourceStub, wait: async milliseconds => waits.push(milliseconds), readAlarmState: async () => ({ serverNow: 10_000, intrusion: { detectedAt: 'intrusion-1', alarmAt: '1970-01-01T00:01:00.000Z', active: false } }) });
  audio.connect(); source.onmessage({ data: JSON.stringify({ id: 'intrusion-1', type: 'intrusion', audio: 'alarm-intrusion.ogg', intrusionId: 'intrusion-1' }) }); source.onmessage({ data: JSON.stringify({ id: 'sensor-1', type: 'intrusion-sensor', audio: 'alarm-intrusion-dw1.ogg', intrusionId: 'intrusion-1', alarmAt: '1970-01-01T00:01:00.000Z' }) });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(waits, [2000, 5000]); assert.deepEqual(played.slice(-4).map(url => url.split('/').at(-1)), ['alarm-intrusion.ogg', 'alarm-intrusion-dw1.ogg', 'alarm-warning-prefix.ogg', 'alarm-warning-seconds-50.ogg']);

  let releaseWait; const cancelledPlayed = []; const cancelledAudio = createAlarmAudio({ createAudio: () => ({ load() {}, play() { cancelledPlayed.push(this.src); return Promise.resolve(); }, addEventListener(type, listener) { if (type === 'ended') queueMicrotask(listener); } }), EventSourceImpl: EventSourceStub, wait: () => new Promise(resolve => { releaseWait = resolve; }), readAlarmState: async () => ({ serverNow: 10_000, intrusion: { detectedAt: 'intrusion-2', alarmAt: '1970-01-01T00:01:00.000Z', active: false } }) });
  cancelledAudio.connect(); source.onmessage({ data: JSON.stringify({ id: 'intrusion-2', type: 'intrusion', audio: 'alarm-intrusion.ogg', intrusionId: 'intrusion-2' }) }); source.onmessage({ data: JSON.stringify({ id: 'sensor-2', type: 'intrusion-sensor', audio: 'alarm-intrusion-dw1.ogg', intrusionId: 'intrusion-2' }) }); await new Promise(resolve => setTimeout(resolve, 0)); source.onmessage({ data: JSON.stringify({ id: 'disarmed-2', type: 'disarmed', audio: 'alarm-disarmed.ogg' }) }); releaseWait(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(!cancelledPlayed.some(url => url.endsWith('alarm-intrusion-dw1.ogg') || url.endsWith('alarm-warning-prefix.ogg')));
});

test('every declared alarm audio asset is present', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sounds', 'alarm');
  await Promise.all([...ALARM_AUDIO_FILES, ...ALARM_WARNING_FILES, ...TEMPERATURE_VOICE_FILES].map(file => access(path.join(root, file))));
});
test('audio settings are local and volume is applied to every preloaded player', () => {
  const values = new Map(); const players = []; const audio = createAlarmAudio({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, createAudio: () => { const player = { load() {}, volume: 0 }; players.push(player); return player; } });
  audio.setVolume(42); audio.setEnabled(false); assert.equal(audio.settings().volume, 42); assert.equal(audio.settings().enabled, false); assert.ok(players.every(player => player.volume === .42));
});

test('prova voce S3 usa la coda condivisa, il volume locale e la pausa dopo il primo OGG', async () => {
  const played = []; const waits = []; const players = [];
  const audio = createAlarmAudio({ createAudio: () => { const player = { load() {}, volume: 0, play() { played.push(this.src); return Promise.resolve(); }, addEventListener(type, listener) { if (type === 'ended') queueMicrotask(listener); } }; players.push(player); return player; }, wait: async milliseconds => waits.push(milliseconds) });
  await audio.testTemperatureVoice({ sensorId: 'S3', volume: 42 });
  assert.deepEqual(waits, [2000]); assert.deepEqual(played.map(file => file.split('/').at(-1)), ['temperature-low.ogg', 'temperature-room-salotto.ogg']); assert.ok(players.filter(player => player.src.includes('temperature-')).every(player => player.volume === .42));
});

test('mostra il messaggio autoplay soltanto per NotAllowedError e recupera dagli errori del file', async () => {
  const messages = []; const rejected = createAlarmAudio({ onBlocked: message => messages.push(message), createAudio: () => ({ load() {}, play() { return Promise.reject(Object.assign(new Error('file missing'), { name: 'NotSupportedError' })); }, addEventListener() {} }) });
  rejected.test(); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(messages, []);

  const blocked = createAlarmAudio({ onBlocked: message => messages.push(message), createAudio: () => ({ load() {}, play() { return Promise.reject(Object.assign(new Error('autoplay'), { name: 'NotAllowedError' })); }, addEventListener() {} }) });
  blocked.test(); await new Promise(resolve => setTimeout(resolve, 0)); assert.deepEqual(messages, ['Il browser ha bloccato la riproduzione automatica. Tocca “Prova voce” o abilita l’audio.']);

  const played = []; let first = true;
  const recovered = createAlarmAudio({ createAudio: () => ({ load() {}, play() { played.push(this.src); return Promise.resolve(); }, addEventListener(type, listener) { if (type === 'error' && first) { first = false; queueMicrotask(listener); } else if (type === 'ended') queueMicrotask(listener); } }) });
  recovered.test(); await new Promise(resolve => setTimeout(resolve, 0)); recovered.test(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(played.length, 2);
});
