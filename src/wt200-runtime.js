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

function latestObservation(value, updatedAt, previous = null, valid = () => true) {
  if (!valid(value)) return previous;
  const candidate = { value, updatedAt };
  const candidateTime = Date.parse(updatedAt);
  const previousTime = Date.parse(previous?.updatedAt);
  return Number.isFinite(candidateTime) && Number.isFinite(previousTime) && candidateTime < previousTime
    ? previous
    : candidate;
}

const latestMeasurement = (value, updatedAt, previous = null) => latestObservation(value, updatedAt, previous, Number.isFinite);
const latestMode = (value, updatedAt, previous = null) => latestObservation(value, updatedAt, previous, item => typeof item === 'string');
const latestHeating = (value, updatedAt, previous = null) => latestObservation(value, updatedAt, previous, item => typeof item === 'boolean');

function isConfirmedDeviceSchedule(snapshot) {
  const schedule = snapshot?.schedule;
  return Boolean(
    schedule
    && ['5+2', '6+1', '7'].includes(schedule.weekPattern)
    && typeof schedule.raw === 'string'
    && schedule.raw.length > 0
    && snapshot?.rawDps?.['105'] === schedule.raw
    && ['1', '2', '3'].includes(String(snapshot?.rawDps?.['107']))
  );
}

export function mergeWt200Snapshots({ cloudSnapshot = null, lanSnapshot = null, persistedSchedule = null, deviceId = null, lanOnline = lanSnapshot !== null, lastTemperatureMeasurement = null, lastSetpointMeasurement = null, lastModeObservation = null, lastHeatingObservation = null }) {
  const cloud = cloudSnapshot || unavailableCloudSnapshot(deviceId);
  const deviceSchedule = isConfirmedDeviceSchedule(lanSnapshot) ? lanSnapshot.schedule : null;
  const fallbackSchedule = persistedSchedule?.schedule || null;
  const lanTemperature = lanSnapshot?.thermostat?.currentTemperature;
  const measuredTemperature = latestMeasurement(lanTemperature, lanSnapshot?.temperatureUpdatedAt ?? lanSnapshot?.updatedAt ?? null, lastTemperatureMeasurement);
  const lanSetpoint = lanSnapshot?.thermostat?.setpointTemperature;
  const measuredSetpoint = latestMeasurement(lanSetpoint, lanSnapshot?.setpointUpdatedAt ?? lanSnapshot?.updatedAt ?? null, lastSetpointMeasurement);
  const observedMode = latestMode(lanSnapshot?.thermostat?.mode, lanSnapshot?.modeUpdatedAt ?? lanSnapshot?.updatedAt ?? null, lastModeObservation);
  const observedHeating = latestHeating(lanSnapshot?.heatingActive, lanSnapshot?.heatingUpdatedAt ?? lanSnapshot?.updatedAt ?? null, lastHeatingObservation);
  return {
    ...cloud,
    deviceId: cloud.deviceId ?? lanSnapshot?.deviceId ?? deviceId,
    online: lanOnline || cloud.online === true,
    cloudUpdatedAt: cloud.online === true ? cloud.updatedAt : null,
    lanUpdatedAt: lanSnapshot?.updatedAt ?? null,
    thermostat: {
      ...(lanSnapshot?.thermostat ?? cloudSnapshot?.thermostat ?? cloud.thermostat),
      ...(Number.isFinite(measuredTemperature?.value) ? { currentTemperature: measuredTemperature.value } : {}),
      ...(Number.isFinite(measuredSetpoint?.value) ? { setpointTemperature: measuredSetpoint.value } : {}),
      ...(typeof observedMode?.value === 'string' ? { mode: observedMode.value } : {}),
    },
    temperatureUpdatedAt: measuredTemperature?.updatedAt ?? null,
    setpointUpdatedAt: measuredSetpoint?.updatedAt ?? null,
    modeUpdatedAt: observedMode?.updatedAt ?? null,
    heatingUpdatedAt: lanOnline ? observedHeating?.updatedAt ?? null : null,
    scheduleSource: deviceSchedule ? 'device' : fallbackSchedule ? 'persisted' : null,
    scheduleAvailability: lanOnline && deviceSchedule ? 'confirmed' : fallbackSchedule ? 'fallback' : 'unavailable',
    heatingActive: lanOnline && typeof observedHeating?.value === 'boolean' ? observedHeating.value : null,
    datapointUpdatedAt: lanSnapshot?.datapointUpdatedAt ?? null,
    rawDps: lanSnapshot?.rawDps ?? null,
    schedule: deviceSchedule || fallbackSchedule,
    updatedAt: cloud.updatedAt ?? lanSnapshot?.updatedAt ?? persistedSchedule?.updatedAt ?? null,
  };
}

export class HomeWt200Runtime {
  constructor({
    lanAdapter = null,
    scheduleStore = null,
    deviceId = null,
    now = () => new Date().toISOString(),
    postWriteReadbackAttempts = 7,
    postWriteReadbackDelayMs = 500,
    wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  }) {
    this.lanAdapter = lanAdapter;
    this.scheduleStore = scheduleStore;
    this.deviceId = deviceId;
    this.now = now;
    this.postWriteReadbackAttempts = postWriteReadbackAttempts;
    this.postWriteReadbackDelayMs = postWriteReadbackDelayMs;
    this.wait = wait;
    this.persistedSchedule = null;
    this.modeOverride = null;
    this.setpointOverride = null;
    this.restorePromise = null;
    this.lanEventDevice = null;
    this.stateListeners = new Set();
    this.latestLanSnapshot = null;
    this.latestTemperatureMeasurement = null;
    this.latestSetpointMeasurement = null;
    this.latestModeObservation = null;
    this.latestHeatingObservation = null;
    this.persistenceQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
    this.lanAdapter?.subscribeState?.((snapshot, metadata) => this.publishLanState(snapshot, metadata));
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
      datapointUpdatedAt: this.lanAdapter.datapointUpdatedAt,
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

  async readLanSnapshot(options) {
    if (!this.lanAdapter) return null;
    const snapshot = await this.lanAdapter.read(options);
    this.latestLanSnapshot = snapshot;
    this.rememberTemperatureMeasurement(snapshot);
    this.rememberSetpointMeasurement(snapshot);
    this.rememberModeObservation(snapshot);
    this.rememberHeatingObservation(snapshot);
    this.bindLanSchedulePersistence();
    if (snapshot.schedule) await this.persistLanSchedule();
    return snapshot;
  }

  subscribeState(listener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  publishLanState(lanSnapshot, metadata = {}) {
    this.latestLanSnapshot = lanSnapshot;
    this.rememberTemperatureMeasurement(lanSnapshot);
    this.rememberSetpointMeasurement(lanSnapshot);
    this.rememberModeObservation(lanSnapshot);
    this.rememberHeatingObservation(lanSnapshot);
    const snapshot = mergeWt200Snapshots({
      lanSnapshot,
      persistedSchedule: this.persistedSchedule,
      deviceId: this.deviceId,
      lastTemperatureMeasurement: this.latestTemperatureMeasurement,
      lastSetpointMeasurement: this.latestSetpointMeasurement,
      lastModeObservation: this.latestModeObservation,
      lastHeatingObservation: this.latestHeatingObservation,
    });
    for (const listener of this.stateListeners) {
      try { listener(snapshot, metadata); } catch { /* A UI subscriber must not break LAN state capture. */ }
    }
  }

  rememberTemperatureMeasurement(snapshot) {
    const value = snapshot?.thermostat?.currentTemperature;
    if (!Number.isFinite(value)) return;
    this.latestTemperatureMeasurement = latestMeasurement(value, snapshot.temperatureUpdatedAt ?? snapshot.updatedAt ?? this.now(), this.latestTemperatureMeasurement);
  }

  rememberSetpointMeasurement(snapshot) {
    const value = snapshot?.thermostat?.setpointTemperature;
    if (!Number.isFinite(value)) return;
    this.latestSetpointMeasurement = latestMeasurement(value, snapshot.setpointUpdatedAt ?? snapshot.updatedAt ?? this.now(), this.latestSetpointMeasurement);
  }

  rememberModeObservation(snapshot) {
    this.latestModeObservation = latestMode(snapshot?.thermostat?.mode, snapshot?.modeUpdatedAt ?? snapshot?.updatedAt ?? this.now(), this.latestModeObservation);
  }

  rememberHeatingObservation(snapshot) {
    this.latestHeatingObservation = latestHeating(snapshot?.heatingActive, snapshot?.heatingUpdatedAt ?? snapshot?.updatedAt ?? this.now(), this.latestHeatingObservation);
  }

  async readSnapshot() {
    const persistedSchedule = await this.restoreSchedule();
    const [lanResult] = await Promise.allSettled([this.readLanSnapshot()]);
    const lanSnapshot = lanResult.status === 'fulfilled' ? lanResult.value : null;
    if (!lanSnapshot) {
      // A failed LAN read makes the device unavailable, but does not erase a
      // separately timestamped measurement before its normal freshness limit.
      return mergeWt200Snapshots({ persistedSchedule, deviceId: this.deviceId, lanOnline: false, lastTemperatureMeasurement: this.latestTemperatureMeasurement, lastSetpointMeasurement: this.latestSetpointMeasurement, lastModeObservation: this.latestModeObservation, lastHeatingObservation: this.latestHeatingObservation });
    }
    const merged = mergeWt200Snapshots({ lanSnapshot, persistedSchedule, deviceId: this.deviceId, lastTemperatureMeasurement: this.latestTemperatureMeasurement, lastSetpointMeasurement: this.latestSetpointMeasurement, lastModeObservation: this.latestModeObservation, lastHeatingObservation: this.latestHeatingObservation });
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

  async confirmScheduleWrite(expectedSchedule) {
    let readback;
    try {
      readback = await this.readLanSnapshot({ requiredDps: [105, 107] });
    } catch {
      const error = new Error('Il WT200 non ha confermato la programmazione richiesta.');
      error.code = 'SCHEDULE_NOT_CONFIRMED';
      throw error;
    }
    if (!isConfirmedDeviceSchedule(readback)
      || readback.schedule.raw !== expectedSchedule?.raw
      || readback.schedule.weekPattern !== expectedSchedule?.weekPattern) {
      const error = new Error('Il WT200 non ha confermato la programmazione richiesta.');
      error.code = 'SCHEDULE_NOT_CONFIRMED';
      throw error;
    }
    await this.persistScheduleSnapshot(readback);
    return readback.schedule;
  }

  async updateSchedule({ weekPattern = null, normalPeriods, restDayPeriods }) {
    const writer = this.lanAdapter;
    if (!writer?.writeSchedule) {
      const error = new Error('Connessione WT200 non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    const confirmed = await this.readSnapshot();
    if (confirmed.scheduleAvailability !== 'confirmed' || confirmed.scheduleSource !== 'device') {
      const error = new Error('Programmazione WT200 non disponibile o non confermata.');
      error.code = 'SCHEDULE_UNAVAILABLE';
      throw error;
    }
    const raw = confirmed.schedule.raw;
    let snapshot;
    try {
      snapshot = await writer.writeSchedule({
        weekPattern: weekPattern || confirmed.schedule.weekPattern,
        normalPeriods,
        ...(restDayPeriods ? { restDayPeriods } : {}),
        raw,
      });
    } catch (error) {
      if (error instanceof TypeError) error.code = 'SCHEDULE_INVALID';
      throw error;
    }
    this.bindLanSchedulePersistence();
    return this.confirmScheduleWrite(snapshot.schedule);
  }

  async setWeekPattern(weekPattern) {
    const writer = this.lanAdapter;
    if (!writer?.setWeekPattern) {
      const error = new Error('Connessione WT200 non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    const confirmed = await this.readSnapshot();
    if (confirmed.scheduleAvailability !== 'confirmed' || confirmed.scheduleSource !== 'device') {
      const error = new Error('Programmazione WT200 non disponibile o non confermata.');
      error.code = 'SCHEDULE_UNAVAILABLE';
      throw error;
    }
    let snapshot;
    try {
      snapshot = await writer.setWeekPattern(weekPattern);
    } catch (error) {
      if (error instanceof TypeError) error.code = 'WEEK_PATTERN_INVALID';
      throw error;
    }
    return this.confirmScheduleWrite(snapshot.schedule);
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
    return this.runMutation(async () => {
      try {
        await this.lanAdapter.setOperatingMode(nativeMode);
      } catch (error) {
        if (error instanceof TypeError) error.code = 'MODE_INVALID';
        throw error;
      }
      this.bindLanSchedulePersistence();
      return this.confirmPostWriteState({
        targetKey: 'mode',
        targetValue: mode,
        code: 'MODE_NOT_CONFIRMED',
        message: 'Il WT200 non ha confermato la modalita richiesta.',
      });
    });
  }

  async runMutation(operation) {
    const previousMutation = this.mutationQueue;
    let releaseMutation;
    this.mutationQueue = new Promise(resolve => { releaseMutation = resolve; });
    await previousMutation;
    try {
      return await operation();
    } finally {
      releaseMutation();
    }
  }

  async confirmPostWriteState({ targetKey, targetValue, code, message }) {
    let lastSnapshot = null;
    let stableReadCount = 0;
    let lastError = null;
    for (let attempt = 0; attempt < this.postWriteReadbackAttempts; attempt += 1) {
      if (attempt > 0) await this.wait(this.postWriteReadbackDelayMs);
      try {
        const lanSnapshot = await this.readLanSnapshot({ requiredDps: [2, 3, 4, 5] });
        const state = {
          setpointTemperature: lanSnapshot?.thermostat?.setpointTemperature,
          currentTemperature: lanSnapshot?.thermostat?.currentTemperature,
          mode: lanSnapshot?.thermostat?.mode,
          heatingActive: lanSnapshot?.heatingActive,
        };
        lastSnapshot = mergeWt200Snapshots({ lanSnapshot, persistedSchedule: await this.restoreSchedule(), deviceId: this.deviceId });
        const complete = state[targetKey] === targetValue
          && Number.isFinite(state.currentTemperature)
          && typeof state.mode === 'string'
          && typeof state.heatingActive === 'boolean';
        stableReadCount = complete ? stableReadCount + 1 : 0;
        if (stableReadCount >= 3) return lastSnapshot;
      } catch (error) {
        lastError = error;
      }
    }
    if (!lastSnapshot && lastError) throw lastError;
    const error = new Error(message);
    error.code = code;
    error.snapshot = lastSnapshot;
    throw error;
  }

  async setSetpointTemperature(temperature) {
    if (!this.lanAdapter) { const error = new Error('Connessione LAN WT200 non disponibile.'); error.code = 'LAN_UNAVAILABLE'; throw error; }
    return this.runMutation(async () => {
      try { await this.lanAdapter.setSetpointTemperature(temperature); } catch (error) { if (error instanceof TypeError) error.code = 'SETPOINT_INVALID'; throw error; }
      return this.confirmPostWriteState({
        targetKey: 'setpointTemperature',
        targetValue: temperature,
        code: 'SETPOINT_NOT_CONFIRMED',
        message: 'Il WT200 non ha confermato il setpoint richiesto.',
      });
    });
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
