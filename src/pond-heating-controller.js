import { validatePondHeatingConfig } from './pond-heating-store.js';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';

const MINUTE = 60_000;
const RETRY_DELAYS = [MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE];
const TRANSIENT_ERRORS = new Set(['PUMP_REQUIRED', 'DEVICE_WRITE_FAILED', 'DEVICE_BACKOFF', 'DEVICE_COMMUNICATION_FAILED']);
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
  constructor({ pondController, store, runCommand = operation => operation(), now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, publish = async () => {}, readS5 = null, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
    Object.assign(this, { pondController, store, runCommand, now, setTimeoutFn, clearTimeoutFn, publish, readS5, setIntervalFn, clearIntervalFn });
    this.queue = Promise.resolve(); this.timer = null; this.ready = null; this.pondSnapshot = null; this.deviceVerified = false; this.lastObservedMeasurementAt = null; this.latestMeasurement = null; this.currentSensor = null; this.periodicTimer = null; this.periodicPending = false; this.disposed = false; this.startupInterruptedOn = false; this.activationPending = false; this.resumeNotBefore = 0;
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
        this.startupInterruptedOn = ['on', 'starting', 'off'].includes(state.activeCycle.phase);
        if (state.activeCycle.phase === 'off') {
          this.resumeNotBefore = this.now() + state.activeCycle.config.offMinutes * MINUTE;
          state.resumeNotBefore = new Date(this.resumeNotBefore).toISOString();
        }
        this.completeInState(state, outcome('RIAVVIO'), state.activeCycle.lastMeasurement || null);
      });
      this.deviceVerified = false;
      this.resumeNotBefore = Math.max(this.resumeNotBefore, Date.parse(saved.state.resumeNotBefore) || 0);
      this.syncPeriodic(saved.state.config.mode);
      return saved.state;
    });
    return this.ready;
  }

  syncPeriodic(mode) {
    if (this.disposed || mode !== 'thermostat') {
      if (this.periodicTimer !== null) this.clearIntervalFn(this.periodicTimer);
      this.periodicTimer = null;
      return;
    }
    if (this.periodicTimer !== null) return;
    this.periodicTimer = this.setIntervalFn(() => {
      if (this.periodicPending || this.disposed) return;
      this.periodicPending = true;
      void this.enqueue(async () => { if (!this.disposed) await this.evaluateStart(); })
        .catch(() => console.warn('[pond-heating]', JSON.stringify({ action: 'periodic-evaluation-failed', code: 'UNKNOWN' })))
        .finally(() => { this.periodicPending = false; });
    }, MINUTE);
    this.periodicTimer?.unref?.();
  }

  dispose() {
    this.disposed = true;
    this.syncPeriodic('manual');
    this.clearTimer();
  }

  recordFailure(state, code) {
    if (!TRANSIENT_ERRORS.has(code)) {
      state.heatingRetry = { kind: 'blocked', code: code === 'STATE_MISMATCH' ? code : 'UNKNOWN' };
      return;
    }
    const failures = (state.heatingRetry?.kind === 'transient' ? state.heatingRetry.failures : 0) + 1;
    const delay = RETRY_DELAYS[Math.min(failures - 1, RETRY_DELAYS.length - 1)];
    state.heatingRetry = { kind: 'transient', code, failures, nextAttemptAt: new Date(this.now() + delay).toISOString() };
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
      retry: clone(state.heatingRetry || null), stopped: state.heatingStopped === true,
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
      await this.store.update(state => { state.config = config; if (config.mode === 'manual' || current.config.mode !== config.mode) { state.heatingRetry = null; state.heatingStopped = false; } });
      this.syncPeriodic(config.mode);
      if (config.mode === 'manual') { this.startupInterruptedOn = false; this.activationPending = false; }
      if (config.mode === 'thermostat' && current.config.mode !== 'thermostat') { this.activationPending = true; await this.evaluateStart(); }
      const next = await this.snapshot();
      await this.publish();
      return next;
    });
  }

  async evaluateStart() {
    if (this.disposed) return;
    const sensor = this.readS5 ? this.readS5() : this.currentSensor;
    const liveMeasurement = measurement(sensor, { live: true });
    const age = this.now() - Date.parse(liveMeasurement?.updatedAt);
    if (!liveMeasurement || !Number.isFinite(age) || age < 0 || age > ZIGBEE_SENSOR_CONFIG.freshnessMs) return;
    const state = await this.store.read();
    if (state.config.mode !== 'thermostat' || state.heatingStopped === true || state.activeCycle || this.now() < this.resumeNotBefore || !this.deviceVerified
      || liveMeasurement.value >= state.config.threshold
      || reliableState(this.pondSnapshot, 'pump') !== 'ON'
      || reliableState(this.pondSnapshot, 'heater') !== 'OFF') return;
    const completedAt = Date.parse(state.lastCompletedMeasurementAt);
    const measuredAt = Date.parse(liveMeasurement.updatedAt);
    const retry = state.heatingRetry;
    if (retry?.kind === 'blocked') return;
    const retryReady = retry?.kind === 'transient' && Number.isFinite(Date.parse(retry.nextAttemptAt)) && this.now() >= Date.parse(retry.nextAttemptAt);
    if (retry && !retryReady) return;
    const lastResult = state.lastHeatingResult ?? state.history.at(-1)?.result;
    const explicitRestart = this.activationPending && lastResult && lastResult !== 'COMPLETATO';
    if (!explicitRestart && !this.startupInterruptedOn && !retryReady && Number.isFinite(completedAt) && measuredAt <= completedAt) return;
    this.startupInterruptedOn = false; this.activationPending = false;
    this.latestMeasurement = liveMeasurement;
    await this.startInternal(liveMeasurement);
  }

  async observeS5(sensor) {
    await this.initialize();
    return this.enqueue(async () => {
      this.currentSensor = sensor;
      const currentMeasurement = measurement(sensor);
      if (!currentMeasurement) return this.snapshot();
      if (currentMeasurement.updatedAt !== this.lastObservedMeasurementAt) {
        this.lastObservedMeasurementAt = currentMeasurement.updatedAt;
        this.latestMeasurement = currentMeasurement;
        const state = await this.store.read();
        if (state.activeCycle) {
          await this.store.update(next => { if (next.activeCycle) next.activeCycle.lastMeasurement = currentMeasurement; });
          await this.publish();
          return this.snapshot();
        }
      }
      await this.evaluateStart();
      return this.snapshot();
    });
  }

  async clearHistory() {
    await this.initialize();
    return this.enqueue(async () => {
      await this.store.update(state => { state.history = []; });
      await this.publish();
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
      await this.evaluateStart();
      await this.publish();
      return this.snapshot();
    });
  }

  async interrupt(reason, options = {}) {
    await this.initialize();
    return this.enqueue(async () => { await this.store.update(state => { state.heatingStopped = true; state.heatingRetry = null; }); this.startupInterruptedOn = false; this.activationPending = false; return this.interruptInternal(reason, options); });
  }

  async interruptInternal(reason, { heaterAlreadyOff = false } = {}) {
    const state = await this.store.read();
    if (!state.activeCycle) return this.snapshot();
    this.clearTimer();
    await this.store.update(next => { if (next.activeCycle) next.activeCycle.phase = 'interrupting'; });
    try {
      if (!heaterAlreadyOff) await this.runCommand(() => this.pondController.set('heater', false));
      await this.store.update(next => { this.completeInState(next, outcome(reason), next.activeCycle?.lastMeasurement || null); if (reason === 'POMPA OFF') this.recordFailure(next, 'PUMP_REQUIRED'); });
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
      await this.store.update(state => { if (state.activeCycle) state.activeCycle.phase = 'on'; state.heatingRetry = null; });
      this.arm(saved.state.activeCycle.config.onMinutes * MINUTE, () => this.finishOn());
    } catch (error) {
      console.warn('[pond-heating]', JSON.stringify({ action: 'start-failed', code: ['PUMP_REQUIRED', 'ROLE_UNAVAILABLE', 'DEVICE_WRITE_FAILED', 'STATE_MISMATCH'].includes(error?.code) ? error.code : 'UNKNOWN' }));
      await this.store.update(state => { this.completeInState(state, outcome('AVVIO RISCALDATORE NON RIUSCITO'), state.activeCycle?.lastMeasurement || null); this.recordFailure(state, error?.code); });
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
    catch { await this.store.update(next => { this.completeInState(next, outcome('SPEGNIMENTO RISCALDATORE NON RIUSCITO'), next.activeCycle?.lastMeasurement || null); next.heatingRetry = { kind: 'blocked', code: 'HEATER_OFF_UNCONFIRMED' }; }); await this.publish(); return; }
    if (active.repetition >= active.config.repetitions) {
      let latest = null;
      try { latest = measurement(this.readS5 ? this.readS5() : this.currentSensor); } catch { /* Keep the last recorded measurement. */ }
      await this.store.update(next => {
        const recorded = next.activeCycle?.lastMeasurement || null;
        const final = latest && (!recorded || Date.parse(latest.updatedAt) > Date.parse(recorded.updatedAt)) ? latest : recorded;
        if (final) this.latestMeasurement = final;
        this.completeInState(next, 'COMPLETATO', final);
      });
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
    } catch (error) {
      console.warn('[pond-heating]', JSON.stringify({ action: 'restart-failed', code: ['PUMP_REQUIRED', 'ROLE_UNAVAILABLE', 'DEVICE_WRITE_FAILED', 'STATE_MISMATCH'].includes(error?.code) ? error.code : 'UNKNOWN' }));
      await this.store.update(next => { this.completeInState(next, outcome('AVVIO RISCALDATORE NON RIUSCITO'), next.activeCycle?.lastMeasurement || null); this.recordFailure(next, error?.code); });
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
    state.lastHeatingResult = result;
    state.lastCompletedMeasurementAt = final?.updatedAt || active.initialMeasurement?.updatedAt || state.lastCompletedMeasurementAt;
    state.activeCycle = null;
  }
}
