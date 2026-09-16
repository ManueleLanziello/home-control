import { floorplanConfig } from './floorplan-config.js';

export function backgroundPeriod(now = new Date()) {
  return now.getHours() >= 7 && now.getHours() < 19 ? 'day' : 'night';
}

export function createFloorplanState() {
  const state = {
    lights: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, false])),
    sensors: { S1: null, S2: null, S3: null, S4: null, S5: null },
    sensorDetails: {},
    lightSources: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, 'unavailable'])),
    cameras: {},
    boiler: { on: null, mode: null },
    hood: { online: false, power: null, fanSpeed: null, light: null, operatingStatus: null, updatedAt: null },
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
      state.cameras = home.cameras || {};
      applyThermostat(home.thermostat);
      applyHood(home.hood);
      for (const listener of listeners) listener(this.snapshot());
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
