import { DewinTuyaAdapter } from '@smarthome/core';

export const DEWIN_CAPABILITIES = Object.freeze([
  'ambientTemperature',
  'ambientHumidity',
  'externalProbeTemperature',
]);

export function isDewinTuyaDevice(device) {
  const protocol = String(device?.protocol || '').trim().toLowerCase();
  const adapter = String(device?.metadata?.adapter || '').trim().toLowerCase();
  return protocol === 'tuya-cloud' && (adapter === 'dewin' || adapter === 'dewin-tuya');
}

export function dewinCapabilitiesFromSnapshot(snapshot) {
  const measurements = snapshot?.measurements || {};
  return DEWIN_CAPABILITIES.filter((capability) => measurements[capability] !== null && measurements[capability] !== undefined);
}

export class HomeDewinRuntime {
  constructor({ device, client, adapter = null, now = () => new Date().toISOString() }) {
    if (!device || typeof device !== 'object') throw new TypeError('Dispositivo Home Dewin obbligatorio.');
    this.device = device;
    this.adapter = adapter || new DewinTuyaAdapter({ client, now });
  }

  async readSnapshot() {
    const snapshot = await this.adapter.read();
    return {
      deviceId: this.device.id,
      physicalDeviceId: snapshot.deviceId,
      alias: this.device.alias,
      online: snapshot.online,
      updatedAt: snapshot.updatedAt,
      capabilities: dewinCapabilitiesFromSnapshot(snapshot),
      measurements: snapshot.measurements,
    };
  }
}
