import path from 'node:path';
import { CameraManager, c410WorkerPath, defaultCameraPython, RoleRuntimeManager, verifyTapoC410 } from '@smarthome/core';

export const OWNED_CAMERA_ADAPTER = 'tapo-c410-owned';
export const CAMERA_ROLE_MAP = Object.freeze({ C1: 'camera_terrazzo', C2: 'camera_pond', C3: 'camera_giardino' });
const EMPTY = role => ({ role, configured: false, sourceType: 'owned', online: false, available: false, alias: null, model: null, updatedAt: null, error: null, status: 'NOT_CONFIGURED', imageAvailable: false, live: false });

export class HomeCameraRuntime {
  constructor({ hardwareStore, roleStore, root, env = process.env }) {
    Object.assign(this, { hardwareStore, roleStore, root, env });
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
    try {
      const technical = active ? await this.owned.snapshot(CAMERA_ROLE_MAP[role]) : EMPTY(role);
      return { ...technical, role, configured: record.configurationStatus === 'complete', sourceType: 'owned', alias: record.alias, model: record.model,
        online: active && technical.status !== 'ERROR', available: active && technical.status !== 'ERROR', error: technical.error || null };
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
  async verify(record) { return verifyTapoC410({ ip: record.connection?.ip }, { pythonPath: defaultCameraPython(this.root), env: this.env }); }
  async close() { await this.owned.close(); }
}
