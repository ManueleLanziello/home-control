import { normalizeSnzb02pPayload } from '@smarthome/core';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';

export class HomeZigbeeSensorRuntime {
  constructor({ connect, config = ZIGBEE_SENSOR_CONFIG, now = Date.now } = {}) {
    this.connect = connect;
    this.config = config;
    this.now = now;
    this.client = null;
    this.connected = false;
    this.stopped = false;
    this.latest = new Map();
    this.listeners = new Set();
    this.topics = new Map(config.sensors.map(sensor => [sensor.topic, sensor]));
  }
  subscribeState(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify() {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* A UI subscriber must not break MQTT handling. */ }
    }
  }
  start() {
    if (this.client || this.stopped) return;
    try {
      this.client = this.connect(this.config.brokerUrl, {
        reconnectPeriod: 5000, connectTimeout: 10_000,
        resubscribe: false, queueQoSZero: false,
      });
      this.client.on('error', () => {});
      this.client.on('connect', () => {
        if (this.stopped) return;
        this.client.subscribe([...this.topics.keys()], { qos: 0 }, error => {
          if (this.stopped) return;
          this.connected = !error;
          this.notify();
        });
      });
      const disconnect = () => { this.connected = false; this.notify(); };
      this.client.on('offline', disconnect);
      this.client.on('close', disconnect);
      this.client.on('message', (topic, bytes) => {
        const sensor = this.topics.get(topic);
        if (!sensor || this.stopped) return;
        let payload;
        try { payload = JSON.parse(bytes.toString()); } catch { return; }
        const snapshot = normalizeSnzb02pPayload(payload, { updatedAt: new Date(this.now()).toISOString() });
        if (!snapshot) return;
        this.latest.set(sensor.id, snapshot);
        this.notify();
      });
    } catch {
      this.connected = false;
      this.notify();
    }
  }
  readSnapshot() {
    const now = this.now();
    return Object.fromEntries(this.config.sensors.map(sensor => {
      const snapshot = this.latest.get(sensor.id) || {
        temperature: null, humidity: null, battery: null, linkQuality: null,
        updatedAt: null, model: 'SONOFF SNZB-02P', protocol: 'Zigbee',
      };
      const age = now - Date.parse(snapshot.updatedAt);
      const online = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
      return [sensor.id, { ...snapshot, name: sensor.name, online, available: this.connected && online }];
    }));
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.notify();
    this.listeners.clear();
    try { this.client?.end(true); } catch { /* Shutdown must remain safe after a transport failure. */ }
  }
}
