import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TuyaCloudClient,
  Wt200TuyaAdapter,
  Wt200TuyaLanAdapter,
  buildWt200LanSnapshot,
} from '@smarthome/core';
import { Wt200ScheduleStore } from './wt200-schedule-store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEDULE_FILE = path.join(ROOT, '..', 'data', 'wt200-schedule.json');

function unavailableCloudSnapshot(deviceId) {
  return {
    deviceId: deviceId ?? null,
    online: false,
    name: null,
    category: null,
    thermostat: {},
    rawDatapoints: [],
    updatedAt: null,
  };
}

export function mergeWt200Snapshots({ cloudSnapshot = null, lanSnapshot = null, persistedSchedule = null, deviceId = null }) {
  const cloud = cloudSnapshot || unavailableCloudSnapshot(deviceId);
  return {
    ...cloud,
    deviceId: cloud.deviceId ?? lanSnapshot?.deviceId ?? deviceId,
    online: cloud.online === true || lanSnapshot !== null,
    heatingActive: lanSnapshot?.heatingActive ?? null,
    rawDps: lanSnapshot?.rawDps ?? null,
    schedule: lanSnapshot?.schedule || persistedSchedule?.schedule || null,
    updatedAt: cloud.updatedAt ?? lanSnapshot?.updatedAt ?? persistedSchedule?.updatedAt ?? null,
  };
}

export class HomeWt200Runtime {
  constructor({ cloudAdapter = null, lanAdapter = null, scheduleStore = null, deviceId = null, now = () => new Date().toISOString(), client = null, adapter = null }) {
    this.cloudAdapter = cloudAdapter || adapter || (client ? new Wt200TuyaAdapter({ client, now }) : null);
    this.lanAdapter = lanAdapter;
    this.scheduleStore = scheduleStore;
    this.deviceId = deviceId;
    this.now = now;
    this.persistedSchedule = null;
    this.restorePromise = null;
    this.lanEventsBound = false;
    this.persistenceQueue = Promise.resolve();
  }

  async restoreSchedule() {
    if (!this.scheduleStore) return null;
    this.restorePromise ||= this.scheduleStore.read();
    this.persistedSchedule ||= await this.restorePromise;
    return this.persistedSchedule;
  }

  async persistLanSchedule() {
    if (!this.scheduleStore || !this.lanAdapter?.scheduleRaw) return;
    const snapshot = buildWt200LanSnapshot({
      deviceId: this.lanAdapter.deviceId,
      rawDps: this.lanAdapter.rawDps,
      scheduleRaw: this.lanAdapter.scheduleRaw,
      updatedAt: this.now(),
    });
    if (!snapshot.schedule) return;
    this.persistedSchedule = await this.scheduleStore.write({
      deviceId: snapshot.deviceId,
      schedule: snapshot.schedule,
      updatedAt: snapshot.updatedAt,
    });
  }

  bindLanSchedulePersistence() {
    if (this.lanEventsBound || !this.lanAdapter?.device) return;
    this.lanEventsBound = true;
    const persistAfterEvent = () => {
      this.persistenceQueue = this.persistenceQueue
        .then(() => this.persistLanSchedule())
        .catch(() => undefined);
    };
    this.lanAdapter.device.on('data', persistAfterEvent);
    this.lanAdapter.device.on('dp-refresh', persistAfterEvent);
  }

  async readLanSnapshot() {
    if (!this.lanAdapter) return null;
    await this.lanAdapter.connect();
    this.bindLanSchedulePersistence();
    const snapshot = await this.lanAdapter.read();
    if (snapshot.schedule) await this.persistLanSchedule();
    return snapshot;
  }

  async readSnapshot() {
    const persistedSchedule = await this.restoreSchedule();
    const [cloudResult, lanResult] = await Promise.allSettled([
      this.cloudAdapter ? this.cloudAdapter.read() : Promise.resolve(null),
      this.readLanSnapshot(),
    ]);
    const cloudSnapshot = cloudResult.status === 'fulfilled' ? cloudResult.value : null;
    const lanSnapshot = lanResult.status === 'fulfilled' ? lanResult.value : null;
    if (!cloudSnapshot && !lanSnapshot) {
      throw cloudResult.status === 'rejected' ? cloudResult.reason : lanResult.reason;
    }
    return mergeWt200Snapshots({ cloudSnapshot, lanSnapshot, persistedSchedule, deviceId: this.deviceId });
  }
}

export function createHomeWt200Runtime({ clientId, clientSecret, deviceId, lanIp, localKey, now }) {
  const cloudAdapter = clientId && clientSecret && deviceId
    ? new Wt200TuyaAdapter({ client: new TuyaCloudClient({ clientId, clientSecret, deviceId }), now })
    : null;
  const lanAdapter = deviceId && lanIp && localKey
    ? new Wt200TuyaLanAdapter({ deviceId, ip: lanIp, localKey, now })
    : null;
  return new HomeWt200Runtime({
    cloudAdapter,
    lanAdapter,
    scheduleStore: new Wt200ScheduleStore({ filePath: DEFAULT_SCHEDULE_FILE }),
    deviceId,
    now,
  });
}
