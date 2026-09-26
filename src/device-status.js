import { DEWIN_REFRESH_INTERVAL_MS } from './dewin-runtime.js';

export const DEVICE_STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
  DISABLED: 'disabled',
  NOT_CONFIGURED: 'not_configured',
});

const ZIGBEE_MARKERS = Object.freeze({ D15: 'S1', D16: 'S2', D17: 'S4' });

const isFresh = (updatedAt, now, maxAgeMs) => {
  const age = now - Date.parse(updatedAt);
  return Number.isFinite(age) && age >= -5_000 && age <= maxAgeMs;
};

function sourceOnline(marker, sources, now) {
  if (marker === 'D6') return sources.selfOnline === true;
  if (marker === 'D9') return sources.ledbar?.online === true && sources.ledbar?.available === true;
  if (marker === 'D10') return sources.hood?.online === true;
  if (marker === 'D11') return sources.cameras?.C1?.online === true && sources.cameras.C1?.available === true;
  if (marker === 'D12') return sources.cameras?.C2?.online === true && sources.cameras.C2?.available === true;
  if (marker === 'D14') return sources.thermostat?.online === true;
  if (ZIGBEE_MARKERS[marker]) {
    const sensor = sources.zigbee?.[ZIGBEE_MARKERS[marker]];
    return sensor?.online === true && sensor?.available === true;
  }
  if (marker === 'D18') return sources.dewin?.online === true && isFresh(sources.dewin.updatedAt, now, DEWIN_REFRESH_INTERVAL_MS);
  return false;
}

// Inventory is the sole authority for whether a marker participates in monitoring.
export function normalizeDeviceStatuses(inventory = [], sources = {}, now = Date.now()) {
  return Object.fromEntries(inventory.map(item => {
    const presenceEnabled = item?.presenceEnabled === true;
    const cameraRole = item.marker === 'D11' ? 'C1' : item.marker === 'D12' ? 'C2' : null;
    const cameraUnknown = cameraRole && sources.cameras?.[cameraRole]?.online == null;
    const status = !presenceEnabled
      ? item?.status === 'future' ? DEVICE_STATUS.NOT_CONFIGURED : DEVICE_STATUS.DISABLED
      : cameraUnknown ? DEVICE_STATUS.UNKNOWN
      : sourceOnline(item.marker, sources, now) ? DEVICE_STATUS.ONLINE : DEVICE_STATUS.OFFLINE;
    return [item.marker, { id: item.marker, presenceEnabled, status }];
  }));
}
