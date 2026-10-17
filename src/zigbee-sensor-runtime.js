import { normalizeSnzb02pPayload } from '@smarthome/core';
import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';
import { normalizeDoorContactPayload, normalizeZigbeeDeviceIdentity } from './zigbee-door-contact.js';
import { normalizeMotionSensorPayload } from './zigbee-motion-sensor.js';

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
    this.doorContacts = new Map();
    this.doorIdentities = new Map();
    this.motionSensor = null;
    this.motionIdentity = null;
    this.ledbar = null;
    this.lights = new Map();
    this.listeners = new Set();
    this.topics = new Map(config.sensors.map(sensor => [sensor.topic, sensor]));
    this.doorContactTopics = new Map((config.doorContacts || []).map(contact => [contact.topic, contact]));
    this.motionSensorTopic = config.motionSensor?.topic;
    this.ledbarTopic = config.ledbar?.topic;
    this.lightTopics = new Map((config.lights || []).map(light => [light.topic, light]));
  }
  subscribeState(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  notify(kind = 'state') {
    for (const listener of this.listeners) {
      try { listener(kind); } catch { /* A UI subscriber must not break MQTT handling. */ }
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
        this.client.subscribe([...this.topics.keys(), ...this.doorContactTopics.keys(), this.motionSensorTopic, this.config.bridgeDevicesTopic, this.ledbarTopic, ...this.lightTopics.keys()].filter(Boolean), { qos: 0 }, (error, granted) => {
          if (this.stopped || !this.connectionActive || cycle !== this.connectionCycle || completed) return;
          completed = true;
          this.connected = !error && !granted?.some(subscription => subscription.qos === 128);
          this.notify('connection');
          // One state request per configured actuator and successful subscription.
          // Incoming MQTT messages remain the sole source of confirmed state.
          for (const device of [this.config.ledbar, ...(this.config.lights || [])]) {
            if (!this.connected || !device?.getTopic) continue;
            try { this.client.publish(device.getTopic, JSON.stringify(device.getPayload || {}), { qos: 0 }, () => {}); } catch { /* No retry: a failed read must not break MQTT handling. */ }
          }
        });
      });
      const disconnect = () => {
        this.connectionActive = false;
        this.connectionCycle += 1;
        this.connected = false;
        this.notify('connection');
      };
      this.client.on('offline', disconnect);
      this.client.on('close', disconnect);
      this.client.on('message', (topic, bytes, packet = {}) => {
        const sensor = this.topics.get(topic);
        const doorContact = this.doorContactTopics.get(topic);
        const light = this.lightTopics.get(topic);
        if ((!sensor && !doorContact && topic !== this.motionSensorTopic && topic !== this.config.bridgeDevicesTopic && topic !== this.ledbarTopic && !light) || this.stopped) return;
        let payload;
        try { payload = JSON.parse(bytes.toString()); } catch { return; }
        if (topic === this.config.bridgeDevicesTopic) {
          if (!Array.isArray(payload)) return;
          for (const contact of this.config.doorContacts || []) {
            const device = payload.find(item => item?.friendly_name === contact.friendlyName);
            const identity = normalizeZigbeeDeviceIdentity(device);
            if (identity) this.doorIdentities.set(contact.id, identity);
          }
          const motionDevice = payload.find(item => item?.friendly_name === this.config.motionSensor?.friendlyName);
          this.motionIdentity = normalizeZigbeeDeviceIdentity(motionDevice);
          this.notify('doorContacts');
          this.notify('motionSensor');
          return;
        }
        if (topic === this.ledbarTopic) {
          const state = typeof payload.state === 'string' ? payload.state.toUpperCase() : null;
          const brightness = Number.isInteger(payload.brightness) && payload.brightness >= 0 && payload.brightness <= 254 ? payload.brightness : null;
          if (!['ON', 'OFF'].includes(state) && brightness === null) return;
          this.ledbar = {
            state: ['ON', 'OFF'].includes(state) ? state : this.ledbar?.state ?? null,
            brightness: brightness ?? this.ledbar?.brightness ?? null,
            updatedAt: new Date(this.now()).toISOString(),
          };
          this.notify('ledbar');
          return;
        }
        if (light) {
          const state = typeof payload.state === 'string' ? payload.state.toUpperCase() : null;
          if (!['ON', 'OFF'].includes(state)) return;
          this.lights.set(light.id, { state, updatedAt: new Date(this.now()).toISOString() });
          this.notify('lights');
          return;
        }
        if (doorContact) {
          const snapshot = normalizeDoorContactPayload(payload, this.doorContacts.get(doorContact.id), new Date(this.now()).toISOString());
          if (!snapshot) return;
          this.doorContacts.set(doorContact.id, snapshot);
          this.notify('doorContacts');
          return;
        }
        if (topic === this.motionSensorTopic) {
          const snapshot = normalizeMotionSensorPayload(payload, this.motionSensor || {}, new Date(this.now()).toISOString(), packet.retain);
          if (!snapshot) return;
          this.motionSensor = snapshot;
          this.notify('motionSensor');
          return;
        }
        const snapshot = normalizeSnzb02pPayload(payload, { updatedAt: new Date(this.now()).toISOString() });
        if (!snapshot) return;
        this.latest.set(sensor.id, snapshot);
        this.notify('sensors');
      });
    } catch {
      this.connected = false;
      this.notify('connection');
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
  readDoorContactSnapshot() {
    const now = this.now();
    const identityCount = new Map();
    for (const identity of this.doorIdentities.values()) if (identity?.ieeeAddress) identityCount.set(identity.ieeeAddress, (identityCount.get(identity.ieeeAddress) || 0) + 1);
    return Object.fromEntries((this.config.doorContacts || []).map(contact => {
      const snapshot = this.doorContacts.get(contact.id) || { contact: null, tamper: null, batteryLow: null, battery: null, voltage: null, linkQuality: null, updatedAt: null };
      const age = now - Date.parse(snapshot.updatedAt);
      const online = this.connected && Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
      const identity = this.doorIdentities.get(contact.id) || null;
      const identityStatus = !identity ? 'unknown' : identityCount.get(identity.ieeeAddress) > 1 ? 'duplicate' : identity.model !== contact.model || identity.manufacturer !== contact.manufacturer ? 'model_mismatch' : 'verified';
      return [contact.id, {
        id: contact.id, friendlyName: contact.friendlyName, topic: contact.topic, model: contact.model, manufacturer: contact.manufacturer, protocol: 'Zigbee',
        identity: { ieeeAddress: identity?.ieeeAddress ?? null }, identityStatus, reportedModel: identity?.model ?? null, reportedManufacturer: identity?.manufacturer ?? null,
        contact: snapshot.contact ?? null, closed: snapshot.contact ?? null, tamper: snapshot.tamper ?? null,
        tamperState: snapshot.tamper === true ? 'detected' : snapshot.tamper === false ? 'normal' : 'unknown',
        batteryLow: snapshot.batteryLow ?? null, battery: snapshot.battery ?? null, voltage: snapshot.voltage ?? null, linkQuality: snapshot.linkQuality ?? null,
        updatedAt: snapshot.updatedAt ?? null, online, available: online, reason: online ? null : snapshot.updatedAt ? this.connected ? 'stale' : 'broker_offline' : 'no_data',
      }];
    }));
  }
  readMotionSensorSnapshot() {
    const sensor = this.config.motionSensor;
    if (!sensor) return null;
    const snapshot = this.motionSensor || { occupancy: null, motionTimeout: null, illumination: null, battery: null, voltage: null, linkQuality: null, updatedAt: null, confirmed: false };
    const age = this.now() - Date.parse(snapshot.updatedAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
    const identity = this.motionIdentity;
    const identityStatus = !identity ? 'unknown' : identity.ieeeAddress !== sensor.ieeeAddress ? 'ieee_mismatch' : identity.model !== sensor.model || identity.manufacturer !== sensor.manufacturer ? 'model_mismatch' : 'verified';
    const available = this.connected && snapshot.confirmed === true && fresh;
    return {
      id: sensor.id, friendlyName: sensor.friendlyName, topic: sensor.topic, model: sensor.model, manufacturer: sensor.manufacturer, protocol: 'Zigbee',
      identity: { ieeeAddress: identity?.ieeeAddress ?? null }, identityStatus, reportedModel: identity?.model ?? null, reportedManufacturer: identity?.manufacturer ?? null,
      occupancy: snapshot.occupancy ?? null, motionTimeout: snapshot.motionTimeout ?? null, illumination: snapshot.illumination ?? null, battery: snapshot.battery ?? null, voltage: snapshot.voltage ?? null, linkQuality: snapshot.linkQuality ?? null,
      updatedAt: snapshot.updatedAt ?? null, online: available, available, confirmed: snapshot.confirmed === true,
      reason: available ? null : !snapshot.updatedAt ? 'no_data' : !this.connected ? 'broker_offline' : snapshot.confirmed !== true ? 'historical' : 'stale',
    };
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
    this.notify('connection');
    this.listeners.clear();
    try { this.client?.end(true); } catch { /* Shutdown must remain safe after a transport failure. */ }
  }
}
