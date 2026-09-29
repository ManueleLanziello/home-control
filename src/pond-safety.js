import { DEVICE_FRESHNESS_MS } from '@smarthome/core';

const idFor = (assignments, role) => Object.keys(assignments).find(id => assignments[id] === role) || null;
export class PondSafetyError extends Error { constructor(message, code = 'POND_SAFETY') { super(message); this.code = code; } }
export function createPondController({ runtime, roleStore }) {
  async function assignments() { return roleStore.read(runtime.deviceList.map(device => device.id)); }
  async function set(role, on) {
    const roles = await assignments(); const id = idFor(roles, role);
    if (!id || !runtime.hasDevice(id)) throw new PondSafetyError(`Ruolo ${role} non disponibile.`, 'ROLE_UNAVAILABLE');
    if (role === 'heater' && on) {
      const pump = idFor(roles, 'pump');
      if (!pump || !runtime.hasDevice(pump) || !runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) || runtime.snapshot(pump).state !== 'ON') throw new PondSafetyError('Riscaldatore consentito solo con pompa online, fresca e ON.', 'PUMP_REQUIRED');
    }
    if (role === 'pump' && !on) {
      const heater = idFor(roles, 'heater');
      if (heater && runtime.hasDevice(heater)) return runtime.withDevices([id, heater], async managed => {
        const current = await managed.read(heater);
        if (current.state === 'ON') { const off = await managed.setDeviceOn(heater, false); if (off.state !== 'OFF') throw new PondSafetyError('Spegnimento riscaldatore non confermato.', 'HEATER_OFF_UNCONFIRMED'); }
        return managed.setDeviceOn(id, false);
      });
    }
    return runtime.setDeviceOn(id, on);
  }
  async function monitor() {
    const roles = await assignments(); const pump = idFor(roles, 'pump'); const heater = idFor(roles, 'heater');
    if (!heater || !runtime.hasDevice(heater)) return { action: 'none' };
    const unsafe = !pump || !runtime.hasDevice(pump) || !runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) || runtime.snapshot(pump).state !== 'ON';
    if (!unsafe) return { action: 'none' };
    return runtime.withDevices([heater], async managed => { const state = await managed.read(heater); return state.state === 'ON' ? { action: 'heater-off', state: await managed.setDeviceOn(heater, false) } : { action: 'none' }; });
  }
  async function heaterIsOn() {
    const roles = await assignments(); const heater = idFor(roles, 'heater');
    if (!heater || !runtime.hasDevice(heater)) return false;
    return (await runtime.read(heater)).state === 'ON';
  }
  async function protectBeforePumpLoss() {
    const roles = await assignments(); const heater = idFor(roles, 'heater');
    if (!heater || !runtime.hasDevice(heater)) return;
    return runtime.withDevices([heater], async managed => { const state = await managed.read(heater); if (state.state === 'ON') { const off = await managed.setDeviceOn(heater, false); if (off.state !== 'OFF') throw new PondSafetyError('Spegnimento riscaldatore non confermato.', 'HEATER_OFF_UNCONFIRMED'); } });
  }
  return { set, monitor, heaterIsOn, protectBeforePumpLoss };
}
