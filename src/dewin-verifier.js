import { DewinTuyaAdapter, TuyaCloudClient } from '@smarthome/core';

export async function verifyDewinSensor(device, {
  client = new TuyaCloudClient({
    clientId: process.env.TUYA_CLIENT_ID,
    clientSecret: process.env.TUYA_CLIENT_SECRET,
    deviceId: device.identity?.tuyaDeviceId,
  }),
  now = () => new Date().toISOString(),
} = {}) {
  const snapshot = await new DewinTuyaAdapter({ client, now }).read();
  if (snapshot.deviceId !== device.identity?.tuyaDeviceId) throw new Error('Identità Tuya non corrispondente.');
  if (snapshot.online !== true || !snapshot.measurements.ambientTemperature) throw new Error('Sensore Dewin non disponibile.');
  return {
    physicalDeviceId: snapshot.deviceId,
    name: snapshot.name,
    category: snapshot.category,
    capabilities: Object.entries(snapshot.measurements).filter(([, value]) => value !== null).map(([name]) => name),
    verifiedAt: snapshot.updatedAt,
  };
}
