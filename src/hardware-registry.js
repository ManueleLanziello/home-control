import crypto from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HARDWARE_REGISTRY_VERSION = 4;
export const CONNECTION_TYPES = Object.freeze(['lan', 'cloud']);

export class HardwareRegistryError extends Error {
  constructor(message, code = 'INVALID_HARDWARE_CONFIGURATION') {
    super(message);
    this.name = 'HardwareRegistryError';
    this.code = code;
  }
}

function requiredText(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new HardwareRegistryError(`${label} obbligatorio.`, `MISSING_${label.toUpperCase()}`);
  return normalized;
}

function normalizeConnectionType(value) {
  const connectionType = String(value || '').trim().toLowerCase();
  if (!CONNECTION_TYPES.includes(connectionType)) {
    throw new HardwareRegistryError('Tipo di connessione non valido.', 'INVALID_CONNECTION_TYPE');
  }
  return connectionType;
}

export function normalizeHardwareRecord(input) {
  const connectionType = normalizeConnectionType(input.connectionType);
  return {
    id: requiredText(input.id, 'id'),
    alias: requiredText(input.alias, 'alias'),
    model: requiredText(input.model, 'model'),
    protocol: requiredText(input.protocol, 'protocol'),
    connectionType,
    ...(input.manufacturer ? { manufacturer: String(input.manufacturer).trim() } : {}),
    ...(input.type ? { type: String(input.type).trim() } : {}),
    configurationStatus: input.configurationStatus === 'complete' ? 'complete' : 'incomplete',
    verificationStatus: input.verificationStatus === 'verified' ? 'verified' : 'pending',
    verifiedAt: input.verificationStatus === 'verified' ? input.verifiedAt || null : null,
  };
}

export function validateHardwareRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HardwareRegistryError('Registro hardware non valido.');
  }
  const devices = (value.devices || []).map(normalizeHardwareRecord);
  const ids = new Set();
  for (const device of devices) {
    if (ids.has(device.id)) throw new HardwareRegistryError('ID dispositivo duplicato.', 'DUPLICATE_ID');
    ids.add(device.id);
  }
  return { version: HARDWARE_REGISTRY_VERSION, devices };
}

export function defaultHardwareRegistry() {
  return { version: HARDWARE_REGISTRY_VERSION, devices: [] };
}

export class HardwareRegistryStore {
  constructor({ filePath, defaults = defaultHardwareRegistry(), idFactory = () => crypto.randomUUID() }) {
    this.filePath = filePath;
    this.defaults = validateHardwareRegistry(defaults);
    this.idFactory = idFactory;
    this.writeQueue = Promise.resolve();
  }

  async read() {
    try {
      return validateHardwareRegistry(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write(this.defaults);
      return structuredClone(this.defaults);
    }
  }

  async write(registry) {
    const validated = validateHardwareRegistry(registry);
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
      return validated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }
}
