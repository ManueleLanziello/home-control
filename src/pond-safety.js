import { DEVICE_FRESHNESS_MS } from '@smarthome/core';

const idFor = (assignments, role) => Object.keys(assignments).find(id => assignments[id] === role) || null;
export class PondSafetyError extends Error { constructor(message, code = 'POND_SAFETY') { super(message); this.code = code; } }
export function createPondController({ runtime, roleStore, log = event => console.warn('[pond-safety]', JSON.stringify(event)), now = Date.now }) {
  let lastDiagnostic = null;
  function diagnostic(event) {
    const key = JSON.stringify(event);
    if (key !== lastDiagnostic) { lastDiagnostic = key; try { log(event); } catch { /* Logging must never block safety. */ } }
  }
  function pumpStatus(pump) {
    try {
    if (!pump || !runtime.hasDevice(pump)) return { reason: 'PUMP_UNAVAILABLE' };
    const state = runtime.snapshot(pump);
    const readAt = Date.parse(state.lastReadAt);
    const ageMs = Number.isFinite(readAt) ? Math.max(0, now() - readAt) : null;
    const reason = state.state === 'OFF' && runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) ? 'PUMP_OFF'
      : !state.online || state.communicationDegraded || state.consecutiveFailures > 0 ? 'PUMP_UNRELIABLE'
      : !runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) ? 'PUMP_STALE'
      : state.state !== 'ON' ? 'PUMP_UNKNOWN' : null;
    return { reason, state: state.state ?? null, online: !!state.online, degraded: !!state.communicationDegraded, failures: state.consecutiveFailures ?? null, ageMs };
    } catch { return { reason: 'DIAGNOSTIC_UNAVAILABLE' }; }
  }
  async function assignments() { return roleStore.read(runtime.deviceList.map(device => device.id)); }
  async function set(role, on) {
    const roles = await assignments(); const id = idFor(roles, role);
    if (!id || !runtime.hasDevice(id)) throw new PondSafetyError(`Ruolo ${role} non disponibile.`, 'ROLE_UNAVAILABLE');
    if (role === 'heater' && on) {
      const pump = idFor(roles, 'pump');
      if (!pump || !runtime.hasDevice(pump) || !runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) || runtime.snapshot(pump).state !== 'ON') { diagnostic({ action: 'heater-on-blocked', ...pumpStatus(pump) }); throw new PondSafetyError('Riscaldatore consentito solo con pompa online, fresca e ON.', 'PUMP_REQUIRED'); }
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
    try {
      const roles = await assignments(); const pump = idFor(roles, 'pump'); const heater = idFor(roles, 'heater');
      if (!heater || !runtime.hasDevice(heater)) return { action: 'none' };
      const unsafe = !pump || !runtime.hasDevice(pump) || !runtime.isFreshAndReliable(pump, DEVICE_FRESHNESS_MS) || runtime.snapshot(pump).state !== 'ON';
      if (!unsafe) { lastDiagnostic = null; return { action: 'none' }; }
      const pumpDiagnostic = pumpStatus(pump);
      return await runtime.withDevices([heater], async managed => { const state = await managed.read(heater); if (state.state !== 'ON') return { action: 'none' }; diagnostic({ action: 'interlock-heater-off', ...pumpDiagnostic }); return { action: 'heater-off', state: await managed.setDeviceOn(heater, false) }; });
    } catch (error) {
      diagnostic({ action: 'interlock-operation-failed', code: error?.code === 'DEVICE_BACKOFF' ? 'DEVICE_BACKOFF' : 'SAFETY_READ_FAILED' });
      // A failed safety read (including Core backoff) leaves state unreliable; the next poll retries within Core policy.
      return { action: 'none', reason: error?.code || 'SAFETY_READ_FAILED' };
    }
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
