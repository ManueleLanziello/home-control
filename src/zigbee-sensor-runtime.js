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
    this.connectionCycle = 0;
    this.connectionActive = false;
    this.latest = new Map();
    this.ledbar = null;
    this.lights = new Map();
    this.listeners = new Set();
    this.topics = new Map(config.sensors.map(sensor => [sensor.topic, sensor]));
    this.ledbarTopic = config.ledbar?.topic;
    this.lightTopics = new Map((config.lights || []).map(light => [light.topic, light]));
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
        if (this.stopped || this.connectionActive) return;
        this.connectionActive = true;
        const cycle = ++this.connectionCycle;
        let completed = false;
      this.client.subscribe([...this.topics.keys(), this.ledbarTopic, ...this.lightTopics.keys()].filter(Boolean), { qos: 0 }, (error, granted) => {
          if (this.stopped || !this.connectionActive || cycle !== this.connectionCycle || completed) return;
          completed = true;
          this.connected = !error && !granted?.some(subscription => subscription.qos === 128);
          this.notify();
          if (this.connected && !this.stopped && cycle === this.connectionCycle && this.config.ledbar?.getTopic) {
            // One read request per successful subscription; only an incoming state confirms LB1.
            try {
              this.client.publish(this.config.ledbar.getTopic, '{"state":"","brightness":""}', { qos: 0 }, () => {});
            } catch { /* No retry: a failed read must not break sensor handling. */ }
          }
          for (const light of this.config.lights || []) {
            if (!this.connected || !light.getTopic) continue;
            try { this.client.publish(light.getTopic, '{}', { qos: 0 }, () => {}); } catch { /* MQTT failure is reflected by the next snapshot. */ }
          }
        });
      });
      const disconnect = () => {
        this.connectionActive = false;
        this.connectionCycle += 1;
        this.connected = false;
        this.notify();
      };
      this.client.on('offline', disconnect);
      this.client.on('close', disconnect);
      this.client.on('message', (topic, bytes) => {
        const sensor = this.topics.get(topic);
        const light = this.lightTopics.get(topic);
        if ((!sensor && topic !== this.ledbarTopic && !light) || this.stopped) return;
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
        if (light) {
          const state = typeof payload.state === 'string' ? payload.state.toUpperCase() : null;
          if (!['ON', 'OFF'].includes(state)) return;
          this.lights.set(light.id, { state, updatedAt: new Date(this.now()).toISOString() });
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
    const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
    const known = ['ON', 'OFF'].includes(snapshot.state);
    // Silence is not evidence of physical disconnection. Keep last-known state usable
    // while MQTT is connected, exposing snapshot freshness separately.
    const available = this.connected && known;
    return { ...snapshot, id: this.config.ledbar?.id ?? 'LB1', name: this.config.ledbar?.name ?? 'SmartHomeLB1', known, fresh, online: available, available };
  }
  publishLedbar(payload) {
    if (!this.client || !this.connected || this.stopped || !this.config.ledbar?.setTopic) return Promise.reject(new Error('LED bar non disponibile'));
    return new Promise((resolve, reject) => this.client.publish(this.config.ledbar.setTopic, JSON.stringify(payload), { qos: 0 }, error => error ? reject(error) : resolve(this.readLedbarSnapshot())));
  }
  setLedbarPower(on) { return this.publishLedbar({ state: on ? 'ON' : 'OFF' }); }
  setLedbarBrightness(brightness) { return this.publishLedbar({ brightness }); }
  readLightsSnapshot() {
    return Object.fromEntries((this.config.lights || []).map(light => {
      const snapshot = this.lights.get(light.id) || { state: null, updatedAt: null };
      const age = this.now() - Date.parse(snapshot.updatedAt);
      const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
      const known = ['ON', 'OFF'].includes(snapshot.state);
      const available = this.connected && known;
      return [light.id, { id: light.id, name: light.name, state: snapshot.state, updatedAt: snapshot.updatedAt, known, fresh, online: available, available }];
    }));
  }
  setLightPower(id, on) {
    const light = (this.config.lights || []).find(entry => entry.id === id);
    if (!light || !this.client || !this.connected || this.stopped || !light.setTopic) return Promise.reject(new Error('Luce Zigbee non disponibile'));
    return new Promise((resolve, reject) => this.client.publish(light.setTopic, JSON.stringify({ state: on ? 'ON' : 'OFF' }), { qos: 0 }, error => error ? reject(error) : resolve(this.readLightsSnapshot()[id])));
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.connectionActive = false;
    this.connectionCycle += 1;
    this.connected = false;
    this.notify();
    this.listeners.clear();
    try { this.client?.end(true); } catch { /* Shutdown must remain safe after a transport failure. */ }
  }
}
