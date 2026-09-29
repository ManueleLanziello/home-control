import { DeviceManager, TpapClient } from '@smarthome/core';

export const POND_PLUG_ADAPTER = 'tapo-p105';
export function isPondPlug(device) { return device?.metadata?.adapter === POND_PLUG_ADAPTER; }
export function runtimeDevice(device) {
  return { id: device.id, fallbackName: device.alias, model: device.model, ip: device.connection?.ip,
    type: 'SMART.TAPOPLUG', protocol: 'tpap', protocolLabel: 'TPAP/SPAKE2+', adapter: POND_PLUG_ADAPTER };
}
export function createPondPlugRuntime({ devices = [], createClient = options => new TpapClient(options), ...options } = {}) {
  return new DeviceManager({ deviceList: devices.filter(isPondPlug).filter(device => device.verificationStatus === 'verified').map(runtimeDevice), createClient, ...options });
}
