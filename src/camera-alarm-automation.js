const CAMERA_ROLES = Object.freeze(['C1', 'C2']);

export function cameraDetectionTarget(alarm = {}) {
  return alarm.mode !== 'none' || alarm.armingUntil != null || alarm.intrusion != null;
}

export class CameraAlarmAutomation {
  constructor({ alarmStore, cameraRuntime, store, logError = () => {} }) {
    Object.assign(this, { alarmStore, cameraRuntime, store, logError });
    this.enabled = false; this.loaded = false; this.started = false; this.generation = 0; this.desired = null;
    this.roles = new Map(CAMERA_ROLES.map(role => [role, { applied: null, pending: false, retryPending: false }]));
    this.listeners = new Set(); this.unsubscribeAlarm = null; this.unsubscribeContact = null;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot() { return { enabled: this.enabled }; }
  notify() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Observers cannot stop automation. */ } } }
  async ensureLoaded() { if (!this.loaded) { this.enabled = (await this.store.read()).enabled === true; this.loaded = true; } return this.snapshot(); }
  async start({ observeAlarm = true } = {}) {
    if (this.started) return this.snapshot();
    await this.ensureLoaded(); this.started = true;
    if (observeAlarm) this.unsubscribeAlarm = this.alarmStore.subscribe(() => { void this.reconcileFromAlarm(); });
    this.unsubscribeContact = this.cameraRuntime.subscribeContact?.(({ role, online }) => { if (online === true) void this.reconcileRole(role, { retryOnly: true }); }) || null;
    if (this.enabled) await this.reconcileFromAlarm();
    return this.snapshot();
  }
  handleAlarmEvent() { void this.reconcileFromAlarm(); }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato automazione CAM non valido');
    await this.ensureLoaded(); if (this.enabled === enabled) return this.snapshot();
    this.enabled = enabled; this.generation += 1; this.desired = null;
    if (!enabled) { for (const state of this.roles.values()) state.retryPending = false; await this.store.set(false); this.notify(); return this.snapshot(); }
    await this.store.set(true); this.notify(); await this.reconcileFromAlarm(); return this.snapshot();
  }
  async reconcileFromAlarm() {
    await this.ensureLoaded(); if (!this.enabled) return this.snapshot();
    this.desired = cameraDetectionTarget(await this.alarmStore.read());
    await Promise.all(CAMERA_ROLES.map(role => this.reconcileRole(role)));
    return this.snapshot();
  }
  async reconcileRole(role, { retryOnly = false } = {}) {
    if (!CAMERA_ROLES.includes(role) || !this.enabled || typeof this.desired !== 'boolean') return;
    const state = this.roles.get(role);
    if (retryOnly && !state.retryPending) return;
    if (state.pending || (!state.retryPending && state.applied === this.desired)) return;
    const target = this.desired; const generation = this.generation;
    state.pending = true; state.retryPending = false;
    try {
      const result = await this.cameraRuntime.setDetectionMode(role, target, { canExecute: () => this.enabled && generation === this.generation && this.desired === target });
      if (result?.skipped === true) return;
      if (result?.available !== true || result.enabled !== target) throw new Error('Read-back Rilevazione non coerente');
      state.applied = target;
    } catch (error) {
      if (this.enabled && generation === this.generation && this.desired === target) { state.retryPending = true; this.logError(`AUT-002 ${role}: ${error.message || error}`); }
    } finally { state.pending = false; }
    // A started camera command cannot be cancelled; only the latest target may follow it.
    if (this.enabled && generation === this.generation && this.desired !== target) await this.reconcileRole(role);
  }
  close() { this.generation += 1; this.unsubscribeAlarm?.(); this.unsubscribeContact?.(); this.unsubscribeAlarm = null; this.unsubscribeContact = null; this.started = false; }
}
