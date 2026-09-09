import { floorplanConfig } from './floorplan-config.js';

export function backgroundPeriod(now = new Date()) {
  return now.getHours() >= 7 && now.getHours() < 19 ? 'day' : 'night';
}

export function createFloorplanState() {
  const state = {
    lights: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, false])),
    sensors: { S1: null, S2: null, S3: null, S4: null, S5: null },
    lightSources: Object.fromEntries(floorplanConfig.lights.map(light => [light.id, 'unavailable'])),
    cameras: {},
    boiler: { on: null, mode: null },
  };
  const listeners = new Set();
  return {
    snapshot: () => structuredClone(state),
    setLight(id, on) {
      if (!Object.hasOwn(state.lights, id) || state.lightSources[id] !== 'simulation') return;
      state.lights[id] = on === true;
      for (const listener of listeners) listener(this.snapshot());
    },
    applyHomeSnapshot(home = {}) {
      for (const id of Object.keys(state.sensors)) state.sensors[id] = home.sensors?.[id]?.available === true && Number.isFinite(home.sensors[id].value) ? home.sensors[id].value : null;
      for (const id of Object.keys(state.lights)) {
        const light = home.lights?.[id];
        if (!light && state.lightSources[id] === 'simulation') continue;
        state.lightSources[id] = light?.source === 'simulation' ? 'simulation' : light?.available === true ? 'hardware' : 'unavailable';
        if (state.lightSources[id] === 'simulation' && state.lights[id] === null) state.lights[id] = false;
        if (state.lightSources[id] !== 'simulation') state.lights[id] = light?.available === true && typeof light.state === 'boolean' ? light.state : null;
      }
      state.cameras = home.cameras || {};
      state.boiler = { on: home.thermostat?.heatingActive ?? null, mode: home.thermostat?.thermostat?.mode ?? null };
      for (const listener of listeners) listener(this.snapshot());
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
