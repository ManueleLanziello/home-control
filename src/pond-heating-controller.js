import { validatePondHeatingConfig } from './pond-heating-store.js';

const MINUTE = 60_000;
const nowIso = now => new Date(now()).toISOString();
const clone = value => structuredClone(value);

function measurement(sensor, { live = false } = {}) {
  const value = sensor?.temperature;
  const updatedAt = sensor?.updatedAt;
  if (!Number.isFinite(value) || !Number.isFinite(Date.parse(updatedAt))) return null;
  if (live && (sensor?.available !== true || sensor?.online !== true || sensor?.confirmed !== true)) return null;
  return { value, updatedAt };
}

function reliableState(snapshot, role) {
  const runtime = (snapshot?.plugs || []).find(plug => plug.role === role)?.runtime;
  const state = runtime?.state;
  return runtime?.online === true && runtime?.communicationDegraded !== true && runtime?.consecutiveFailures === 0 && (state === 'ON' || state === 'OFF') ? state : null;
}

function outcome(kind) { return `INTERROTTO — ${kind}`; }

export class PondHeatingController {
  constructor({ pondController, store, runCommand = operation => operation(), now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, publish = async () => {} }) {
    Object.assign(this, { pondController, store, runCommand, now, setTimeoutFn, clearTimeoutFn, publish });
    this.queue = Promise.resolve(); this.timer = null; this.ready = null; this.pondSnapshot = null; this.deviceVerified = false; this.lastObservedMeasurementAt = null; this.latestMeasurement = null;
  }

  enqueue(operation) {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async initialize() {
    this.ready ||= this.enqueue(async () => {
      const saved = await this.store.update(state => {
        if (!state.activeCycle) return;
        this.completeInState(state, outcome('RIAVVIO'), state.activeCycle.lastMeasurement || null);
      });
      this.deviceVerified = false;
      return saved.state;
    });
    return this.ready;
  }

  async snapshot() {
    await this.initialize();
    const state = await this.store.read();
    return this.describe(state);
  }

  describe(state) {
    const active = state.activeCycle;
    const phase = active?.phase || 'waiting';
    return {
      config: clone(state.config), activeCycle: active ? clone(active) : null, history: clone(state.history),
      latestMeasurement: this.latestMeasurement ? clone(this.latestMeasurement) : null,
      lastCompletedMeasurementAt: state.lastCompletedMeasurementAt,
      deviceVerified: this.deviceVerified,
      status: phase === 'on' ? 'cycle-running' : phase === 'off' ? 'pause-between-repetitions' : phase === 'interrupting' ? 'interrupted' : 'waiting',
    };
  }

  async setConfig(input) {
    await this.initialize();
    return this.enqueue(async () => {
      const current = await this.store.read();
      const config = validatePondHeatingConfig(input, current.config);
      // A manual-mode request cannot expose manual controls until the existing
      // automatic cycle has completed its safe heater-off path.
      if (config.mode === 'manual' && current.activeCycle) await this.interruptInternal('MODALITÀ MANUALE');
      await this.store.update(state => { state.config = config; });
      const next = await this.snapshot();
      await this.publish();
      return next;
    });
  }

  async observeS5(sensor) {
    await this.initialize();
    return this.enqueue(async () => {
      const currentMeasurement = measurement(sensor);
      if (!currentMeasurement || currentMeasurement.updatedAt === this.lastObservedMeasurementAt) return this.snapshot();
      this.lastObservedMeasurementAt = currentMeasurement.updatedAt;
      this.latestMeasurement = currentMeasurement;
      const state = await this.store.read();
      if (state.activeCycle) {
        await this.store.update(next => { if (next.activeCycle) next.activeCycle.lastMeasurement = currentMeasurement; });
        await this.publish();
        return this.snapshot();
      }
      const liveMeasurement = measurement(sensor, { live: true });
      const completedAt = Date.parse(state.lastCompletedMeasurementAt);
      const measuredAt = Date.parse(liveMeasurement?.updatedAt);
      const canStart = state.config.mode === 'thermostat' && this.deviceVerified && liveMeasurement
        && liveMeasurement.value <= state.config.threshold
        && (!Number.isFinite(completedAt) || measuredAt > completedAt)
        && reliableState(this.pondSnapshot, 'pump') === 'ON'
        && reliableState(this.pondSnapshot, 'heater') === 'OFF';
      if (canStart) await this.startInternal(liveMeasurement);
      return this.snapshot();
    });
  }

  async observePondState(snapshot, monitor = null) {
    await this.initialize();
    return this.enqueue(async () => {
      this.pondSnapshot = snapshot;
      const pump = reliableState(snapshot, 'pump'); const heater = reliableState(snapshot, 'heater');
      if (pump && heater) this.deviceVerified = true;
      if ((monitor?.action === 'heater-off' || (await this.store.read()).activeCycle) && pump !== 'ON') await this.interruptInternal('POMPA OFF', { heaterAlreadyOff: monitor?.action === 'heater-off' });
      await this.publish();
      return this.snapshot();
    });
  }

  async interrupt(reason, options = {}) {
    await this.initialize();
    return this.enqueue(() => this.interruptInternal(reason, options));
  }

  async interruptInternal(reason, { heaterAlreadyOff = false } = {}) {
    const state = await this.store.read();
    if (!state.activeCycle) return this.snapshot();
    this.clearTimer();
    await this.store.update(next => { if (next.activeCycle) next.activeCycle.phase = 'interrupting'; });
    try {
      if (!heaterAlreadyOff) await this.runCommand(() => this.pondController.set('heater', false));
      await this.store.update(next => { this.completeInState(next, outcome(reason), next.activeCycle?.lastMeasurement || null); });
    } catch (error) {
      await this.publish();
      throw error;
    }
    await this.publish();
    return this.snapshot();
  }

  async startInternal(initialMeasurement) {
    const saved = await this.store.update(state => {
      state.activeCycle = {
        id: state.nextCycleId++, startedAt: nowIso(this.now), completedAt: null, phase: 'starting', repetition: 1,
        config: clone(state.config), initialMeasurement, lastMeasurement: initialMeasurement,
      };
    });
    try {
      await this.runCommand(() => this.pondController.set('heater', true));
      await this.store.update(state => { if (state.activeCycle) state.activeCycle.phase = 'on'; });
      this.arm(saved.state.activeCycle.config.onMinutes * MINUTE, () => this.finishOn());
    } catch {
      await this.store.update(state => { this.completeInState(state, outcome('AVVIO RISCALDATORE NON RIUSCITO'), state.activeCycle?.lastMeasurement || null); });
    }
    await this.publish();
  }

  arm(delay, operation) {
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => { this.timer = null; void this.enqueue(operation); }, delay);
  }

  clearTimer() { if (this.timer !== null) { this.clearTimeoutFn(this.timer); this.timer = null; } }

  async finishOn() {
    const state = await this.store.read(); const active = state.activeCycle;
    if (!active || active.phase !== 'on') return;
    try { await this.runCommand(() => this.pondController.set('heater', false)); }
    catch { await this.store.update(next => { this.completeInState(next, outcome('SPEGNIMENTO RISCALDATORE NON RIUSCITO'), next.activeCycle?.lastMeasurement || null); }); await this.publish(); return; }
    if (active.repetition >= active.config.repetitions) {
      await this.store.update(next => { this.completeInState(next, 'COMPLETATO', next.activeCycle?.lastMeasurement || null); });
    } else {
      await this.store.update(next => { if (next.activeCycle) next.activeCycle.phase = 'off'; });
      this.arm(active.config.offMinutes * MINUTE, () => this.finishOff());
    }
    await this.publish();
  }

  async finishOff() {
    const state = await this.store.read(); const active = state.activeCycle;
    if (!active || active.phase !== 'off') return;
    try {
      await this.runCommand(() => this.pondController.set('heater', true));
      await this.store.update(next => { if (next.activeCycle) { next.activeCycle.repetition += 1; next.activeCycle.phase = 'on'; } });
      this.arm(active.config.onMinutes * MINUTE, () => this.finishOn());
    } catch {
      await this.store.update(next => { this.completeInState(next, outcome('AVVIO RISCALDATORE NON RIUSCITO'), next.activeCycle?.lastMeasurement || null); });
    }
    await this.publish();
  }

  completeInState(state, result, finalMeasurement) {
    const active = state.activeCycle;
    if (!active) return;
    const final = finalMeasurement || active.lastMeasurement || null;
    state.history.push({
      ...active, completedAt: nowIso(this.now), result, finalMeasurement: final,
      deltaTemperature: Number.isFinite(active.initialMeasurement?.value) && Number.isFinite(final?.value)
        ? final.value - active.initialMeasurement.value : null,
    });
    state.lastCompletedMeasurementAt = final?.updatedAt || active.initialMeasurement?.updatedAt || state.lastCompletedMeasurementAt;
    state.activeCycle = null;
  }
}
