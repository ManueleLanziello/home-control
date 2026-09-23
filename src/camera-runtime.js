import path from 'node:path';
import { CameraManager, c410WorkerPath, defaultCameraPython, RoleRuntimeManager, verifyTapoC410 } from '@smarthome/core';
import { CAMERA_TELEMETRY_TTL_MS, readCameraTelemetry } from './camera-telemetry.js';
import { readCameraDetection, setCameraDetection } from './camera-detection.js';
import { readCameraPrivacy, setCameraPrivacy } from './camera-privacy.js';
import { readCameraAlarm, setCameraAlarm } from './camera-alarm.js';
import { readCameraEvents, normalizeCameraEvents } from './camera-events.js';
import { readCameraRecording } from './camera-recording.js';
import { readCameraRecentEvents } from './camera-recent-events.js';
import { CameraOperationQueue } from './camera-operation-queue.js';

export const OWNED_CAMERA_ADAPTER = 'tapo-c410-owned';
export const CAMERA_ROLE_MAP = Object.freeze({ C1: 'camera_terrazzo', C2: 'camera_pond', C3: 'camera_giardino' });
const RECORDING_CACHE_TTL_MS = 3 * 60_000;
const EVENT_MONITOR_INTERVAL_MS = 10_000;
const EVENT_ALERT_MS = 15_000;
const EMPTY_TELEMETRY = () => ({
  battery: { available: false, percent: null, charging: null },
  events: { available: false, count: null, windowHours: 12 },
  detection: null,
  privacy: { available: false, enabled: null },
  alarm: { available: false, enabled: null },
  telemetryUpdatedAt: null,
});
const EMPTY = role => ({ role, configured: false, sourceType: 'owned', online: false, available: false, alias: null, model: null, updatedAt: null, error: null, status: 'NOT_CONFIGURED', imageAvailable: false, live: false, ...EMPTY_TELEMETRY() });

export class HomeCameraRuntime {
  constructor({ hardwareStore, roleStore, root, env = process.env, readTelemetry = readCameraTelemetry, readDetection = readCameraDetection, setDetection = setCameraDetection, readPrivacy = readCameraPrivacy, setPrivacy = setCameraPrivacy, readAlarm = readCameraAlarm, setAlarm = setCameraAlarm, readEvents = readCameraEvents, readRecording = readCameraRecording, readRecentEvents = readCameraRecentEvents, now = Date.now, telemetryTtlMs = CAMERA_TELEMETRY_TTL_MS, recordingTtlMs = RECORDING_CACHE_TTL_MS, eventMonitorIntervalMs = EVENT_MONITOR_INTERVAL_MS, eventAlertMs = EVENT_ALERT_MS }) {
    Object.assign(this, { hardwareStore, roleStore, root, env, readTelemetry, readDetection, setDetection, readPrivacy, setPrivacy, readAlarm, setAlarm, readEvents, readRecording, readRecentEvents, now, telemetryTtlMs, recordingTtlMs, eventMonitorIntervalMs, eventAlertMs });
    this.telemetryCache = new Map();
    this.telemetryPending = new Map();
    this.detectionPending = new Map();
    this.privacyPending = new Map();
    this.alarmPending = new Map();
    this.eventsPending = new Map();
    this.eventsCache = new Map();
    this.recordingCache = new Map();
    this.recordingPending = new Map();
    this.eventMonitorState = new Map();
    this.eventMonitorPending = new Map();
    this.eventMonitorTimer = null;
    this.eventMonitorRefresh = null;
    this.operations = new CameraOperationQueue();
    this.owned = new RoleRuntimeManager({ category: 'camera', emptySnapshot: () => EMPTY('C1'), createRuntime: (record, signature) => new CameraManager({
      ip: record.ip, pythonPath: defaultCameraPython(root), workerPath: c410WorkerPath(), env,
      outputDirectory: path.join(root, 'data', 'camera', record.id, signature),
    }) });
  }

  telemetryFor(record) {
    const cached = this.telemetryCache.get(record.id);
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const { recordings, ...value } = cached?.signature === signature ? cached.value : EMPTY_TELEMETRY();
    return { ...EMPTY_TELEMETRY(), ...value };
  }

  cacheControl(record, update) {
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const cached = this.telemetryCache.get(record.id);
    const value = { ...(cached?.signature === signature ? cached.value : EMPTY_TELEMETRY()), ...update };
    const controlUpdatedAt = { ...(cached?.signature === signature ? cached.controlUpdatedAt : {}) };
    for (const kind of Object.keys(update)) controlUpdatedAt[kind] = this.now();
    this.telemetryCache.set(record.id, { signature, value, controlUpdatedAt, expiresAt: cached?.signature === signature ? cached.expiresAt : 0 });
  }

  recentControl(record, kind) {
    const cached = this.telemetryCache.get(record.id);
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const updatedAt = cached?.controlUpdatedAt?.[kind];
    if (cached?.signature !== signature || !Number.isFinite(updatedAt) || this.now() - updatedAt > 30_000) return null;
    const value = cached.value[kind];
    if (kind === 'detection') return typeof value === 'boolean' ? { available: true, enabled: value } : null;
    return typeof value?.enabled === 'boolean' ? value : null;
  }

  scheduleTelemetry(record) {
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const cached = this.telemetryCache.get(record.id);
    if ((cached?.signature === signature && cached.expiresAt > this.now()) || this.telemetryPending.has(record.id)) return;
    const pending = this.operations.run(record.id, () => this.readTelemetry({ ip: record.connection?.ip, root: this.root, env: this.env, now: this.now() }), { background: true })
      .then(value => {
        const latest = this.telemetryCache.get(record.id);
        const previous = latest?.signature === signature ? latest.value : EMPTY_TELEMETRY();
        // A failed individual getter cannot erase an earlier real value.
        const privacy = typeof value.privacy?.enabled === 'boolean' ? value.privacy : previous.privacy;
        const detection = typeof value.detection === 'boolean' ? value.detection : previous.detection;
        const alarm = typeof value.alarm?.enabled === 'boolean' ? value.alarm : previous.alarm;
        const controlUpdatedAt = { ...(latest?.signature === signature ? latest.controlUpdatedAt : {}) };
        if (typeof value.privacy?.enabled === 'boolean') controlUpdatedAt.privacy = this.now();
        if (typeof value.detection === 'boolean') controlUpdatedAt.detection = this.now();
        if (typeof value.alarm?.enabled === 'boolean') controlUpdatedAt.alarm = this.now();
        this.telemetryCache.set(record.id, { signature, value: { ...previous, ...value, privacy, detection, alarm,
          battery: value.battery?.available ? value.battery : previous.battery,
          events: value.events?.available ? value.events : previous.events,
          recordings: value.recordings?.available ? value.recordings : previous.recordings }, controlUpdatedAt, expiresAt: this.now() + this.telemetryTtlMs });
      })
      .catch(() => {
        const latest = this.telemetryCache.get(record.id);
        if (latest?.signature === signature) latest.expiresAt = this.now() + this.telemetryTtlMs;
        else this.telemetryCache.set(record.id, { signature, value: EMPTY_TELEMETRY(), expiresAt: this.now() + this.telemetryTtlMs });
      })
      .finally(() => this.telemetryPending.delete(record.id));
    this.telemetryPending.set(record.id, pending);
  }

  async reconcile() {
    const registry = await this.hardwareStore.read();
    const assignments = await this.roleStore.read(registry.devices.map(device => device.id));
    const records = registry.devices.filter(device => device.metadata?.adapter === OWNED_CAMERA_ADAPTER
      && device.configurationStatus === 'complete' && device.verificationStatus === 'verified');
    await this.owned.reconcile(records.map(device => ({ id: device.id, model: device.model, ip: device.connection?.ip, mac: device.identity?.mac })), assignments);
    return { registry, assignments };
  }

  async ownedState(role, registry, assignments) {
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record) return EMPTY(role);
    const active = this.owned.has(record.id);
    try {
      const technical = active ? await this.owned.snapshot(CAMERA_ROLE_MAP[role]) : EMPTY(role);
      const telemetry = this.telemetryFor(record);
      if (active && technical.live !== true) this.scheduleTelemetry(record);
      return { ...technical, role, configured: record.configurationStatus === 'complete', sourceType: 'owned', alias: record.alias, model: record.model,
        online: active && technical.status !== 'ERROR', available: active && technical.status !== 'ERROR', error: technical.error || null, ...telemetry };
    } catch {
      return { ...EMPTY(role), ...this.telemetryFor(record), configured: true, alias: record.alias, model: record.model, status: 'ERROR', error: 'Camera non disponibile' };
    }
  }

  async snapshot() {
    const { registry, assignments } = await this.reconcile();
    const [C1, C2, C3] = await Promise.all(['C1', 'C2', 'C3'].map(role => this.ownedState(role, registry, assignments)));
    const alerts = this.getCameraEventAlerts();
    return { C1: { ...C1, recentEventAlert: alerts.C1 }, C2: { ...C2, recentEventAlert: alerts.C2 }, C3: { ...C3, recentEventAlert: alerts.C3 } };
  }

  async imagePath(role) { await this.reconcile(); return this.owned.imagePath(CAMERA_ROLE_MAP[role]); }
  async setLive(role, active) {
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    await this.operations.run(record.id, () => active ? this.owned.start(CAMERA_ROLE_MAP[role]) : this.owned.stop(CAMERA_ROLE_MAP[role]));
    return (await this.snapshot())[role];
  }
  async getDetectionMode(role) {
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const detection = await this.operations.run(record.id, () => this.recentControl(record, 'detection') || this.readDetection({ ip: record.connection?.ip, root: this.root, env: this.env }));
    this.cacheControl(record, { detection: detection.enabled });
    return detection;
  }
  async setDetectionMode(role, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato Rilevazione non valido');
    if (this.detectionPending.has(role)) throw new Error('Operazione Rilevazione già in corso');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const pending = this.operations.run(record.id, () => this.setDetection({ ip: record.connection?.ip, root: this.root, env: this.env, enabled }))
      .then(detection => {
        if (detection.enabled !== enabled) throw new Error('Read-back Rilevazione non coerente');
        this.cacheControl(record, { detection: detection.enabled });
        return detection;
      })
      .finally(() => this.detectionPending.delete(role));
    this.detectionPending.set(role, pending);
    return pending;
  }
  async getPrivacyMode(role) {
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const privacy = await this.operations.run(record.id, () => this.recentControl(record, 'privacy') || this.readPrivacy({ ip: record.connection?.ip, root: this.root, env: this.env }));
    this.cacheControl(record, { privacy });
    return privacy;
  }
  async setPrivacyMode(role, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato Privacy non valido');
    if (this.privacyPending.has(role)) throw new Error('Operazione Privacy già in corso');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const pending = this.operations.run(record.id, () => this.setPrivacy({ ip: record.connection?.ip, root: this.root, env: this.env, enabled }))
      .then(privacy => {
        if (privacy.enabled !== enabled) throw new Error('Read-back Privacy non coerente');
        this.cacheControl(record, { privacy });
        return privacy;
      })
      .finally(() => this.privacyPending.delete(role));
    this.privacyPending.set(role, pending);
    return pending;
  }
  async verify(record) { return this.operations.run(record.id, () => verifyTapoC410({ ip: record.connection?.ip }, { pythonPath: defaultCameraPython(this.root), env: this.env })); }
  async getAlarmMode(role) {
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const alarm = await this.operations.run(record.id, () => this.recentControl(record, 'alarm') || this.readAlarm({ ip: record.connection?.ip, root: this.root, env: this.env }));
    this.cacheControl(record, { alarm });
    return alarm;
  }
  async setAlarmMode(role, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato Allarme non valido');
    if (this.alarmPending.has(role)) throw new Error('Operazione Allarme già in corso');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const pending = this.operations.run(record.id, () => this.setAlarm({ ip: record.connection?.ip, root: this.root, env: this.env, enabled }))
      .then(alarm => { if (alarm.enabled !== enabled) throw new Error('Read-back Allarme non coerente'); this.cacheControl(record, { alarm }); return alarm; })
      .finally(() => this.alarmPending.delete(role));
    this.alarmPending.set(role, pending);
    return pending;
  }
  async getCameraEvents(role, hours = 12) {
    if (hours !== 12) throw new Error('Finestra storico non supportata');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const cached = this.telemetryCache.get(record.id);
    if (cached?.signature === signature && cached.expiresAt > this.now() && cached.value.recordings?.available) {
      return { camera: role, ...normalizeCameraEvents({ recordings: cached.value.recordings }, this.now()) };
    }
    const eventCache = this.eventsCache.get(record.id);
    if (eventCache?.signature === signature && eventCache.expiresAt > this.now()) return { camera: role, ...eventCache.value };
    if (this.eventsPending.has(record.id)) return this.eventsPending.get(record.id);
    const pending = this.operations.run(record.id, () => {
      const latest = this.telemetryCache.get(record.id);
      if (latest?.signature === signature && latest.expiresAt > this.now() && latest.value.recordings?.available) {
        return normalizeCameraEvents({ recordings: latest.value.recordings }, this.now());
      }
      return this.readEvents({ ip: record.connection?.ip, root: this.root, env: this.env, now: this.now() });
    })
      .then(events => {
        if (events.available) this.eventsCache.set(record.id, { signature, value: events, expiresAt: this.now() + 60_000 });
        return { camera: role, ...events };
      })
      .finally(() => this.eventsPending.delete(record.id));
    this.eventsPending.set(record.id, pending);
    return pending;
  }
  async getCameraEventVideo(role, eventId) {
    if (!/^\d+-\d+$/.test(eventId)) throw new Error('Registrazione non valida');
    const events = await this.getCameraEvents(role);
    const event = events.events.find(item => item.id === eventId);
    if (!event) throw new Error('Registrazione non disponibile');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const key = `${record.id}:${eventId}`;
    const cached = this.recordingCache.get(key);
    if (cached && cached.expiresAt > this.now()) return this.acquireRecording(key, cached);
    if (cached) await this.deleteRecording(key, cached);
    if (this.recordingPending.has(key)) return this.recordingPending.get(key);
    const pending = this.operations.run(record.id, () => this.readRecording({ ip: record.connection?.ip, root: this.root, env: this.env, startTime: event.startTime, endTime: event.endTime }), { background: true })
      .then(recording => {
        const entry = { recording, expiresAt: this.now() + this.recordingTtlMs, users: 0, expired: false, timer: null };
        entry.timer = setTimeout(() => { entry.expired = true; if (!entry.users) this.deleteRecording(key, entry); }, this.recordingTtlMs);
        entry.timer.unref?.(); this.recordingCache.set(key, entry);
        return this.acquireRecording(key, entry);
      })
      .finally(() => this.recordingPending.delete(key));
    this.recordingPending.set(key, pending);
    return pending;
  }
  acquireRecording(key, entry) {
    entry.users += 1;
    let released = false;
    return { path: entry.recording.path, size: entry.recording.size, release: async () => {
      if (released) return;
      released = true; entry.users -= 1;
      if (entry.expired) await this.deleteRecording(key, entry);
    } };
  }
  async deleteRecording(key, entry = this.recordingCache.get(key)) {
    if (!entry || entry.users) return;
    clearTimeout(entry.timer); if (this.recordingCache.get(key) === entry) this.recordingCache.delete(key); await entry.recording.cleanup();
  }
  startEventMonitor() {
    if (this.eventMonitorTimer) return;
    void this.refreshEventMonitor();
    this.eventMonitorTimer = setInterval(() => void this.refreshEventMonitor(), this.eventMonitorIntervalMs);
    this.eventMonitorTimer.unref?.();
  }
  async refreshEventMonitor() {
    if (this.eventMonitorRefresh) return this.eventMonitorRefresh;
    this.eventMonitorRefresh = (async () => {
      try {
        const { registry, assignments } = await this.reconcile();
        await Promise.all(['C1', 'C2'].map(role => this.refreshCameraEventMonitor(role, registry, assignments)));
      } catch { /* A monitoring failure is isolated from camera controls and status. */ }
      finally { this.eventMonitorRefresh = null; }
    })();
    return this.eventMonitorRefresh;
  }
  async refreshCameraEventMonitor(role, registry, assignments) {
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id) || this.eventMonitorPending.has(record.id)) return;
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const pending = this.operations.run(record.id, () => this.readRecentEvents({ ip: record.connection?.ip, root: this.root, env: this.env }), { background: true })
      .then(result => {
        if (!result.available) return;
        const latest = result.events[0] || null;
        const previous = this.eventMonitorState.get(role);
        if (previous?.signature !== signature) {
          this.eventMonitorState.set(role, { signature, baseline: true, lastSeenEventId: latest ? String(latest.startTime) : null, alertUntil: 0, alertVersion: null });
          return;
        }
        if (!previous) {
          this.eventMonitorState.set(role, { signature, baseline: true, lastSeenEventId: latest ? String(latest.startTime) : null, alertUntil: 0, alertVersion: null });
          return;
        }
        const eventId = latest ? String(latest.startTime) : null;
        if (eventId && (!previous.lastSeenEventId || Number(eventId) > Number(previous.lastSeenEventId))) {
          previous.lastSeenEventId = eventId;
          previous.alertVersion = eventId;
          previous.alertUntil = this.now() + this.eventAlertMs;
        }
      })
      .catch(() => {})
      .finally(() => this.eventMonitorPending.delete(record.id));
    this.eventMonitorPending.set(record.id, pending);
    return pending;
  }
  getCameraEventAlerts() {
    const now = this.now();
    return Object.fromEntries(['C1', 'C2', 'C3'].map(role => {
      const state = this.eventMonitorState.get(role);
      const active = state?.alertUntil > now && Boolean(state?.alertVersion);
      return [role, { active, version: active ? state.alertVersion : null, until: active ? state.alertUntil : null }];
    }));
  }
  async close() { clearInterval(this.eventMonitorTimer); await Promise.all([...this.recordingCache.entries()].map(([key, entry]) => { entry.expired = true; return this.deleteRecording(key, entry); })); await this.owned.close(); }
}
