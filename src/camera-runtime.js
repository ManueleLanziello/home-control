import path from 'node:path';
import { CameraManager, c410WorkerPath, defaultCameraPython, RoleRuntimeManager, verifyTapoC410 } from '@smarthome/core';

export const OWNED_CAMERA_ADAPTER = 'tapo-c410-owned';
export const SHARED_CAMERA_ROLE = 'camera_pond';
export const CAMERA_ROLE_MAP = Object.freeze({ C1: 'camera_terrazzo', C2: SHARED_CAMERA_ROLE, C3: 'camera_giardino' });
const EMPTY = role => ({ role, configured: false, sourceType: role === 'C2' ? 'shared' : 'owned', online: false, available: false, alias: null, model: null, updatedAt: null, error: null, status: 'NOT_CONFIGURED', imageAvailable: false, live: false });

function withTimeout(task, timeoutMs) {
  let timer;
  return Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pond timeout')), timeoutMs); })]).finally(() => clearTimeout(timer));
}

export class HomeCameraRuntime {
  constructor({ hardwareStore, roleStore, root, env = process.env, fetchImpl = fetch, pondUrl = env.POND_CONTROL_URL?.trim() || '' }) {
    Object.assign(this, { hardwareStore, roleStore, root, env, fetchImpl, pondUrl: pondUrl.replace(/\/$/, '') });
    this.owned = new RoleRuntimeManager({ category: 'camera', emptySnapshot: () => EMPTY('C1'), createRuntime: (record, signature) => new CameraManager({
      ip: record.ip, pythonPath: defaultCameraPython(root), workerPath: c410WorkerPath(), env,
      outputDirectory: path.join(root, 'data', 'camera', record.id, signature),
    }) });
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
    const technical = active ? await this.owned.snapshot(CAMERA_ROLE_MAP[role]) : EMPTY(role);
    return { ...technical, role, configured: record.configurationStatus === 'complete', sourceType: 'owned', alias: record.alias, model: record.model,
      online: active && technical.status !== 'ERROR', available: active && technical.status !== 'ERROR', error: technical.error || null };
  }

  async sharedState() {
    const empty = { ...EMPTY('C2'), configured: Boolean(this.pondUrl), sourceType: 'shared', status: this.pondUrl ? 'UNAVAILABLE' : 'NOT_CONFIGURED' };
    if (!this.pondUrl) return empty;
    try {
      const response = await this.requestPond('/api/camera/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Pond HTTP ${response.status}`);
      const camera = await response.json();
      const available = camera.assigned !== false && camera.runtimeActive !== false && camera.status !== 'ERROR';
      return { ...camera, role: 'C2', sourceType: 'shared', configured: Boolean(camera.configured), online: available, available,
        alias: camera.alias || null, model: camera.model || null, updatedAt: camera.updatedAt || null, error: camera.error || null };
    } catch {
      return { ...empty, error: 'Pond non disponibile' };
    }
  }

  async snapshot() {
    const { registry, assignments } = await this.reconcile();
    return { C1: await this.ownedState('C1', registry, assignments), C2: await this.sharedState(), C3: await this.ownedState('C3', registry, assignments) };
  }

  async imagePath(role) { await this.reconcile(); return this.owned.imagePath(CAMERA_ROLE_MAP[role]); }
  async requestPond(endpoint, options = {}, timeoutMs = 4000) {
    if (!this.pondUrl) throw new Error('Pond non configurato');
    return withTimeout(this.fetchImpl(`${this.pondUrl}${endpoint}`, options), timeoutMs);
  }
  async setLive(role, active) {
    if (role === 'C2') {
      if (!this.pondUrl) throw new Error('Pond non configurato');
      const response = await this.requestPond('/api/camera/live', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }) }, 8000);
      if (!response.ok) throw new Error('Comando camera Pond non disponibile');
      return this.sharedState();
    }
    await this.reconcile();
    if (active) await this.owned.start(CAMERA_ROLE_MAP[role]); else await this.owned.stop(CAMERA_ROLE_MAP[role]);
    return (await this.snapshot())[role];
  }
  async verify(record) { return verifyTapoC410({ ip: record.connection?.ip }, { pythonPath: defaultCameraPython(this.root), env: this.env }); }
  async close() { await this.owned.close(); }
}
