// Coordinates physical siren commands without changing AlarmRuntime state.
// A generation token prevents an ON queued before a disarm from being sent.
const DEFAULT_SEQUENCE = Object.freeze({ soundEnabled: true, lightEnabled: true, soundType: 'siren_classic', volumeLevel: 'medium', duration: 30, pauseSeconds: 30, cycleCount: 5 });
export class AlarmSirenController {
  constructor({ send, configure = async () => {}, logError = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) { this.send = send; this.configure = configure; this.logError = logError; this.setTimeoutFn = setTimeoutFn; this.clearTimeoutFn = clearTimeoutFn; this.generation = 0; this.onRequested = false; this.alarmActive = false; this.testActive = false; this.testTimer = null; this.sequenceTimer = null; this.sequenceActive = false; this.stopPending = false; this.stopAttempt = null; }
  cancelSequenceTimer() { if (this.sequenceTimer) this.clearTimeoutFn(this.sequenceTimer); this.sequenceTimer = null; }
  async sendStop() {
    if (this.stopAttempt) return this.stopAttempt;
    const attempt = Promise.resolve(this.send(false)).then(() => { this.stopPending = false; return true; }).catch(error => { this.stopPending = true; this.logError(error); return false; });
    this.stopAttempt = attempt;
    try { return await attempt; } finally { if (this.stopAttempt === attempt) this.stopAttempt = null; }
  }
  retryPendingStop() { return this.stopPending ? this.sendStop() : Promise.resolve(false); }
  async activate(settings) {
    if (this.alarmActive || this.sequenceActive || this.stopPending) return false;
    this.alarmActive = true; this.sequenceActive = true; this.cancelTestTimer(); this.testActive = false;
    const generation = ++this.generation; const snapshot = { ...DEFAULT_SEQUENCE, ...structuredClone(settings || {}) };
    try { await this.configure(snapshot); } catch (error) { this.logError(error); }
    if (generation !== this.generation || !this.alarmActive) return false;
    const runCycle = cycle => {
      if (generation !== this.generation || !this.alarmActive) return;
      this.onRequested = true;
      Promise.resolve(this.send(true)).catch(error => this.logError(error));
      this.sequenceTimer = this.setTimeoutFn(() => { void (async () => {
        if (generation !== this.generation || !this.alarmActive) return;
        this.onRequested = false;
        const stopped = await this.sendStop();
        if (generation !== this.generation || !this.alarmActive || !stopped) { this.sequenceActive = false; return; }
        if (cycle >= snapshot.cycleCount) { this.sequenceActive = false; this.sequenceTimer = null; return; }
        this.sequenceTimer = this.setTimeoutFn(() => runCycle(cycle + 1), snapshot.pauseSeconds * 1000);
      })(); }, snapshot.duration * 1000);
    };
    runCycle(1); return true;
  }
  cancelTestTimer() { if (this.testTimer) this.clearTimeoutFn(this.testTimer); this.testTimer = null; }
  async startTest(settings = { duration: 3 }) {
    if (this.alarmActive || this.testActive || this.stopPending) return false;
    this.testActive = true; const generation = ++this.generation; this.onRequested = true;
    try { await this.send(true); }
    catch (error) { if (generation === this.generation && this.testActive) { this.testActive = false; this.onRequested = false; } this.logError(error); throw error; }
    if (generation !== this.generation || !this.testActive || this.alarmActive) return false;
    this.testTimer = this.setTimeoutFn(() => { void this.stopTest(); }, settings.duration * 1000);
    return true;
  }
  stopTest() {
    if (!this.testActive) return Promise.resolve(false);
    this.testActive = false; this.cancelTestTimer(); this.generation += 1;
    if (this.alarmActive) return Promise.resolve(false);
    const shouldStop = this.onRequested; this.onRequested = false;
    if (!shouldStop) return Promise.resolve(false);
    return this.sendStop();
  }
  stop({ force = false } = {}) {
    this.alarmActive = false; this.sequenceActive = false; this.cancelSequenceTimer();
    if (this.testActive) return this.stopTest();
    const shouldStop = this.onRequested || force; this.onRequested = false; this.generation += 1;
    if (!shouldStop) return Promise.resolve(false);
    return this.sendStop();
  }
}
