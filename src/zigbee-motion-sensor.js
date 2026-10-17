const booleanOrNull = value => typeof value === 'boolean' || value === null ? value : undefined;
const integer = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
const primitiveOrNull = value => value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;

// MQTT messages are partial: only an explicitly supplied field changes.  A
// supplied null remains meaningful and represents an unknown device state.
export function normalizeMotionSensorPayload(payload, previous = {}, updatedAt = new Date().toISOString(), retained = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const next = { ...previous };
  let changed = false;
  for (const [source, target, normalize] of [
    ['occupancy', 'occupancy', booleanOrNull], ['motion_timeout', 'motionTimeout', integer],
    ['illumination', 'illumination', primitiveOrNull], ['battery', 'battery', value => integer(value, 0, 100)],
    ['voltage', 'voltage', value => integer(value, 0)], ['linkquality', 'linkQuality', value => integer(value, 0, 255)],
  ]) {
    if (!Object.hasOwn(payload, source)) continue;
    const value = normalize(payload[source]);
    if (value === undefined) continue;
    next[target] = value;
    changed = true;
  }
  if (!changed) return null;
  return { ...next, updatedAt, confirmed: previous.confirmed === true || retained !== true };
}
