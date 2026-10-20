import { homeControlPath } from '../base-path.js';

export const ALARM_AUDIO_FILES = Object.freeze(['alarm-disarmed.ogg', 'alarm-partial.ogg', 'alarm-arming-1.ogg', 'alarm-arming-2.ogg', 'alarm-arming-3.ogg', 'alarm-armed.ogg', 'alarm-blocked.ogg', 'alarm-intrusion.ogg', 'alarm-active.ogg', ...['dw1', 'dw2', 'dw3', 'dw4', 'dw5', 'dw6', 'dw7', 'dw8', 'pr1'].map(id => `alarm-intrusion-${id}.ogg`)]);
export const ALARM_WARNING_FILES = Object.freeze(['alarm-warning-prefix.ogg', 'alarm-warning-minute-1.ogg', 'alarm-warning-minute-2.ogg', 'alarm-warning-minute-3.ogg', 'alarm-warning-and.ogg', ...Array.from({ length: 59 }, (_, index) => `alarm-warning-seconds-${index + 1}.ogg`)]);
const KNOWN_FILES = new Set([...ALARM_AUDIO_FILES, ...ALARM_WARNING_FILES]);
export const TEMPERATURE_VOICE_FILES = Object.freeze(['temperature-low.ogg', 'temperature-room-cucina.ogg', 'temperature-room-camera.ogg', 'temperature-room-salotto.ogg', 'temperature-room-cameretta.ogg', 'temperature-room-laghetto.ogg']);
const TEMPERATURE_TEST_ROOMS = Object.freeze({ S1: 'Cucina', S2: 'Camera', S3: 'Salotto', S4: 'Cameretta', S5: 'Laghetto' });
for (const file of TEMPERATURE_VOICE_FILES) KNOWN_FILES.add(file);
const SETTINGS_KEY = 'home-control:alarm-audio';

export function warningFiles(alarmAt, serverNow) {
  const remaining = Math.ceil((new Date(alarmAt).getTime() - Number(serverNow)) / 1000);
  if (!Number.isFinite(remaining) || remaining <= 0) return [];
  const minutes = Math.floor(remaining / 60); const seconds = remaining % 60;
  const files = ['alarm-warning-prefix.ogg'];
  if (minutes) files.push(`alarm-warning-minute-${Math.min(minutes, 3)}.ogg`);
  if (minutes && seconds) files.push('alarm-warning-and.ogg');
  if (seconds) files.push(`alarm-warning-seconds-${seconds}.ogg`);
  return files;
}

export async function warningFilesAfterDelay({ intrusionId, alarmAt, wait, readAlarmState }) {
  await wait(5000);
  const snapshot = await readAlarmState(); const intrusion = snapshot?.intrusion;
  if (!intrusion || intrusion.active === true || intrusion.detectedAt !== intrusionId) return [];
  return warningFiles(intrusion.alarmAt || alarmAt, snapshot.serverNow);
}

export function createAlarmAudio({ storage = globalThis.localStorage, createAudio = () => new Audio(), EventSourceImpl = globalThis.EventSource, onBlocked = () => {}, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), readAlarmState = () => fetch(homeControlPath('/api/alarm')).then(response => response.ok ? response.json() : null) } = {}) {
  let settings = { enabled: true, volume: 100 }; try { settings = { ...settings, ...JSON.parse(storage?.getItem(SETTINGS_KEY) || '{}') }; } catch {}
  const players = new Map(); const getPlayer = file => { if (!KNOWN_FILES.has(file)) return null; if (!players.has(file)) { const player = createAudio(); player.preload = 'auto'; player.src = homeControlPath('/sounds/alarm/' + file); player.volume = settings.volume / 100; player.load?.(); players.set(file, player); } return players.get(file); };
  for (const file of ALARM_AUDIO_FILES) getPlayer(file);
  const seen = new Set(); const queuedWarnings = new Set(); const cancelledIntrusions = new Set(); const activeIntrusions = new Set(); let queue = []; let playing = false;
  const save = () => storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const cancelledTemperatures = new Set();
  const playNext = async () => { if (playing || !queue.length) return; playing = true; const item = queue.shift(); const player = getPlayer(item.file); try { if (item.temperatureId && cancelledTemperatures.has(item.temperatureId)) return; player.currentTime = 0; player.volume = item.volume ?? settings.volume / 100; await player.play(); await new Promise(resolve => { player.addEventListener('ended', resolve, { once: true }); player.addEventListener('error', resolve, { once: true }); }); if (item.pauseAfter && !cancelledIntrusions.has(item.intrusionId) && !cancelledTemperatures.has(item.temperatureId)) await wait(item.pauseAfter); if (item.warning && !cancelledIntrusions.has(item.warning.intrusionId) && settings.enabled) { const files = await warningFilesAfterDelay({ ...item.warning, wait, readAlarmState }); if (files.length && !cancelledIntrusions.has(item.warning.intrusionId)) queue.unshift(...files.map(file => ({ file, intrusionId: item.warning.intrusionId }))); } } catch { onBlocked('Il browser ha bloccato la riproduzione automatica. Tocca “Prova voce” o abilita l’audio.'); } finally { item.done?.(); playing = false; void playNext(); } };
  const enqueue = event => { if (event.type === 'disarmed') { for (const id of activeIntrusions) cancelledIntrusions.add(id); queue = queue.filter(item => !item.intrusionId); } if (!settings.enabled || !KNOWN_FILES.has(event.audio) || seen.has(event.id)) return; seen.add(event.id); if (seen.size > 200) seen.delete(seen.values().next().value); if (event.intrusionId) activeIntrusions.add(event.intrusionId); const warning = event.type === 'intrusion-sensor' && event.intrusionId && !queuedWarnings.has(event.intrusionId) ? { intrusionId: event.intrusionId, alarmAt: event.alarmAt } : null; if (warning) queuedWarnings.add(warning.intrusionId); const item = { file: event.audio, intrusionId: event.intrusionId, pauseAfter: event.type === 'intrusion' ? 2000 : null, warning }; const firstTemperature = queue.findIndex(queued => queued.temperatureId); if (firstTemperature < 0) queue.push(item); else queue.splice(firstTemperature, 0, item); void playNext(); };
  const enqueueTemperature = event => { if (seen.has(event.id) || !TEMPERATURE_VOICE_FILES.includes(`temperature-room-${String(event.room || '').toLowerCase()}.ogg`)) return; seen.add(event.id); const temperatureId = event.sensorId; const volume = Math.max(0, Math.min(100, Number(event.volume) || 0)) / 100; queue.push({ file: 'temperature-low.ogg', temperatureId, volume, pauseAfter: 2000 }, { file: `temperature-room-${String(event.room).toLowerCase()}.ogg`, temperatureId, volume }); void playNext(); };
  const testTemperatureVoice = ({ sensorId, room, volume }) => new Promise(resolve => { const roomFile = `temperature-room-${String(room || TEMPERATURE_TEST_ROOMS[sensorId] || '').toLowerCase()}.ogg`; if (!TEMPERATURE_VOICE_FILES.includes(roomFile)) return resolve(); const temperatureId = `test-${sensorId}-${Date.now()}`; const normalizedVolume = Math.max(0, Math.min(100, Number(volume) || 0)) / 100; queue.push({ file: 'temperature-low.ogg', temperatureId, volume: normalizedVolume, pauseAfter: 2000 }, { file: roomFile, temperatureId, volume: normalizedVolume, done: resolve }); void playNext(); });
  return { settings: () => ({ ...settings }), setEnabled(enabled) { settings.enabled = enabled === true; save(); }, setVolume(volume) { settings.volume = Math.max(0, Math.min(100, Number(volume) || 0)); for (const player of players.values()) player.volume = settings.volume / 100; save(); }, test() { if (!settings.enabled) return onBlocked('Abilita l’audio per riprodurre la prova voce.'); return enqueue({ id: `test-${Date.now()}`, audio: 'alarm-disarmed.ogg' }); }, testTemperatureVoice, connect() { if (!EventSourceImpl) return; const source = new EventSourceImpl(homeControlPath('/api/alarm/events')); source.onmessage = event => { try { enqueue(JSON.parse(event.data)); } catch {} }; return source; }, connectTemperatureVoice() { if (!EventSourceImpl) return; const source = new EventSourceImpl(homeControlPath('/api/temperature-voice/events')); source.addEventListener('voice', event => { try { enqueueTemperature(JSON.parse(event.data)); } catch {} }); source.addEventListener('config', event => { try { const { voices = {} } = JSON.parse(event.data); for (const [id, voice] of Object.entries(voices)) { if (voice.enabled === true) cancelledTemperatures.delete(id); else { cancelledTemperatures.add(id); queue = queue.filter(item => item.temperatureId !== id); } } } catch {} }); return source; } };
}
