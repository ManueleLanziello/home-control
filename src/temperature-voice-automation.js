import { SENSOR_THRESHOLD_IDS } from './sensor-threshold-store.js';

export const TEMPERATURE_VOICE_ROOMS = Object.freeze({ S1: 'Cucina', S2: 'Camera', S3: 'Salotto', S4: 'Cameretta', S5: 'Laghetto' });
const HYSTERESIS = .5;

export class TemperatureVoiceAutomation {
  constructor({ store, publish = () => {} }) { this.store = store; this.publish = publish; this.states = new Map(); this.sequence = 0; }
  invalidate(id) { if (SENSOR_THRESHOLD_IDS.includes(id)) this.states.delete(id); }
  async observe(id, sensor = {}) {
    if (!SENSOR_THRESHOLD_IDS.includes(id)) return;
    const { thresholds = {}, voices = {} } = await this.store.read(); const threshold = thresholds[id];
    const valid = Number.isFinite(threshold) && sensor.online === true && sensor.available === true && Number.isFinite(sensor.temperature);
    if (!valid) return;
    const state = this.states.get(id) || { initialized: false, armed: false };
    const below = sensor.temperature < threshold; const rearmed = sensor.temperature >= threshold + HYSTERESIS;
    if (!state.initialized) { state.initialized = true; state.armed = !below; this.states.set(id, state); return; }
    if (rearmed) { state.armed = true; this.states.set(id, state); return; }
    if (!below) { this.states.set(id, state); return; }
    if (!state.armed) return;
    state.armed = false; this.states.set(id, state);
    const voice = voices[id];
    if (voice?.enabled === true) this.publish({ id: `temperature-voice-${id}-${++this.sequence}`, type: 'temperature-voice', sensorId: id, room: TEMPERATURE_VOICE_ROOMS[id], volume: voice.volume });
  }
}
