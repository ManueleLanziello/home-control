export class DoorVoiceAutomation {
  constructor({ settings, publish }) { this.settings = settings; this.publish = publish; this.connected = false; this.contact = null; this.openedAt = null; this.lastAlertAt = null; this.timer = null; this.sequence = 0; }
  clear() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  invalidate() { this.clear(); this.contact = null; this.openedAt = null; this.lastAlertAt = null; this.publish({ type: 'door-cancel' }); }
  connection(connected) { this.connected = connected === true; if (!this.connected) this.invalidate(); }
  observe(contact, retained) {
    if (!this.connected) return;
    if (retained) { if (this.contact === null && typeof contact === 'boolean') this.contact = contact; return; }
    if (typeof contact !== 'boolean') { this.invalidate(); return; }
    if (contact === true) { this.invalidate(); this.contact = true; return; }
    if (this.contact === false) return;
    this.contact = false; this.openedAt = Date.now(); this.lastAlertAt = null;
    if (this.settings.enabled) this.schedule();
  }
  configure(settings) {
    const previous = this.settings; this.settings = settings;
    if (!settings.enabled) { this.clear(); this.publish({ type: 'door-cancel' }); return; }
    if (!previous.enabled || !this.connected || this.contact !== false || this.openedAt === null) return;
    if (previous.delay !== settings.delay || previous.repeat !== settings.repeat) this.schedule(true);
  }
  schedule(changed = false) {
    this.clear();
    if (!this.connected || !this.settings.enabled || this.contact !== false || this.openedAt === null) return;
    const now = Date.now();
    let due = this.lastAlertAt === null ? this.openedAt + this.settings.delay * 1000 : this.settings.repeat ? this.lastAlertAt + this.settings.repeat * 1000 : null;
    if (due === null) return;
    if (changed && due <= now) {
      if (!this.settings.repeat) return;
      due = now + this.settings.repeat * 1000;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.connected || !this.settings.enabled || this.contact !== false) return;
      this.lastAlertAt = Date.now();
      this.publish({ type: 'door-voice', id: `door-voice-${Date.now()}-${++this.sequence}`, volume: this.settings.volume });
      this.schedule();
    }, Math.max(0, due - now));
  }
  close() { this.invalidate(); }
}
