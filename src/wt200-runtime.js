import { TuyaCloudClient, Wt200TuyaAdapter } from '@smarthome/core';

export class HomeWt200Runtime {
  constructor({ client, adapter = null, now = () => new Date().toISOString() }) {
    this.adapter = adapter || new Wt200TuyaAdapter({ client, now });
  }

  async readSnapshot() {
    return this.adapter.read();
  }
}

export function createHomeWt200Runtime({ clientId, clientSecret, deviceId, now }) {
  const client = new TuyaCloudClient({ clientId, clientSecret, deviceId });
  return new HomeWt200Runtime({ client, now });
}
