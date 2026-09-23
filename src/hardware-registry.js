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

function optionalText(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
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
    // Preserve only runtime identity/adapter selection, never cloud credentials.
    ...(input.identity?.tuyaDeviceId || input.identity?.mac ? { identity: { ...(input.identity?.tuyaDeviceId ? { tuyaDeviceId: String(input.identity.tuyaDeviceId).trim() } : {}), ...(input.identity?.mac ? { mac: String(input.identity.mac).trim().toUpperCase() } : {}) } } : {}),
    ...(input.connection?.ip ? { connection: { ip: String(input.connection.ip).trim() } } : {}),
    ...(input.tuyaDeviceId ? { tuyaDeviceId: String(input.tuyaDeviceId).trim() } : {}),
    ...(input.metadata?.adapter ? { metadata: { adapter: String(input.metadata.adapter).trim(), ...(input.metadata?.sourceApp ? { sourceApp: String(input.metadata.sourceApp).trim() } : {}) } } : {}),
    configurationStatus: input.configurationStatus === 'complete' ? 'complete' : 'incomplete',
    verificationStatus: input.verificationStatus === 'verified' ? 'verified' : 'pending',
    verifiedAt: input.verificationStatus === 'verified' ? input.verifiedAt || null : null,
  };
}

function normalizeInventoryRecord(input) {
  if (typeof input.presenceEnabled !== 'boolean') {
    throw new HardwareRegistryError('Configurazione presence non valida.', 'INVALID_PRESENCE_CONFIGURATION');
  }
  const identity = {
    ...(optionalText(input.identity?.mac) ? { mac: optionalText(input.identity.mac).toUpperCase() } : {}),
    ...(optionalText(input.identity?.ieeeAddress) ? { ieeeAddress: optionalText(input.identity.ieeeAddress) } : {}),
    ...(optionalText(input.identity?.deviceId) ? { deviceId: optionalText(input.identity.deviceId) } : {}),
  };
  const network = {
    ...(optionalText(input.network?.ipv4) ? { ipv4: optionalText(input.network.ipv4) } : {}),
    ...(optionalText(input.network?.ipv6) ? { ipv6: optionalText(input.network.ipv6) } : {}),
    ...(optionalText(input.network?.medium) ? { medium: optionalText(input.network.medium) } : {}),
  };
  return {
    marker: requiredText(input.marker, 'marker'),
    name: requiredText(input.name, 'name'),
    ...(optionalText(input.model) ? { model: optionalText(input.model) } : {}),
    ...(optionalText(input.role) ? { role: optionalText(input.role) } : {}),
    ...(optionalText(input.hostname) ? { hostname: optionalText(input.hostname) } : {}),
    ...(optionalText(input.protocol) ? { protocol: optionalText(input.protocol) } : {}),
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(Object.keys(network).length ? { network } : {}),
    ...(optionalText(input.friendlyName) ? { friendlyName: optionalText(input.friendlyName) } : {}),
    ...(optionalText(input.topic) ? { topic: optionalText(input.topic) } : {}),
    presenceEnabled: input.presenceEnabled,
    ...(input.status === 'future' ? { status: 'future' } : { status: 'active' }),
  };
}

export function validateHardwareRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HardwareRegistryError('Registro hardware non valido.');
  }
  const devices = (value.devices || []).map(normalizeHardwareRecord);
  const inventory = (value.inventory || []).map(normalizeInventoryRecord);
  const ids = new Set();
  const tuyaDeviceIds = new Set();
  for (const device of devices) {
    if (ids.has(device.id)) throw new HardwareRegistryError('ID dispositivo duplicato.', 'DUPLICATE_ID');
    const tuyaDeviceId = device.identity?.tuyaDeviceId || device.tuyaDeviceId;
    if (tuyaDeviceId && tuyaDeviceIds.has(tuyaDeviceId)) throw new HardwareRegistryError('Identità Tuya duplicata.', 'DUPLICATE_TUYA_DEVICE_ID');
    ids.add(device.id);
    if (tuyaDeviceId) tuyaDeviceIds.add(tuyaDeviceId);
  }
  const markers = new Set();
  for (const item of inventory) {
    if (markers.has(item.marker)) throw new HardwareRegistryError('Marker inventario duplicato.', 'DUPLICATE_INVENTORY_MARKER');
    markers.add(item.marker);
  }
  return { version: HARDWARE_REGISTRY_VERSION, devices, inventory };
}

export function defaultHardwareRegistry() {
  return { version: HARDWARE_REGISTRY_VERSION, devices: [], inventory: [] };
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
