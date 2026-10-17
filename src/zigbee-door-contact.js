const boolean = value => typeof value === 'boolean' ? value : null;
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= minimum && value <= maximum ? value : null;

export function normalizeDoorContactPayload(payload, previous = {}, updatedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const next = { ...previous };
  let changed = false;
  for (const [field, value] of [
    ['contact', boolean(payload.contact)], ['tamper', boolean(payload.tamper)], ['batteryLow', boolean(payload.battery_low)],
    ['battery', integer(payload.battery, 0, 100)], ['voltage', integer(payload.voltage, 0)], ['linkQuality', integer(payload.linkquality, 0, 255)],
  ]) {
    if (value === null) continue;
    next[field] = value;
    changed = true;
  }
  return changed ? { ...next, updatedAt } : null;
}

export function normalizeZigbeeDeviceIdentity(device) {
  const ieeeAddress = typeof device?.ieee_address === 'string' && /^0x[0-9a-f]{16}$/i.test(device.ieee_address) ? device.ieee_address.toLowerCase() : null;
  if (!ieeeAddress) return null;
  return {
    ieeeAddress,
    model: typeof device.definition?.model === 'string' ? device.definition.model : null,
    manufacturer: typeof device.definition?.vendor === 'string' ? device.definition.vendor : null,
  };
}
