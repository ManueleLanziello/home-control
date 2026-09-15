import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Wt200TuyaLanAdapter,
  buildWt200LanSnapshot,
} from '@smarthome/core';
import { Wt200ScheduleStore } from './wt200-schedule-store.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEDULE_FILE = path.join(ROOT, '..', 'data', 'wt200-schedule.json');
const FALLBACK_SCHEDULE_FILE = path.join(ROOT, '..', 'config', 'wt200-schedule.json');

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
  const deviceSchedule = cloudSnapshot?.schedule || lanSnapshot?.schedule || null;
  return {
    ...cloud,
    deviceId: cloud.deviceId ?? lanSnapshot?.deviceId ?? deviceId,
    online: lanSnapshot !== null || cloud.online === true,
    cloudUpdatedAt: cloud.online === true ? cloud.updatedAt : null,
    lanUpdatedAt: lanSnapshot?.updatedAt ?? null,
    thermostat: lanSnapshot?.thermostat ?? cloudSnapshot?.thermostat ?? cloud.thermostat,
    scheduleSource: deviceSchedule ? 'device' : persistedSchedule?.schedule ? 'persisted' : null,
    heatingActive: lanSnapshot?.heatingActive ?? null,
    rawDps: lanSnapshot?.rawDps ?? null,
    schedule: deviceSchedule || persistedSchedule?.schedule || null,
    updatedAt: cloud.updatedAt ?? lanSnapshot?.updatedAt ?? persistedSchedule?.updatedAt ?? null,
  };
}

export class HomeWt200Runtime {
  constructor({
    lanAdapter = null,
    scheduleStore = null,
    deviceId = null,
    now = () => new Date().toISOString(),
    setpointReadbackAttempts = 4,
    setpointReadbackDelayMs = 400,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  }) {
    this.lanAdapter = lanAdapter;
    this.scheduleStore = scheduleStore;
    this.deviceId = deviceId;
    this.now = now;
    this.setpointReadbackAttempts = setpointReadbackAttempts;
    this.setpointReadbackDelayMs = setpointReadbackDelayMs;
    this.wait = wait;
    this.persistedSchedule = null;
    this.modeOverride = null;
    this.setpointOverride = null;
    this.restorePromise = null;
    this.lanEventDevice = null;
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
    if (!this.lanAdapter?.device || this.lanEventDevice === this.lanAdapter.device) return;
    this.lanEventDevice = this.lanAdapter.device;
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
    const snapshot = await this.lanAdapter.read();
    this.bindLanSchedulePersistence();
    if (snapshot.schedule) await this.persistLanSchedule();
    return snapshot;
  }

  async readSnapshot() {
    const persistedSchedule = await this.restoreSchedule();
    const [lanResult] = await Promise.allSettled([this.readLanSnapshot()]);
    const lanSnapshot = lanResult.status === 'fulfilled' ? lanResult.value : null;
    if (!lanSnapshot) {
      return mergeWt200Snapshots({ persistedSchedule, deviceId: this.deviceId });
    }
    const merged = mergeWt200Snapshots({ lanSnapshot, persistedSchedule, deviceId: this.deviceId });
    if (merged.scheduleSource === 'device'
      && (merged.schedule?.raw !== persistedSchedule?.schedule?.raw
        || merged.schedule?.weekPattern !== persistedSchedule?.schedule?.weekPattern)) {
      await this.persistScheduleSnapshot(merged);
    }
    // A read reports device state, not an indefinitely retained command override.
    return merged;
  }

  async persistScheduleSnapshot(snapshot) {
    if (!snapshot?.schedule || !this.scheduleStore) return;
    this.persistedSchedule = await this.scheduleStore.write({
      deviceId: snapshot.deviceId || this.deviceId,
      schedule: snapshot.schedule,
      updatedAt: snapshot.updatedAt || this.now(),
    });
  }

  async updateSchedule({ weekPattern = null, normalPeriods, restDayPeriods }) {
    const writer = this.lanAdapter;
    if (!writer?.writeSchedule) {
      const error = new Error('Connessione WT200 non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    const persisted = await this.restoreSchedule();
    const raw = this.lanAdapter?.scheduleRaw || persisted?.schedule?.raw;
    if (!raw && writer === this.lanAdapter) {
      const error = new Error('Programmazione originale WT200 non disponibile.');
      error.code = 'SCHEDULE_UNAVAILABLE';
      throw error;
    }
    let snapshot;
    try {
      snapshot = await writer.writeSchedule({
        weekPattern: weekPattern || persisted?.schedule?.weekPattern,
        normalPeriods,
        ...(restDayPeriods ? { restDayPeriods } : {}),
        raw,
      });
    } catch (error) {
      if (error instanceof TypeError) error.code = 'SCHEDULE_INVALID';
      throw error;
    }
    this.bindLanSchedulePersistence();
    await this.persistScheduleSnapshot(snapshot);
    return snapshot.schedule;
  }

  async setWeekPattern(weekPattern) {
    const writer = this.lanAdapter;
    if (!writer?.setWeekPattern) {
      const error = new Error('Connessione WT200 non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    let snapshot;
    try {
      snapshot = await writer.setWeekPattern(weekPattern);
    } catch (error) {
      if (error instanceof TypeError) error.code = 'WEEK_PATTERN_INVALID';
      throw error;
    }
    await this.persistScheduleSnapshot(snapshot);
    return snapshot.schedule;
  }

  async setMode(mode) {
    const nativeMode = ({ manual: 'home', auto: 'auto' })[mode];
    if (!nativeMode) {
      const error = new Error('Modalita non valida.');
      error.code = 'MODE_INVALID';
      throw error;
    }
    if (!this.lanAdapter) {
      const error = new Error('Connessione LAN WT200 non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    try {
      await this.lanAdapter.setOperatingMode(nativeMode);
    } catch (error) {
      if (error instanceof TypeError) error.code = 'MODE_INVALID';
      throw error;
    }
    this.modeOverride = mode;
    this.bindLanSchedulePersistence();
    return mode;
  }

  async setSetpointTemperature(temperature) {
    if (!this.lanAdapter) { const error = new Error('Connessione LAN WT200 non disponibile.'); error.code = 'LAN_UNAVAILABLE'; throw error; }
    let writeReadback;
    try { writeReadback = await this.lanAdapter.setSetpointTemperature(temperature); } catch (error) { if (error instanceof TypeError) error.code = 'SETPOINT_INVALID'; throw error; }
    let lastSnapshot = null;
    let lastCompleteSnapshot = null;
    let previousState = null;
    let stableReadCount = 0;
    let lastError = null;
    for (let attempt = 0; attempt < this.setpointReadbackAttempts; attempt += 1) {
      if (attempt > 0) await this.wait(this.setpointReadbackDelayMs);
      try {
        const lanSnapshot = attempt === 0 && writeReadback ? writeReadback : await this.readLanSnapshot();
        if (attempt === 0 && writeReadback) {
          this.bindLanSchedulePersistence();
          if (lanSnapshot.schedule) await this.persistLanSchedule();
        }
        const state = {
          setpointTemperature: lanSnapshot?.thermostat?.setpointTemperature,
          currentTemperature: lanSnapshot?.thermostat?.currentTemperature,
          mode: lanSnapshot?.thermostat?.mode,
          heatingActive: lanSnapshot?.heatingActive,
        };
        lastSnapshot = mergeWt200Snapshots({ lanSnapshot, persistedSchedule: await this.restoreSchedule(), deviceId: this.deviceId });
        const complete = state.setpointTemperature === temperature
          && Number.isFinite(state.currentTemperature)
          && typeof state.mode === 'string'
          && typeof state.heatingActive === 'boolean';
        if (complete) lastCompleteSnapshot = lastSnapshot;
        const matchesPrevious = complete && previousState
          && previousState.setpointTemperature === state.setpointTemperature
          && previousState.currentTemperature === state.currentTemperature
          && previousState.mode === state.mode
          && previousState.heatingActive === state.heatingActive;
        stableReadCount = complete ? (matchesPrevious ? stableReadCount + 1 : 1) : 0;
        if (stableReadCount >= 3) return lastSnapshot;
        previousState = complete ? state : null;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastCompleteSnapshot) return lastCompleteSnapshot;
    if (!lastSnapshot && lastError) throw lastError;
    const error = new Error('Il WT200 non ha confermato il setpoint richiesto.');
    error.code = 'SETPOINT_NOT_CONFIRMED';
    error.snapshot = lastSnapshot;
    throw error;
  }
}

export function createHomeWt200Runtime({ deviceId, lanIp, localKey, now }) {
  const lanAdapter = deviceId && lanIp && localKey
    ? new Wt200TuyaLanAdapter({ deviceId, ip: lanIp, localKey, now })
    : null;
  return new HomeWt200Runtime({
    lanAdapter,
    scheduleStore: new Wt200ScheduleStore({ filePath: DEFAULT_SCHEDULE_FILE, fallbackFilePath: FALLBACK_SCHEDULE_FILE }),
    deviceId,
    now,
  });
}
