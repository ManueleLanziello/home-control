import { floorplanConfig } from './floorplan-config.js';

export function backgroundPeriod(now = new Date()) {
  return now.getHours() >= 7 && now.getHours() < 19 ? 'day' : 'night';
}

export function createFloorplanState() {
  const state = {
    lights: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, false])),
    sensors: { S1: null, S2: null, S3: null, S4: null, S5: null },
    sensorDetails: {},
    lightSources: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, light.localOnly ? 'simulation' : 'unavailable'])),
    cameras: {},
    boiler: { on: null, mode: null },
    hood: { online: false, power: null, fanSpeed: null, light: null, operatingStatus: null, updatedAt: null },
    ledbar: { state: null, brightness: null, online: false, available: false, updatedAt: null },
  };
  const listeners = new Set();
  const applyHood = hood => {
    if (!hood || typeof hood !== 'object') {
      state.hood.online = false;
      return;
    }
    state.hood = {
      online: hood.online === true,
      power: typeof hood.power === 'boolean' ? hood.power : state.hood.power,
      fanSpeed: Number.isInteger(hood.fanSpeed) ? hood.fanSpeed : state.hood.fanSpeed,
      light: typeof hood.light === 'string' ? hood.light : state.hood.light,
      operatingStatus: typeof hood.operatingStatus === 'string' ? hood.operatingStatus : state.hood.operatingStatus,
      updatedAt: hood.updatedAt ?? state.hood.updatedAt,
    };
  };
  const applyThermostat = thermostat => {
    const currentTemperature = thermostat?.thermostat?.currentTemperature;
    state.sensors.S3 = Number.isFinite(currentTemperature) ? currentTemperature : null;
    state.boiler = { on: thermostat?.heatingActive ?? null, mode: thermostat?.thermostat?.mode ?? null };
  };
  return {
    snapshot: () => structuredClone(state),
    setLight(id, on) {
      if (!Object.hasOwn(state.lights, id) || state.lightSources[id] !== 'simulation') return;
      state.lights[id] = on === true;
      for (const listener of listeners) listener(this.snapshot());
    },
    applyHoodSnapshot(hood) {
      applyHood(hood);
      for (const listener of listeners) listener(this.snapshot());
    },
    applyLedbarSnapshot(ledbar) {
      if (ledbar && typeof ledbar === 'object') state.ledbar = { ...state.ledbar, state: ['ON', 'OFF'].includes(ledbar.state) ? ledbar.state : state.ledbar.state, brightness: Number.isInteger(ledbar.brightness) ? ledbar.brightness : state.ledbar.brightness, online: ledbar.online === true, available: ledbar.available === true, updatedAt: ledbar.updatedAt ?? state.ledbar.updatedAt };
      for (const listener of listeners) listener(this.snapshot());
    },
    applyCameraPrivacy(id, privacy) {
      if (typeof privacy?.enabled !== 'boolean') return;
      state.cameras[id] = { ...(state.cameras[id] || {}), privacy: { available: true, enabled: privacy.enabled } };
      for (const listener of listeners) listener(this.snapshot());
    },
    applyCameraDetection(id, detection) {
      if (typeof detection?.enabled !== 'boolean') return;
      state.cameras[id] = { ...(state.cameras[id] || {}), detection: detection.enabled };
      for (const listener of listeners) listener(this.snapshot());
    },
    applyThermostatSnapshot(thermostat) {
      applyThermostat(thermostat);
      for (const listener of listeners) listener(this.snapshot());
    },
    applyHomeSnapshot(home = {}) {
      state.sensorDetails = Object.fromEntries(['S1', 'S2', 'S4'].map(id => [id, structuredClone(home.sensors?.[id] ?? {})]));
      for (const id of Object.keys(state.sensors)) state.sensors[id] = home.sensors?.[id]?.available === true && Number.isFinite(home.sensors[id].value) ? home.sensors[id].value : null;
      for (const id of Object.keys(state.lights)) {
        const light = home.lights?.[id];
        if (!light && state.lightSources[id] === 'simulation') continue;
        state.lightSources[id] = light?.source === 'simulation' ? 'simulation' : light?.available === true ? 'hardware' : 'unavailable';
        if (state.lightSources[id] === 'simulation' && state.lights[id] === null) state.lights[id] = false;
        if (state.lightSources[id] !== 'simulation') state.lights[id] = light?.available === true && typeof light.state === 'boolean' ? light.state : null;
      }
      state.cameras = Object.fromEntries(Object.entries(home.cameras || {}).map(([id, camera]) => {
        const previousEnabled = state.cameras[id]?.privacy?.enabled;
        const nextEnabled = camera?.privacy?.enabled;
        const previousDetection = state.cameras[id]?.detection;
        const nextDetection = camera?.detection;
        const nextCamera = { ...camera };
        if (typeof previousEnabled === 'boolean' && typeof nextEnabled !== 'boolean') {
          nextCamera.privacy = { ...camera?.privacy, available: true, enabled: previousEnabled };
        }
        if (typeof previousDetection === 'boolean' && typeof nextDetection !== 'boolean') nextCamera.detection = previousDetection;
        return [id, nextCamera];
      }));
      applyThermostat(home.thermostat);
      applyHood(home.hood);
      if (home.ledbar) state.ledbar = { ...state.ledbar, ...home.ledbar };
      for (const listener of listeners) listener(this.snapshot());
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
