import path from 'node:path';
import { CameraManager, c410WorkerPath, defaultCameraPython, RoleRuntimeManager, verifyTapoC410 } from '@smarthome/core';
import { CAMERA_TELEMETRY_TTL_MS, readCameraTelemetry } from './camera-telemetry.js';
import { readCameraPrivacy, setCameraPrivacy } from './camera-privacy.js';

export const OWNED_CAMERA_ADAPTER = 'tapo-c410-owned';
export const CAMERA_ROLE_MAP = Object.freeze({ C1: 'camera_terrazzo', C2: 'camera_pond', C3: 'camera_giardino' });
const EMPTY_TELEMETRY = () => ({
  battery: { available: false, percent: null, charging: null },
  events: { available: false, count: null, windowHours: 12 },
  privacy: { available: false, enabled: null },
  telemetryUpdatedAt: null,
});
const EMPTY = role => ({ role, configured: false, sourceType: 'owned', online: false, available: false, alias: null, model: null, updatedAt: null, error: null, status: 'NOT_CONFIGURED', imageAvailable: false, live: false, ...EMPTY_TELEMETRY() });

export class HomeCameraRuntime {
  constructor({ hardwareStore, roleStore, root, env = process.env, readTelemetry = readCameraTelemetry, readPrivacy = readCameraPrivacy, setPrivacy = setCameraPrivacy, now = Date.now, telemetryTtlMs = CAMERA_TELEMETRY_TTL_MS }) {
    Object.assign(this, { hardwareStore, roleStore, root, env, readTelemetry, readPrivacy, setPrivacy, now, telemetryTtlMs });
    this.telemetryCache = new Map();
    this.telemetryPending = new Map();
    this.privacyPending = new Map();
    this.owned = new RoleRuntimeManager({ category: 'camera', emptySnapshot: () => EMPTY('C1'), createRuntime: (record, signature) => new CameraManager({
      ip: record.ip, pythonPath: defaultCameraPython(root), workerPath: c410WorkerPath(), env,
      outputDirectory: path.join(root, 'data', 'camera', record.id, signature),
    }) });
  }

  telemetryFor(record) {
    const cached = this.telemetryCache.get(record.id);
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    return cached?.signature === signature && cached.expiresAt > this.now() ? { ...EMPTY_TELEMETRY(), ...cached.value } : EMPTY_TELEMETRY();
  }

  scheduleTelemetry(record) {
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const cached = this.telemetryCache.get(record.id);
    if ((cached?.signature === signature && cached.expiresAt > this.now()) || this.telemetryPending.has(record.id)) return;
    const pending = this.readTelemetry({ ip: record.connection?.ip, root: this.root, env: this.env, now: this.now() })
      .catch(() => EMPTY_TELEMETRY())
      .then(value => this.telemetryCache.set(record.id, { signature, value, expiresAt: this.now() + this.telemetryTtlMs }))
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
      return { ...EMPTY(role), configured: true, alias: record.alias, model: record.model, status: 'ERROR', error: 'Camera non disponibile' };
    }
  }

  async snapshot() {
    const { registry, assignments } = await this.reconcile();
    const [C1, C2, C3] = await Promise.all(['C1', 'C2', 'C3'].map(role => this.ownedState(role, registry, assignments)));
    return { C1, C2, C3 };
  }

  async imagePath(role) { await this.reconcile(); return this.owned.imagePath(CAMERA_ROLE_MAP[role]); }
  async setLive(role, active) {
    await this.reconcile();
    if (active) await this.owned.start(CAMERA_ROLE_MAP[role]); else await this.owned.stop(CAMERA_ROLE_MAP[role]);
    return (await this.snapshot())[role];
  }
  async getPrivacyMode(role) {
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const privacy = await this.readPrivacy({ ip: record.connection?.ip, root: this.root, env: this.env });
    const signature = `${record.id}:${record.connection?.ip || ''}`;
    const cached = this.telemetryCache.get(record.id);
    const value = { ...(cached?.signature === signature ? cached.value : EMPTY_TELEMETRY()), privacy };
    this.telemetryCache.set(record.id, { signature, value, expiresAt: this.now() + this.telemetryTtlMs });
    return privacy;
  }
  async setPrivacyMode(role, enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Stato Privacy non valido');
    if (this.privacyPending.has(role)) throw new Error('Operazione Privacy già in corso');
    const { registry, assignments } = await this.reconcile();
    const record = registry.devices.find(device => assignments[device.id] === CAMERA_ROLE_MAP[role] && device.metadata?.adapter === OWNED_CAMERA_ADAPTER);
    if (!record || !this.owned.has(record.id)) throw new Error('Camera non disponibile');
    const pending = this.setPrivacy({ ip: record.connection?.ip, root: this.root, env: this.env, enabled })
      .then(privacy => {
        if (privacy.enabled !== enabled) throw new Error('Read-back Privacy non coerente');
        const signature = `${record.id}:${record.connection?.ip || ''}`;
        const cached = this.telemetryCache.get(record.id);
        const value = { ...(cached?.signature === signature ? cached.value : EMPTY_TELEMETRY()), privacy };
        this.telemetryCache.set(record.id, { signature, value, expiresAt: this.now() + this.telemetryTtlMs });
        return privacy;
      })
      .finally(() => this.privacyPending.delete(role));
    this.privacyPending.set(role, pending);
    return pending;
  }
  async verify(record) { return verifyTapoC410({ ip: record.connection?.ip }, { pythonPath: defaultCameraPython(this.root), env: this.env }); }
  async close() { await this.owned.close(); }
}
