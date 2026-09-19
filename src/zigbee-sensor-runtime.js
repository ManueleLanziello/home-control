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
    this.ledbar = null;
    this.listeners = new Set();
    this.topics = new Map(config.sensors.map(sensor => [sensor.topic, sensor]));
    this.ledbarTopic = config.ledbar?.topic;
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
        this.client.subscribe([...this.topics.keys(), this.ledbarTopic].filter(Boolean), { qos: 0 }, error => {
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
        if ((!sensor && topic !== this.ledbarTopic) || this.stopped) return;
        let payload;
        try { payload = JSON.parse(bytes.toString()); } catch { return; }
        if (topic === this.ledbarTopic) {
          const state = typeof payload.state === 'string' ? payload.state.toUpperCase() : null;
          const brightness = Number.isInteger(payload.brightness) && payload.brightness >= 0 && payload.brightness <= 254 ? payload.brightness : null;
          if (!['ON', 'OFF'].includes(state) && brightness === null) return;
          this.ledbar = {
            state: ['ON', 'OFF'].includes(state) ? state : this.ledbar?.state ?? null,
            brightness: brightness ?? this.ledbar?.brightness ?? null,
            updatedAt: new Date(this.now()).toISOString(),
          };
          this.notify();
          return;
        }
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
  readLedbarSnapshot() {
    const snapshot = this.ledbar || { state: null, brightness: null, updatedAt: null };
    const age = this.now() - Date.parse(snapshot.updatedAt);
    const online = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
    return { ...snapshot, id: this.config.ledbar?.id ?? 'LB1', name: this.config.ledbar?.name ?? 'SmartHomeLB1', online, available: this.connected && online };
  }
  publishLedbar(payload) {
    if (!this.client || !this.connected || this.stopped || !this.config.ledbar?.setTopic) return Promise.reject(new Error('LED bar non disponibile'));
    return new Promise((resolve, reject) => this.client.publish(this.config.ledbar.setTopic, JSON.stringify(payload), { qos: 0 }, error => error ? reject(error) : resolve(this.readLedbarSnapshot())));
  }
  setLedbarPower(on) { return this.publishLedbar({ state: on ? 'ON' : 'OFF' }); }
  setLedbarBrightness(brightness) { return this.publishLedbar({ brightness }); }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.connected = false;
    this.notify();
    this.listeners.clear();
    try { this.client?.end(true); } catch { /* Shutdown must remain safe after a transport failure. */ }
  }
}
