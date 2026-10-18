// Coordinates physical siren commands without changing AlarmRuntime state.
// A generation token prevents an ON queued before a disarm from being sent.
export class AlarmSirenController {
  constructor({ send, logError = () => {} } = {}) { this.send = send; this.logError = logError; this.generation = 0; this.onRequested = false; }
  activate() {
    if (this.onRequested) return;
    this.onRequested = true; const generation = ++this.generation;
    queueMicrotask(() => { if (!this.onRequested || generation !== this.generation) return; Promise.resolve(this.send(true)).catch(error => this.logError(error)); });
  }
  stop({ force = false } = {}) {
    const shouldStop = this.onRequested || force; this.onRequested = false; this.generation += 1;
    if (!shouldStop) return Promise.resolve(false);
    return Promise.resolve(this.send(false)).then(() => true).catch(error => { this.logError(error); return false; });
  }
}
