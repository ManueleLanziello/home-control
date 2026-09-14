import { CiarraTuyaLanAdapter } from '@smarthome/core';

export function unavailableCiarraState(previous = null) {
  return {
    online: false,
    power: typeof previous?.power === 'boolean' ? previous.power : null,
    fanSpeed: Number.isInteger(previous?.fanSpeed) ? previous.fanSpeed : null,
    light: typeof previous?.light === 'string' ? previous.light : null,
    operatingStatus: typeof previous?.operatingStatus === 'string' ? previous.operatingStatus : null,
    updatedAt: previous?.updatedAt ?? null,
  };
}

export class HomeCiarraRuntime {
  constructor({ adapter = null }) {
    this.adapter = adapter;
    this.lastState = null;
  }

  async getState() {
    if (!this.adapter) return unavailableCiarraState(this.lastState);
    try {
      this.lastState = await this.adapter.getState();
      return structuredClone(this.lastState);
    } catch {
      return unavailableCiarraState(this.lastState);
    }
  }

  async #runCommand(method, value) {
    if (!this.adapter?.[method]) {
      const error = new Error('Connessione LAN CIARRA non disponibile.');
      error.code = 'LAN_UNAVAILABLE';
      throw error;
    }
    this.lastState = await this.adapter[method](value);
    return structuredClone(this.lastState);
  }

  setPower(power) { return this.#runCommand('setPower', power); }
  setFanSpeed(fanSpeed) { return this.#runCommand('setFanSpeed', fanSpeed); }
  setLight(light) { return this.#runCommand('setLight', light); }
}

export function createHomeCiarraRuntime({ deviceId, lanIp, localKey, now }) {
  const adapter = deviceId && lanIp && localKey
    ? new CiarraTuyaLanAdapter({ deviceId, ip: lanIp, localKey, now })
    : null;
  return new HomeCiarraRuntime({ adapter });
}
