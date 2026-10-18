// Coordinates physical siren commands without changing AlarmRuntime state.
// A generation token prevents an ON queued before a disarm from being sent.
export class AlarmSirenController {
  constructor({ send, logError = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) { this.send = send; this.logError = logError; this.setTimeoutFn = setTimeoutFn; this.clearTimeoutFn = clearTimeoutFn; this.generation = 0; this.onRequested = false; this.alarmActive = false; this.testActive = false; this.testTimer = null; }
  activate() {
    this.alarmActive = true; this.cancelTestTimer(); this.testActive = false;
    if (this.onRequested) return;
    this.onRequested = true; const generation = ++this.generation;
    queueMicrotask(() => { if (!this.onRequested || generation !== this.generation) return; Promise.resolve(this.send(true)).catch(error => this.logError(error)); });
  }
  cancelTestTimer() { if (this.testTimer) this.clearTimeoutFn(this.testTimer); this.testTimer = null; }
  async startTest() {
    if (this.alarmActive || this.testActive) return false;
    this.testActive = true; const generation = ++this.generation; this.onRequested = true;
    try { await this.send(true); }
    catch (error) { if (generation === this.generation && this.testActive) { this.testActive = false; this.onRequested = false; } this.logError(error); throw error; }
    if (generation !== this.generation || !this.testActive || this.alarmActive) return false;
    this.testTimer = this.setTimeoutFn(() => { void this.stopTest(); }, 3_000);
    return true;
  }
  stopTest() {
    if (!this.testActive) return Promise.resolve(false);
    this.testActive = false; this.cancelTestTimer(); this.generation += 1;
    if (this.alarmActive) return Promise.resolve(false);
    const shouldStop = this.onRequested; this.onRequested = false;
    if (!shouldStop) return Promise.resolve(false);
    return Promise.resolve(this.send(false)).then(() => true).catch(error => { this.logError(error); return false; });
  }
  stop({ force = false } = {}) {
    this.alarmActive = false;
    if (this.testActive) return this.stopTest();
    const shouldStop = this.onRequested || force; this.onRequested = false; this.generation += 1;
    if (!shouldStop) return Promise.resolve(false);
    return Promise.resolve(this.send(false)).then(() => true).catch(error => { this.logError(error); return false; });
  }
}
