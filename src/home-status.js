import { TuyaCloudClient } from '@smarthome/core';
import { HomeDewinRuntime, isDewinTuyaDevice } from './dewin-runtime.js';
import { normalizeDeviceStatuses } from './device-status.js';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';

// Explicit logical assignments; never infer rooms from aliases or physical IDs.
export const HOME_ROLES = Object.freeze({
  S1: 'temperature_cucina', S2: 'temperature_camera', S4: 'temperature_cameretta', S5: 'temperature_giardino',
  L1: 'light_cucina', L2: 'light_camera', L3: 'light_salotto', L4: 'light_disimpegno', L5: 'light_bagno', L6: 'light_cameretta', L7: 'light_gazebo',
  C1: 'camera_terrazzo', C2: 'camera_pond', C3: 'camera_giardino',
});
const MAX_AGE_MS = 90_000;
const finite = value => Number.isFinite(value) ? value : null;
const bool = value => typeof value === 'boolean' ? value : null;
function fresh(timestamp, now) {
  const age = now - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -5000 && age <= MAX_AGE_MS;
}
export function normalizeThermostat(snapshot, now = Date.now()) {
  const cloudTime = snapshot && Object.hasOwn(snapshot, 'cloudUpdatedAt') ? snapshot.cloudUpdatedAt : snapshot?.updatedAt;
  const lanTime = snapshot && Object.hasOwn(snapshot, 'lanUpdatedAt') ? snapshot.lanUpdatedAt : snapshot?.updatedAt;
  const cloudValid = snapshot?.online === true && fresh(cloudTime, now);
  const lanValid = snapshot?.online === true && fresh(lanTime, now);
  const source = lanValid ? snapshot?.thermostat || {} : cloudValid ? snapshot?.thermostat || {} : {};
  const thermostat = Object.fromEntries(['currentTemperature', 'setpointTemperature', 'upperTemperatureLimit', 'temperatureCorrection'].map(key => [key, finite(source[key])]));
  for (const key of ['enabled', 'childLock', 'frostProtection', 'sound']) thermostat[key] = bool(source[key]);
  thermostat.mode = typeof source.mode === 'string' ? source.mode : null;
  return {
    deviceId: snapshot ? 'thermostat' : null,
    online: cloudValid || lanValid,
    // Conservative timestamp: neither cloud nor LAN fields outlive their freshness window.
    updatedAt: cloudValid && lanValid ? (Date.parse(cloudTime) < Date.parse(lanTime) ? cloudTime : lanTime) : cloudValid ? cloudTime : lanValid ? lanTime : snapshot?.updatedAt ?? null,
    thermostat,
    heatingActive: lanValid ? bool(snapshot.heatingActive) : null,
    schedule: snapshot?.schedule ?? null,
    scheduleSource: snapshot?.scheduleSource ?? (snapshot?.schedule ? 'device' : null),
  };
}

export function normalizeCiarraState(snapshot, now = Date.now()) {
  const online = snapshot?.online === true && fresh(snapshot.updatedAt, now);
  const fanSpeed = Number.isInteger(snapshot?.fanSpeed) && snapshot.fanSpeed >= 0 && snapshot.fanSpeed <= 4 ? snapshot.fanSpeed : null;
  return {
    online,
    power: bool(snapshot?.power),
    fanSpeed,
    light: ['off', 'level1', 'level2'].includes(snapshot?.light) ? snapshot.light : null,
    operatingStatus: ['off', 'on'].includes(snapshot?.operatingStatus) ? snapshot.operatingStatus : null,
    updatedAt: snapshot?.updatedAt ?? null,
  };
}

export class HomeStatusRuntime {
  constructor({ hardwareStore, roleStore, readThermostat, readHood = null, readZigbeeSensors = null, readZigbeeLedbar = null, createSensorRuntime, readCameras = null, now = Date.now, cacheMs = 30_000, timeoutMs = 12_000 }) {
    Object.assign(this, { hardwareStore, roleStore, readThermostat, readHood, readZigbeeSensors, readZigbeeLedbar, readCameras, now, cacheMs, timeoutMs });
    this.createSensorRuntime = createSensorRuntime || (device => new HomeDewinRuntime({ device, client: new TuyaCloudClient({
      clientId: process.env.TUYA_CLIENT_ID_HOME, clientSecret: process.env.TUYA_CLIENT_SECRET_HOME,
      deviceId: process.env.TUYA_DEWIN_ID?.trim() || device.identity?.tuyaDeviceId || device.identity?.deviceId || device.tuyaDeviceId,
    }) }));
    this.runtimes = new Map();
    this.inventoryRuntimes = new Map();
    this.pendingReads = new Map();
    this.cached = null;
    this.pending = null;
    this.generation = 0;
  }
  invalidate() { this.cached = null; this.generation += 1; }
  async readDevice(key, read) {
    // A timed-out adapter stays coalesced until it settles; no accumulating cloud requests.
    if (!this.pendingReads.has(key)) {
      const pending = Promise.resolve().then(read);
      this.pendingReads.set(key, pending);
      pending.then(() => this.pendingReads.delete(key), () => this.pendingReads.delete(key));
    }
    let timer;
    try {
      return await Promise.race([this.pendingReads.get(key), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Device timeout')), this.timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async readSnapshot() {
    const generation = this.generation;
    if (this.pending?.generation === generation) return this.pending.promise;
    // Re-read the small local configuration before returning a cached hardware snapshot.
    const entry = { generation, promise: null };
    entry.promise = this.refresh(generation).finally(() => { if (this.pending === entry) this.pending = null; });
    this.pending = entry;
    return entry.promise;
  }
  async refresh(generation = this.generation) {
    const registry = await this.hardwareStore.read();
    const assignments = await this.roleStore.read(registry.devices.map(device => device.id));
    const signature = JSON.stringify([registry.devices, registry.inventory, assignments]);
    if (this.cached?.signature === signature && this.now() < this.cached.expiresAt) return structuredClone(this.cached.snapshot);
    const currentKeys = new Set(registry.devices.map(device => JSON.stringify(device)));
    for (const key of this.runtimes.keys()) if (!currentKeys.has(key)) this.runtimes.delete(key);
    const thermostatRead = this.readDevice('thermostat', this.readThermostat).then(
      value => value, () => null);
    const hoodRead = this.readHood
      ? this.readDevice('hood', this.readHood).then(value => value, () => null)
      : Promise.resolve(null);
    const inventoryDewinRead = this.readInventoryDewin(registry.inventory).then(value => value, () => null);
    let zigbeeSensors;
    try { zigbeeSensors = this.readZigbeeSensors?.(); } catch { /* MQTT must not block the Home snapshot. */ }
    const entries = await Promise.all(Object.entries(HOME_ROLES).map(async ([id, role]) => {
      if (this.readZigbeeSensors && ['S1', 'S2', 'S4'].includes(id)) {
        const sensor = zigbeeSensors?.[id];
        const age = this.now() - Date.parse(sensor?.updatedAt);
        const online = sensor?.online === true && age >= 0 && age <= ZIGBEE_SENSOR_CONFIG.freshnessMs;
        const temperature = finite(sensor?.temperature);
        const available = online && temperature !== null && sensor?.available !== false;
        return [id, { temperature, humidity: finite(sensor?.humidity), battery: finite(sensor?.battery),
          linkQuality: finite(sensor?.linkQuality), name: sensor?.name ?? `SmartHome${id}`,
          model: 'SONOFF SNZB-02P', protocol: 'Zigbee', source: 'zigbee', configured: true,
          online, available, value: available ? temperature : null,
          updatedAt: sensor?.updatedAt ?? null, reason: available ? null : sensor?.updatedAt ? 'offline' : 'no_data' }];
      }
      const devices = registry.devices.filter(device => assignments[device.id] === role);
      const device = devices.length === 1 ? devices[0] : null;
      const entry = { configured: devices.length > 0, available: false, online: false, value: null, state: null, alias: device?.alias ?? null, updatedAt: null,
        source: id.startsWith('L') && !devices.length ? 'simulation' : 'hardware',
        reason: devices.length > 1 ? 'ambiguous_role' : device ? 'unsupported_adapter' : 'not_configured' };
      if (!device) return [id, entry];
      if (device.configurationStatus !== 'complete' || device.verificationStatus !== 'verified') return [id, { ...entry, reason: 'not_verified' }];
      if (!id.startsWith('S') || !isDewinTuyaDevice(device)) return [id, entry];
      if (!(device.identity?.tuyaDeviceId || device.tuyaDeviceId)) return [id, { ...entry, reason: 'missing_identity' }];
      try {
        const key = JSON.stringify(device);
        if (!this.runtimes.has(key)) this.runtimes.set(key, this.createSensorRuntime(device));
        const snapshot = await this.readDevice(key, () => this.runtimes.get(key).readSnapshot());
        const value = finite(snapshot.measurements?.ambientTemperature?.value);
        const isFresh = fresh(snapshot.updatedAt, this.now());
        const available = snapshot.online === true && isFresh && value !== null;
        return [id, { ...entry, online: snapshot.online === true && isFresh, available, value: available ? value : null, updatedAt: snapshot.updatedAt ?? null,
          reason: !isFresh ? 'stale' : snapshot.online !== true ? 'offline' : value === null ? 'no_data' : null }];
      } catch { return [id, { ...entry, reason: 'unavailable' }]; }
    }));
    const values = Object.fromEntries(entries);
    const thermostat = normalizeThermostat(await thermostatRead, this.now());
    const hood = normalizeCiarraState(await hoodRead, this.now());
    // Another device may have taken time: check freshness again at snapshot publication.
    for (const entry of Object.values(values)) {
      if (entry.source === 'zigbee') {
        const age = this.now() - Date.parse(entry.updatedAt);
        if (entry.online && !(age >= 0 && age <= ZIGBEE_SENSOR_CONFIG.freshnessMs)) Object.assign(entry, { available: false, online: false, value: null, reason: 'stale' });
      } else if (entry.available && !fresh(entry.updatedAt, this.now())) Object.assign(entry, { available: false, online: false, value: null, reason: 'stale' });
    }
    const sensors = Object.fromEntries(['S1','S2','S4','S5'].map(id => [id, values[id]]));
    const room = thermostat.thermostat.currentTemperature;
    sensors.S3 = { source: 'thermostat', value: room, available: Number.isFinite(room), online: thermostat.online, updatedAt: thermostat.updatedAt };
    const indoors = ['S1','S2','S3','S4'].map(id => sensors[id].value).filter(Number.isFinite);
    const cameras = this.readCameras ? await this.readCameras() : Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith('C')));
    let ledbar = null;
    try { ledbar = this.readZigbeeLedbar?.(); } catch { /* MQTT must not block the Home snapshot. */ }
    const inventoryDewin = await inventoryDewinRead;
    const snapshot = { updatedAt: new Date(this.now()).toISOString(), sensors, thermostat, hood,
      ledbar: ledbar || { id: 'LB1', name: 'SmartHomeLB1', state: null, brightness: null, online: false, available: false, updatedAt: null },
      lights: Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith('L'))),
      cameras,
      devices: normalizeDeviceStatuses(registry.inventory, { selfOnline: true, ledbar, hood, thermostat, cameras, zigbee: zigbeeSensors, dewin: inventoryDewin }, this.now()),
      // S3 alone is the WT200 room reading, not a whole-house average.
      averageTemperature: indoors.length > 1 ? indoors.reduce((a,b)=>a+b,0)/indoors.length : null,
      indoorSensorCount: indoors.length,
    };
    const timestamps = [...Object.values(sensors).filter(sensor => sensor.available && sensor.source !== 'zigbee').map(sensor => sensor.updatedAt), thermostat.online ? thermostat.updatedAt : null, hood.online ? hood.updatedAt : null].filter(Boolean);
    const zigbeeExpirations = Object.values(sensors).filter(sensor => sensor.source === 'zigbee' && sensor.online).map(sensor => Date.parse(sensor.updatedAt) + ZIGBEE_SENSOR_CONFIG.freshnessMs);
    const expiresAt = Math.min(this.now() + this.cacheMs, ...timestamps.map(time => Date.parse(time) + MAX_AGE_MS), ...zigbeeExpirations);
    if (generation === this.generation) this.cached = { signature, expiresAt, snapshot };
    return structuredClone(snapshot);
  }

  async readInventoryDewin(inventory = []) {
    const item = inventory.find(entry => entry.marker === 'D18' && entry.presenceEnabled === true);
    const deviceId = item?.identity?.deviceId;
    if (!deviceId) return null;
    const key = `${item.marker}:${deviceId}`;
    if (!this.inventoryRuntimes.has(key)) {
      this.inventoryRuntimes.set(key, this.createSensorRuntime({
        id: `inventory-${item.marker}`,
        alias: item.name,
        identity: { tuyaDeviceId: deviceId },
      }));
    }
    return this.readDevice(`inventory:${key}`, () => this.inventoryRuntimes.get(key).readSnapshot());
  }
}
