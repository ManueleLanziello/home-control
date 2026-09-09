import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROLE_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const HOME_SENSOR_ROLES = Object.freeze(['temperature_cucina', 'temperature_camera', 'temperature_cameretta']);

export class DeviceRoleStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.writeQueue = Promise.resolve();
  }

  async read(deviceIds) {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      return this.#normalize(parsed.assignments, deviceIds);
    } catch (error) {
      if (error.code === 'ENOENT') return Object.fromEntries(deviceIds.map((id) => [id, 'none']));
      throw error;
    }
  }

  async write(assignments, deviceIds) {
    const normalized = this.#normalize(assignments, deviceIds);
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, assignments: normalized }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return normalized;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  async assignSensor(deviceId, role, deviceIds) {
    if (!HOME_SENSOR_ROLES.includes(role) && role !== 'none') throw new Error('Ruolo sensore non valido.');
    const operation = this.writeQueue.then(async () => {
      const assignments = await this.read(deviceIds);
      if (!Object.hasOwn(assignments, deviceId)) throw new Error('Sensore non configurato.');
      if (role !== 'none') {
        for (const id of deviceIds) if (id !== deviceId && assignments[id] === role) assignments[id] = 'none';
      }
      assignments[deviceId] = role;
      const normalized = this.#normalize(assignments, deviceIds);
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({ version: 1, assignments: normalized }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return normalized;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  #normalize(assignments, deviceIds) {
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
      throw new Error('Configurazione ruoli non valida.');
    }
    return Object.fromEntries(deviceIds.map((id) => {
      const role = assignments[id] ?? 'none';
      if (role !== 'none' && !ROLE_PATTERN.test(role)) throw new Error(`Ruolo non valido per ${id}.`);
      return [id, role];
    }));
  }
}
