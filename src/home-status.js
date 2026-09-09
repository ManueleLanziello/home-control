import { TuyaCloudClient } from '@smarthome/core';
import { HomeDewinRuntime, isDewinTuyaDevice } from './dewin-runtime.js';

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
  const source = cloudValid ? snapshot.thermostat || {} : {};
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

export class HomeStatusRuntime {
  constructor({ hardwareStore, roleStore, readThermostat, createSensorRuntime, now = Date.now, cacheMs = 30_000, timeoutMs = 12_000 }) {
    Object.assign(this, { hardwareStore, roleStore, readThermostat, now, cacheMs, timeoutMs });
    this.createSensorRuntime = createSensorRuntime || (device => new HomeDewinRuntime({ device, client: new TuyaCloudClient({
      clientId: process.env.TUYA_CLIENT_ID, clientSecret: process.env.TUYA_CLIENT_SECRET,
      deviceId: device.identity?.tuyaDeviceId || device.tuyaDeviceId,
    }) }));
    this.runtimes = new Map();
    this.pendingReads = new Map();
    this.cached = null;
    this.pending = null;
  }
  invalidate() { this.cached = null; }
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
    if (this.pending) return this.pending;
    // Re-read the small local configuration before returning a cached hardware snapshot.
    this.pending = this.refresh().finally(() => { this.pending = null; });
    return this.pending;
  }
  async refresh() {
    const registry = await this.hardwareStore.read();
    const assignments = await this.roleStore.read(registry.devices.map(device => device.id));
    const signature = JSON.stringify([registry.devices, assignments]);
    if (this.cached?.signature === signature && this.now() < this.cached.expiresAt) return structuredClone(this.cached.snapshot);
    const currentKeys = new Set(registry.devices.map(device => JSON.stringify(device)));
    for (const key of this.runtimes.keys()) if (!currentKeys.has(key)) this.runtimes.delete(key);
    const thermostatRead = this.readDevice('thermostat', this.readThermostat).then(
      value => value, () => null);
    const entries = await Promise.all(Object.entries(HOME_ROLES).map(async ([id, role]) => {
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
    // Another device may have taken time: check freshness again at snapshot publication.
    for (const entry of Object.values(values)) {
      if (entry.available && !fresh(entry.updatedAt, this.now())) Object.assign(entry, { available: false, online: false, value: null, reason: 'stale' });
    }
    const sensors = Object.fromEntries(['S1','S2','S4','S5'].map(id => [id, values[id]]));
    const room = thermostat.thermostat.currentTemperature;
    sensors.S3 = { source: 'thermostat', value: room, available: Number.isFinite(room), online: thermostat.online, updatedAt: thermostat.updatedAt };
    const indoors = ['S1','S2','S3','S4'].map(id => sensors[id].value).filter(Number.isFinite);
    const snapshot = { updatedAt: new Date(this.now()).toISOString(), sensors, thermostat,
      lights: Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith('L'))),
      cameras: Object.fromEntries(Object.entries(values).filter(([id]) => id.startsWith('C'))),
      // S3 alone is the WT200 room reading, not a whole-house average.
      averageTemperature: indoors.length > 1 ? indoors.reduce((a,b)=>a+b,0)/indoors.length : null,
      indoorSensorCount: indoors.length,
    };
    const timestamps = [...Object.values(sensors).filter(sensor => sensor.available).map(sensor => sensor.updatedAt), thermostat.online ? thermostat.updatedAt : null].filter(Boolean);
    const expiresAt = Math.min(this.now() + this.cacheMs, ...timestamps.map(time => Date.parse(time) + MAX_AGE_MS));
    this.cached = { signature, expiresAt, snapshot };
    return structuredClone(snapshot);
  }
}
