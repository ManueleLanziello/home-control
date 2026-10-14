export const CAMERA_WAKE_TIME_ZONE = 'Europe/Rome';
export const CAMERA_WAKE_TIMES = new Set(['00:00', '06:30', '18:00']);

function localTimeParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
}

// This scheduler intentionally starts from the next minute boundary. It never
// replays a wake-up that was missed while the server was stopped.
export class CameraWakeScheduler {
  constructor({ cameraRuntime, now = () => new Date(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, timeZone = CAMERA_WAKE_TIME_ZONE, logError = () => {} }) {
    Object.assign(this, { cameraRuntime, now, setTimeoutFn, clearTimeoutFn, timeZone, logError });
    this.timer = null;
    this.running = null;
    this.lastSlot = null;
    this.stopped = true;
  }

  start() {
    if (this.timer || this.running) return;
    this.stopped = false;
    this.scheduleNextMinute();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimeoutFn(this.timer);
    this.timer = null;
  }

  scheduleNextMinute() {
    if (this.stopped) return;
    const now = this.now().getTime();
    const delay = 60_000 - (now % 60_000);
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.check().finally(() => { if (!this.timer && !this.stopped) this.scheduleNextMinute(); });
    }, delay);
    this.timer.unref?.();
  }

  async check() {
    const parts = localTimeParts(this.now(), this.timeZone);
    const time = `${parts.hour}:${parts.minute}`;
    const slot = `${parts.year}-${parts.month}-${parts.day}T${time}`;
    if (!CAMERA_WAKE_TIMES.has(time) || this.lastSlot === slot || this.running) return false;
    this.lastSlot = slot;
    this.running = this.wakeCameras().catch(error => this.logError(`Wake-up telecamere fallito: ${error.message || error}`)).finally(() => { this.running = null; });
    await this.running;
    return true;
  }

  async wakeCameras() {
    for (const role of ['C1', 'C2']) {
      try { await this.cameraRuntime.wakeForTelemetry(role); }
      catch (error) { this.logError(`Wake-up ${role} fallito: ${error.message || error}`); }
    }
  }
}
