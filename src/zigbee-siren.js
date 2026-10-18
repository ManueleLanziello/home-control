const onOffOrNull = value => value === true || value === 'ON' ? true : value === false || value === 'OFF' ? false : value === null ? null : undefined;
const booleanOrNull = value => typeof value === 'boolean' || value === null ? value : undefined;
const integerOrNull = (value, minimum, maximum = Number.MAX_SAFE_INTEGER) => Number.isInteger(value) && value >= minimum && value <= maximum ? value : value === null ? null : undefined;
const enumOrNull = values => value => values.includes(value) || value === null ? value : undefined;

// The siren state topic is treated strictly as a passive telemetry source.
// MQTT updates are partial; retained packets stay historical until a live
// packet confirms the snapshot.
export function normalizeSirenPayload(payload, previous = {}, updatedAt = new Date().toISOString(), retained = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const next = { ...previous };
  let changed = false;
  for (const [source, target, normalize] of [
    ['siren_on', 'sirenOn', onOffOrNull],
    ['power_supply_mode', 'powerSupplyMode', enumOrNull(['battery', 'external'])],
    ['battery', 'battery', value => integerOrNull(value, 0, 100)],
    ['alarm_sound_enable', 'soundEnabled', onOffOrNull],
    ['alarm_light_enable', 'lightEnabled', onOffOrNull],
    ['tamper', 'tamper', booleanOrNull],
    ['alarm_sound_type', 'soundType', enumOrNull(['burglar', 'fire', 'emergency', 'police', 'panic', 'doorbell'])],
    ['alarm_volume_level', 'volumeLevel', enumOrNull(['low', 'medium', 'high', 'max'])],
    ['alarm_duration', 'duration', value => integerOrNull(value, 1, 900)],
    ['linkquality', 'linkQuality', value => integerOrNull(value, 0, 255)],
  ]) {
    if (!Object.hasOwn(payload, source)) continue;
    const value = normalize(payload[source]);
    if (value === undefined) continue;
    next[target] = value;
    changed = true;
  }
  return changed ? { ...next, updatedAt, confirmed: previous.confirmed === true || retained !== true } : null;
}
