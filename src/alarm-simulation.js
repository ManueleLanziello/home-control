import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ALARM_SENSORS = Object.freeze([
  ['DW1', 'Porta di ingresso'], ['DW2', 'Finestra sala'], ['DW3', 'Porta finestra sala'], ['DW4', 'Porta finestra cucina'],
  ['DW5', 'Finestra cucina'], ['DW6', 'Porta finestra camera'], ['DW7', 'Finestra bagno'], ['DW8', 'Porta finestra cameretta'],
  ['PR1', 'Sensore movimento interno'], ['SR1', 'Sirena esterna'],
]);
const DW_IDS = ALARM_SENSORS.slice(0, 8).map(([id]) => id);
const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 3;
const defaults = () => ({ simulation: true, mode: 'none', armingUntil: null, armingError: null, intrusion: null, settings: { armingMinutes: 1, delayMinutes: 1 }, events: [], nextEventId: 1, sensors: Object.fromEntries(ALARM_SENSORS.map(([id, name]) => [id, { id, name, available: id === 'SR1' ? false : true, closed: id === 'PR1' || id === 'SR1' ? null : true, motion: false, active: false, batteryLow: false, battery: null, linkQuality: null, updatedAt: null }])) });
const AUDIO = Object.freeze({ disarmed: 'alarm-disarmed.ogg', partial: 'alarm-partial.ogg', arming: minutes => `alarm-arming-${minutes}.ogg`, armed: 'alarm-armed.ogg', blocked: 'alarm-blocked.ogg', intrusion: 'alarm-intrusion.ogg', active: 'alarm-active.ogg' });

export function blockedSensors(state) {
  return DW_IDS.filter(id => state.sensors[id]?.available !== true || state.sensors[id]?.closed !== true);
}

export function reconcileAlarm(state, now = Date.now()) {
  const next = structuredClone(state);
  if (next.armingUntil) {
    const blocked = blockedSensors(next);
    if (blocked.length) { next.armingUntil = null; next.mode = 'none'; next.armingError = blocked; }
    else if (now >= next.armingUntil) { next.armingUntil = null; next.mode = 'complete'; next.armingError = null; }
  }
  if (next.intrusion && now >= next.intrusion.alarmAt) next.intrusion.active = true;
  if (next.sensors.SR1) next.sensors.SR1.active = next.intrusion?.active === true;
  return next;
}

export class AlarmSimulationStore {
  constructor({ filePath, now = Date.now } = {}) { this.filePath = filePath; this.now = now; this.state = null; this.queue = Promise.resolve(); this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  appendEvents(previous, next) {
    const additions = [];
    if (previous.armingError?.join(',') !== next.armingError?.join(',') && next.armingError?.length) additions.push(['blocked', AUDIO.blocked]);
    if (!previous.armingUntil && next.armingUntil) additions.push(['arming', AUDIO.arming(next.settings.armingMinutes)]);
    if (previous.armingUntil && !next.armingUntil && previous.mode === 'complete' && next.mode === 'complete') additions.push(['armed', AUDIO.armed]);
    if (previous.mode !== next.mode && next.mode === 'partial') additions.push(['partial', AUDIO.partial]);
    if (previous.mode !== 'none' && next.mode === 'none') additions.push(['disarmed', AUDIO.disarmed]);
    if (!previous.intrusion && next.intrusion) additions.push(['intrusion', AUDIO.intrusion]);
    if (!previous.intrusion?.active && next.intrusion?.active) additions.push(['active', AUDIO.active]);
    if (!additions.length) return [];
    const timestamp = new Date(this.now()).toISOString();
    const events = additions.map(([type, audio]) => ({ id: String(next.nextEventId++), type, timestamp, audio }));
    next.events = [...(next.events || []), ...events].slice(-100);
    return events;
  }
  async save(previous) { await this.persist(); const known = new Set((previous.events || []).map(event => event.id)); const fresh = (this.state.events || []).filter(event => !known.has(event.id)); for (const event of fresh) for (const listener of this.listeners) listener(event); }
  async read() {
    if (!this.state) {
      try { const saved = JSON.parse(await readFile(this.filePath, 'utf8')); const initial = defaults(); this.state = { ...initial, ...saved, settings: { ...initial.settings, ...saved.settings }, events: Array.isArray(saved.events) ? saved.events : [], nextEventId: Number.isInteger(saved.nextEventId) ? saved.nextEventId : 1, sensors: { ...initial.sensors, ...saved.sensors } }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = defaults(); }
    }
    const previous = structuredClone(this.state); const next = reconcileAlarm(this.state, this.now()); this.appendEvents(previous, next);
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; await this.save(previous); }
    return structuredClone(this.state);
  }
  async persist() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, this.filePath);
  }
  async update(mutator) {
    const run = this.queue.then(async () => { await this.read(); const previous = structuredClone(this.state); const result = await mutator(this.state); this.state = reconcileAlarm(this.state, this.now()); this.appendEvents(previous, this.state); await this.save(previous); return { state: structuredClone(this.state), result }; });
    this.queue = run.catch(() => {});
    return run;
  }
  async setSettings(settings) { return (await this.update(state => { if (!validMinutes(settings?.armingMinutes) || !validMinutes(settings?.delayMinutes)) throw new Error('Temporizzazione non valida'); state.settings = { armingMinutes: settings.armingMinutes, delayMinutes: settings.delayMinutes }; })).state; }
  async selectMode(mode) { const outcome = await this.update(state => {
    if (!['none', 'partial', 'complete'].includes(mode)) throw new Error('Modalità antifurto non valida');
    state.armingError = null;
    if (mode === 'none') { state.mode = 'none'; state.armingUntil = null; state.intrusion = null; return; }
    const blocked = blockedSensors(state);
    if (blocked.length) { state.armingUntil = null; state.armingError = blocked; return { blocked }; }
    state.mode = mode;
    state.armingUntil = mode === 'complete' ? this.now() + state.settings.armingMinutes * 60_000 : null;
  }); if (outcome.result?.blocked) throw Object.assign(new Error('INSERIMENTO NON CONSENTITO'), { blocked: outcome.result.blocked, state: outcome.state }); return outcome.state; }
  async simulate(changes = {}) { return (await this.update(state => {
    for (const [id, patch] of Object.entries(changes.sensors || {})) {
      if (!state.sensors[id] || !patch || typeof patch !== 'object') continue;
      const sensor = state.sensors[id];
      for (const key of ['available', 'closed', 'motion', 'batteryLow']) if (typeof patch[key] === 'boolean') sensor[key] = patch[key];
      sensor.updatedAt = new Date(this.now()).toISOString();
    }
    const monitored = state.mode === 'complete' ? [...DW_IDS, 'PR1'] : state.mode === 'partial' ? DW_IDS : [];
    const triggering = monitored.find(id => id === 'PR1' ? state.sensors[id].available === true && state.sensors[id].motion === true : state.sensors[id].available === true && state.sensors[id].closed === false);
    if (triggering && !state.intrusion) state.intrusion = { sensorId: triggering, detectedAt: new Date(this.now()).toISOString(), alarmAt: this.now() + state.settings.delayMinutes * 60_000, active: false };
  })).state; }
}
