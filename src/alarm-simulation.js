import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ALARM_SENSORS = Object.freeze([
  ['DW1', 'Porta di ingresso'], ['DW2', 'Finestra sala'], ['DW3', 'Porta finestra sala'], ['DW4', 'Porta finestra cucina'],
  ['DW5', 'Finestra cucina'], ['DW6', 'Porta finestra camera'], ['DW7', 'Finestra bagno'], ['DW8', 'Porta finestra cameretta'],
  ['PR1', 'Sensore movimento interno'], ['SR1', 'Sirena esterna'],
]);
const DW_IDS = ALARM_SENSORS.slice(0, 8).map(([id]) => id);
const SENSOR_IDS = ALARM_SENSORS.slice(0, 9).map(([id]) => id);
const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 3;
const defaults = () => ({ simulation: true, mode: 'none', armingUntil: null, armingError: null, intrusion: null, pr1Ready: false, settings: { armingMinutes: 1, delayMinutes: 1 }, events: [], nextEventId: 1, sensors: Object.fromEntries(ALARM_SENSORS.map(([id, name]) => [id, { id, name, available: id === 'SR1' ? false : true, closed: id === 'PR1' || id === 'SR1' ? null : true, motion: false, active: false, batteryLow: false, battery: null, linkQuality: null, updatedAt: null }])) });
const AUDIO = Object.freeze({ disarmed: 'alarm-disarmed.ogg', partial: 'alarm-partial.ogg', arming: minutes => `alarm-arming-${minutes}.ogg`, armed: 'alarm-armed.ogg', blocked: 'alarm-blocked.ogg', intrusion: 'alarm-intrusion.ogg', sensor: id => `alarm-intrusion-${id.toLowerCase()}.ogg`, active: 'alarm-active.ogg' });

export function blockedSensors(state) {
  return DW_IDS.filter(id => state.sensors[id]?.available !== true || state.sensors[id]?.closed !== true);
}

const blockedDuringCompleteExit = state => DW_IDS.slice(1).filter(id => state.sensors[id]?.available !== true || state.sensors[id]?.closed !== true);

const intrusionSensorIds = intrusion => Array.from(new Set(Array.isArray(intrusion?.sensorIds) ? intrusion.sensorIds : intrusion?.sensorId ? [intrusion.sensorId] : [])).filter(id => SENSOR_IDS.includes(id));
const isTriggered = (id, sensor) => id === 'PR1' ? sensor?.available === true && sensor.motion === true : sensor?.available === true && sensor.closed === false;
const monitoredSensors = state => state.mode === 'partial' ? DW_IDS : state.mode === 'complete' && !state.armingUntil ? [...DW_IDS, ...(state.pr1Ready ? ['PR1'] : [])] : [];

export function observeIntrusions(state, now = Date.now()) {
  const detected = monitoredSensors(state).filter(id => isTriggered(id, state.sensors[id]));
  if (!detected.length) return;
  if (!state.intrusion) state.intrusion = { sensorId: detected[0], sensorIds: detected, detectedAt: new Date(now).toISOString(), alarmAt: now + state.settings.delayMinutes * 60_000, active: false };
  else {
    const sensorIds = Array.from(new Set([...intrusionSensorIds(state.intrusion), ...detected]));
    state.intrusion.sensorIds = sensorIds;
    state.intrusion.sensorId = sensorIds[0];
  }
}

export function reconcileAlarm(state, now = Date.now()) {
  const next = structuredClone(state);
  if (next.armingUntil) {
    if (now >= next.armingUntil) {
      const blocked = blockedSensors(next);
      if (blocked.length) { next.armingUntil = null; next.mode = 'none'; next.armingError = blocked; }
      else { next.armingUntil = null; next.mode = 'complete'; next.armingError = null; next.pr1Ready = next.sensors.PR1?.available === true && next.sensors.PR1.motion === false; }
    } else {
      const blocked = blockedDuringCompleteExit(next);
      if (blocked.length) { next.armingUntil = null; next.mode = 'none'; next.armingError = blocked; }
    }
  }
  if (next.mode === 'complete' && !next.armingUntil && next.pr1Ready !== true && next.sensors.PR1?.available === true && next.sensors.PR1.motion === false) next.pr1Ready = true;
  observeIntrusions(next, now);
  if (next.intrusion && now >= next.intrusion.alarmAt) next.intrusion.active = true;
  if (next.sensors.SR1) next.sensors.SR1.active = next.intrusion?.active === true;
  return next;
}

export class AlarmSimulationStore {
  constructor({ filePath, now = Date.now } = {}) { this.filePath = filePath; this.now = now; this.state = null; this.queue = Promise.resolve(); this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  appendEvents(previous, next) {
    const additions = [];
    if (previous.armingError?.join(',') !== next.armingError?.join(',') && next.armingError?.length) additions.push({ type: 'blocked', audio: AUDIO.blocked });
    if (!previous.armingUntil && next.armingUntil) additions.push({ type: 'arming', audio: AUDIO.arming(next.settings.armingMinutes) });
    if (previous.armingUntil && !next.armingUntil && previous.mode === 'complete' && next.mode === 'complete') additions.push({ type: 'armed', audio: AUDIO.armed });
    if (previous.mode !== next.mode && next.mode === 'partial') additions.push({ type: 'partial', audio: AUDIO.partial });
    if (previous.mode !== 'none' && next.mode === 'none') additions.push({ type: 'disarmed', audio: AUDIO.disarmed });
    const previousSensorIds = intrusionSensorIds(previous.intrusion); const nextSensorIds = intrusionSensorIds(next.intrusion);
    if (!previous.intrusion && next.intrusion) additions.push({ type: 'intrusion', audio: AUDIO.intrusion, intrusionId: next.intrusion.detectedAt, alarmAt: next.intrusion.alarmAt });
    for (const id of nextSensorIds.filter(id => !previousSensorIds.includes(id))) additions.push({ type: 'intrusion-sensor', audio: AUDIO.sensor(id), sensorId: id, intrusionId: next.intrusion.detectedAt, alarmAt: next.intrusion.alarmAt });
    if (!previous.intrusion?.active && next.intrusion?.active) additions.push({ type: 'active', audio: AUDIO.active });
    if (!additions.length) return [];
    const timestamp = new Date(this.now()).toISOString();
    const events = additions.map(event => ({ id: String(next.nextEventId++), timestamp, ...event }));
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
    if (mode === 'none') { state.mode = 'none'; state.armingUntil = null; state.intrusion = null; state.pr1Ready = false; return; }
    const blocked = mode === 'complete' ? blockedDuringCompleteExit(state) : blockedSensors(state);
    if (blocked.length) { state.armingUntil = null; state.armingError = blocked; return { blocked }; }
    state.mode = mode; state.pr1Ready = false;
    state.armingUntil = mode === 'complete' ? this.now() + state.settings.armingMinutes * 60_000 : null;
  }); if (outcome.result?.blocked) throw Object.assign(new Error('INSERIMENTO NON CONSENTITO'), { blocked: outcome.result.blocked, state: outcome.state }); return outcome.state; }
  async simulate(changes = {}) { return (await this.update(state => {
    for (const [id, patch] of Object.entries(changes.sensors || {})) {
      if (!state.sensors[id] || !patch || typeof patch !== 'object') continue;
      const sensor = state.sensors[id];
      for (const key of ['available', 'closed', 'motion', 'batteryLow']) if (typeof patch[key] === 'boolean') sensor[key] = patch[key];
      sensor.updatedAt = new Date(this.now()).toISOString();
    }
  })).state; }
}
