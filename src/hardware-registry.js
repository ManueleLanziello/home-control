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

export function normalizeMac(value) {
  const mac = String(value || '').trim().replaceAll('-', ':').toUpperCase();
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
    throw new HardwareRegistryError('Indirizzo MAC non valido.', 'INVALID_MAC');
  }
  return mac;
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
    ...(input.identity?.tuyaDeviceId || input.identity?.mac ? { identity: { ...(input.identity?.tuyaDeviceId ? { tuyaDeviceId: String(input.identity.tuyaDeviceId).trim() } : {}), ...(input.identity?.mac ? { mac: normalizeMac(input.identity.mac) } : {}) } } : {}),
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
  const presence = input.presence ? {
    method: ['icmp', 'tcp'].includes(input.presence.method) ? input.presence.method : (() => { throw new HardwareRegistryError('Metodo presence non valido.', 'INVALID_PRESENCE_METHOD'); })(),
    ...(Number.isInteger(input.presence.timeoutMs) && input.presence.timeoutMs > 0 ? { timeoutMs: input.presence.timeoutMs } : {}),
    ...(Number.isInteger(input.presence.failureThreshold) && input.presence.failureThreshold > 0 ? { failureThreshold: input.presence.failureThreshold } : {}),
    ...(input.presence.method === 'tcp' && Number.isInteger(input.presence.port) && input.presence.port > 0 && input.presence.port < 65536 ? { port: input.presence.port } : {}),
  } : null;
  if (presence?.method === 'tcp' && !presence.port) throw new HardwareRegistryError('Porta presence TCP non valida.', 'INVALID_PRESENCE_PORT');
  return {
    marker: requiredText(input.marker, 'marker'),
    name: requiredText(input.name, 'name'),
    ...(optionalText(input.model) ? { model: optionalText(input.model) } : {}),
    ...(optionalText(input.type) ? { type: optionalText(input.type) } : {}),
    ...(optionalText(input.role) ? { role: optionalText(input.role) } : {}),
    ...(optionalText(input.hostname) ? { hostname: optionalText(input.hostname) } : {}),
    ...(optionalText(input.category) ? { category: optionalText(input.category) } : {}),
    ...(optionalText(input.icon) ? { icon: optionalText(input.icon) } : {}),
    ...(optionalText(input.protocol) ? { protocol: optionalText(input.protocol) } : {}),
    ...(Object.keys(identity).length ? { identity } : {}),
    ...(Object.keys(network).length ? { network } : {}),
    ...(presence ? { presence } : {}),
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
  constructor({ filePath, sourceFilePath = null, defaults = defaultHardwareRegistry(), idFactory = () => crypto.randomUUID() }) {
    if (sourceFilePath && path.resolve(sourceFilePath) === path.resolve(filePath)) throw new HardwareRegistryError('Registro locale e configurazione distribuita devono avere percorsi diversi.');
    this.filePath = filePath;
    this.sourceFilePath = sourceFilePath;
    this.defaults = validateHardwareRegistry(defaults);
    this.idFactory = idFactory;
    this.writeQueue = Promise.resolve();
    this.bootstrapPromise = null;
    this.reconciliation = null;
  }

  async read() {
    if (this.sourceFilePath) await this.bootstrap();
    try {
      return validateHardwareRegistry(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.write(this.defaults);
      return structuredClone(this.defaults);
    }
  }

  async write(registry) {
    if (this.sourceFilePath) await this.bootstrap();
    const validated = validateHardwareRegistry(registry);
    const operation = this.writeQueue.then(async () => {
      if (this.reconciliation) {
        const ids = new Set(validated.devices.map(device => device.id));
        this.reconciliation.deletedDeviceIds = [...new Set([
          ...this.reconciliation.deletedDeviceIds,
          ...this.reconciliation.source.devices.filter(device => !ids.has(device.id)).map(device => device.id),
        ])].filter(id => !ids.has(id));
      }
      await this.persist(validated);
      return validated;
    });
    this.writeQueue = operation.catch(() => {});
    return operation;
  }

  bootstrap() {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.reconcile().catch(error => { this.bootstrapPromise = null; throw error; });
    }
    return this.bootstrapPromise;
  }

  async reconcile() {
    const source = validateHardwareRegistry(JSON.parse(await readFile(this.sourceFilePath, 'utf8')));
    let saved;
    try { saved = JSON.parse(await readFile(this.filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const local = saved ? validateHardwareRegistry(saved) : structuredClone(source);
    const previous = saved?.reconciliation?.source;
    const baseline = previous ? validateHardwareRegistry(previous) : source;
    const deleted = new Set(saved?.reconciliation?.deletedDeviceIds || []);
    const mergeCollection = (incoming, existing, old, key, tombstones = new Set()) => {
      const result = [];
      for (const record of incoming) {
        if (tombstones.has(record[key])) continue;
        const current = existing.find(item => item[key] === record[key]);
        const prior = old.find(item => item[key] === record[key]);
        if (!current) { result.push(structuredClone(record)); continue; }
        const merged = mergeDistributed(prior || record, record, current);
        if (key === 'id' && prior && JSON.stringify(technicalIdentity(prior)) !== JSON.stringify(technicalIdentity(record))) {
          for (const field of ['model', 'protocol', 'connectionType', 'identity', 'connection', 'tuyaDeviceId', 'metadata', 'configurationStatus']) {
            if (Object.hasOwn(record, field)) merged[field] = structuredClone(record[field]);
            else delete merged[field];
          }
          merged.verificationStatus = 'pending';
          merged.verifiedAt = null;
        }
        result.push(merged);
      }
      for (const record of existing) if (!incoming.some(item => item[key] === record[key])) result.push(structuredClone(record));
      return result;
    };
    const registry = validateHardwareRegistry({
      devices: mergeCollection(source.devices, local.devices, baseline.devices, 'id', deleted),
      inventory: mergeCollection(source.inventory, local.inventory, baseline.inventory, 'marker'),
    });
    this.reconciliation = { source, deletedDeviceIds: [...deleted] };
    const payload = { ...registry, reconciliation: this.reconciliation };
    if (JSON.stringify(saved) !== JSON.stringify(payload)) await this.persist(registry);
  }

  async persist(registry) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ ...registry, ...(this.reconciliation ? { reconciliation: this.reconciliation } : {}) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}

function technicalIdentity(record) {
  return [record.model, record.protocol, record.connectionType, record.identity, record.connection, record.tuyaDeviceId, record.metadata?.adapter];
}

// Three-way merge: distributed changes win only where the local value was not edited.
function mergeDistributed(previous, incoming, local) {
  const result = structuredClone(local);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(incoming)])) {
    if (['verificationStatus', 'verifiedAt', 'detected'].includes(key)) continue;
    if (JSON.stringify(local[key]) === JSON.stringify(previous[key])) {
      if (Object.hasOwn(incoming, key)) result[key] = structuredClone(incoming[key]);
      else delete result[key];
    } else if (previous[key] && incoming[key] && local[key] && typeof previous[key] === 'object' && !Array.isArray(previous[key])) {
      result[key] = mergeDistributed(previous[key], incoming[key], local[key]);
    }
  }
  return result;
}
