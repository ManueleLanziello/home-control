import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const ALARM_SENSORS = Object.freeze([
  ['DW1', 'Porta di ingresso'], ['DW2', 'Finestra sala'], ['DW3', 'Porta finestra sala'], ['DW4', 'Porta finestra cucina'],
  ['DW5', 'Finestra cucina'], ['DW6', 'Porta finestra camera'], ['DW7', 'Finestra bagno'], ['DW8', 'Porta finestra cameretta'],
  ['PR1', 'Sensore movimento interno'],
]);
const DW_IDS = ALARM_SENSORS.slice(0, 8).map(([id]) => id);
const validMinutes = value => Number.isInteger(value) && value >= 1 && value <= 3;
const defaults = () => ({ simulation: true, mode: 'none', armingUntil: null, armingError: null, intrusion: null, settings: { armingMinutes: 1, delayMinutes: 1 }, sensors: Object.fromEntries(ALARM_SENSORS.map(([id, name]) => [id, { id, name, available: true, closed: id === 'PR1' ? null : true, motion: false, batteryLow: false, battery: null, linkQuality: null, updatedAt: null }])) });

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
  return next;
}

export class AlarmSimulationStore {
  constructor({ filePath, now = Date.now } = {}) { this.filePath = filePath; this.now = now; this.state = null; this.queue = Promise.resolve(); }
  async read() {
    if (!this.state) {
      try { this.state = { ...defaults(), ...JSON.parse(await readFile(this.filePath, 'utf8')) }; }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = defaults(); }
    }
    const next = reconcileAlarm(this.state, this.now());
    if (JSON.stringify(next) !== JSON.stringify(this.state)) { this.state = next; await this.persist(); }
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
    const run = this.queue.then(async () => { await this.read(); const result = await mutator(this.state); this.state = reconcileAlarm(this.state, this.now()); await this.persist(); return { state: structuredClone(this.state), result }; });
    this.queue = run.catch(() => {});
    return run;
  }
  async setSettings(settings) { return (await this.update(state => { if (!validMinutes(settings?.armingMinutes) || !validMinutes(settings?.delayMinutes)) throw new Error('Temporizzazione non valida'); state.settings = { armingMinutes: settings.armingMinutes, delayMinutes: settings.delayMinutes }; })).state; }
  async selectMode(mode) { return (await this.update(state => {
    if (!['none', 'partial', 'complete'].includes(mode)) throw new Error('Modalità antifurto non valida');
    state.armingError = null;
    if (mode === 'none') { state.mode = 'none'; state.armingUntil = null; state.intrusion = null; return; }
    const blocked = blockedSensors(state);
    if (blocked.length) { state.armingUntil = null; state.armingError = blocked; throw Object.assign(new Error('INSERIMENTO NON CONSENTITO'), { blocked }); }
    state.mode = mode;
    state.armingUntil = mode === 'complete' ? this.now() + state.settings.armingMinutes * 60_000 : null;
  })).state; }
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
