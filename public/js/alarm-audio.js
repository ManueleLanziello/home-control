import { homeControlPath } from '../base-path.js';

export const ALARM_AUDIO_FILES = Object.freeze(['alarm-disarmed.ogg', 'alarm-partial.ogg', 'alarm-arming-1.ogg', 'alarm-arming-2.ogg', 'alarm-arming-3.ogg', 'alarm-armed.ogg', 'alarm-blocked.ogg', 'alarm-intrusion.ogg', 'alarm-active.ogg']);
const SETTINGS_KEY = 'home-control:alarm-audio';

export function createAlarmAudio({ storage = globalThis.localStorage, createAudio = () => new Audio(), EventSourceImpl = globalThis.EventSource, onBlocked = () => {} } = {}) {
  let settings = { enabled: true, volume: 100 }; try { settings = { ...settings, ...JSON.parse(storage?.getItem(SETTINGS_KEY) || '{}') }; } catch {}
  const players = new Map(ALARM_AUDIO_FILES.map(file => { const player = createAudio(); player.preload = 'auto'; player.src = homeControlPath('/sounds/alarm/' + file); player.volume = settings.volume / 100; player.load?.(); return [file, player]; }));
  const seen = new Set(); const queue = []; let playing = false;
  const save = () => storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
  const playNext = async () => { if (playing || !queue.length) return; playing = true; const file = queue.shift(); const player = players.get(file); try { player.currentTime = 0; await player.play(); await new Promise(resolve => { player.addEventListener('ended', resolve, { once: true }); player.addEventListener('error', resolve, { once: true }); }); } catch { onBlocked('Il browser ha bloccato la riproduzione automatica. Tocca “Prova voce” o abilita l’audio.'); } finally { playing = false; playNext(); } };
  const enqueue = event => { if (!settings.enabled || !players.has(event.audio) || seen.has(event.id)) return; seen.add(event.id); if (seen.size > 200) seen.delete(seen.values().next().value); queue.push(event.audio); void playNext(); };
  return { settings: () => ({ ...settings }), setEnabled(enabled) { settings.enabled = enabled === true; save(); }, setVolume(volume) { settings.volume = Math.max(0, Math.min(100, Number(volume) || 0)); for (const player of players.values()) player.volume = settings.volume / 100; save(); }, test() { if (!settings.enabled) return onBlocked('Abilita l’audio per riprodurre la prova voce.'); return enqueue({ id: `test-${Date.now()}`, audio: 'alarm-disarmed.ogg' }); }, connect() { if (!EventSourceImpl) return; const source = new EventSourceImpl(homeControlPath('/api/alarm/events')); source.onmessage = event => { try { enqueue(JSON.parse(event.data)); } catch {} }; return source; } };
}
