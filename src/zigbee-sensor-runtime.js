import { ZIGBEE_SENSOR_CONFIG } from '../config/zigbee-sensors.js';
import { normalizeDoorContactPayload, normalizeZigbeeDeviceIdentity } from './zigbee-door-contact.js';
import { normalizeMotionSensorPayload } from './zigbee-motion-sensor.js';
import { normalizeSirenPayload } from './zigbee-siren.js';

const validNumber = (payload, key, minimum, maximum) => Object.hasOwn(payload, key)
  && Number.isFinite(payload[key]) && payload[key] >= minimum && payload[key] <= maximum ? payload[key] : null;
const retained = (previous, key) => Number.isFinite(previous?.[key]) ? previous[key] : null;

export function normalizeSnzb02pPayload(payload, { updatedAt = null, previous = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const temperature = Object.hasOwn(payload, 'temperature') && Number.isFinite(payload.temperature) ? payload.temperature : null;
  const humidity = validNumber(payload, 'humidity', 0, 100);
  const battery = validNumber(payload, 'battery', 0, 100);
  const linkQuality = validNumber(payload, 'linkquality', 0, 255);
  if (temperature === null && humidity === null && battery === null && linkQuality === null) return null;
  return { temperature: temperature ?? retained(previous, 'temperature'), humidity: humidity ?? retained(previous, 'humidity'),
    battery: battery ?? retained(previous, 'battery'), linkQuality: linkQuality ?? retained(previous, 'linkQuality'),
    online: true, updatedAt, model: 'SONOFF SNZB-02P', protocol: 'Zigbee' };
}

export function normalizeSnzb02ldPayload(payload, { updatedAt = null, confirmed = false, previous = null } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const temperature = Object.hasOwn(payload, 'temperature') && Number.isFinite(payload.temperature) ? payload.temperature : null;
  const battery = validNumber(payload, 'battery', 0, 100);
  const linkQuality = validNumber(payload, 'linkquality', 0, 255);
  if (temperature === null && !Number.isFinite(previous?.temperature)) return null;
  return { temperature: temperature ?? retained(previous, 'temperature'), humidity: null,
    battery: battery ?? retained(previous, 'battery'), linkQuality: linkQuality ?? retained(previous, 'linkQuality'),
    online: true, updatedAt, confirmed, model: 'SONOFF SNZB-02LD', protocol: 'Zigbee' };
}

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
    this.sensorIdentities = new Map();
    this.doorContacts = new Map();
    this.doorIdentities = new Map();
    this.motionSensor = null;
    this.motionIdentity = null;
    this.siren = null;
    this.sirenIdentity = null;
    this.ledbar = null;
    this.lights = new Map();
    this.lightIdentities = new Map();
    this.listeners = new Set();
    this.topics = new Map(config.sensors.map(sensor => [sensor.topic, sensor]));
    this.doorContactTopics = new Map((config.doorContacts || []).map(contact => [contact.topic, contact]));
    this.motionSensorTopic = config.motionSensor?.topic;
    this.sirenTopic = config.siren?.topic;
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
        this.client.subscribe([...this.topics.keys(), ...this.doorContactTopics.keys(), this.motionSensorTopic, this.sirenTopic, this.config.bridgeDevicesTopic, this.ledbarTopic, ...this.lightTopics.keys()].filter(Boolean), { qos: 0 }, (error, granted) => {
          if (this.stopped || !this.connectionActive || cycle !== this.connectionCycle || completed) return;
          completed = true;
          this.connected = !error && !granted?.some(subscription => subscription.qos === 128);
          this.notify('connection');
          // One state request per configured device and successful subscription.
          // Incoming MQTT messages remain the sole source of confirmed state.
          for (const device of [...this.config.sensors, this.config.ledbar, ...(this.config.lights || [])]) {
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
        if ((!sensor && !doorContact && topic !== this.motionSensorTopic && topic !== this.sirenTopic && topic !== this.config.bridgeDevicesTopic && topic !== this.ledbarTopic && !light) || this.stopped) return;
        let payload;
        try { payload = JSON.parse(bytes.toString()); } catch { return; }
        if (topic === this.config.bridgeDevicesTopic) {
          if (!Array.isArray(payload)) return;
          for (const contact of this.config.doorContacts || []) {
            const device = payload.find(item => item?.friendly_name === contact.friendlyName);
            const identity = normalizeZigbeeDeviceIdentity(device);
            if (identity) this.doorIdentities.set(contact.id, identity);
          }
          for (const sensor of this.config.sensors) {
            const device = payload.find(item => item?.friendly_name === sensor.friendlyName);
            const identity = normalizeZigbeeDeviceIdentity(device);
            if (identity) this.sensorIdentities.set(sensor.id, identity);
          }
          const motionDevice = payload.find(item => item?.friendly_name === this.config.motionSensor?.friendlyName);
          this.motionIdentity = normalizeZigbeeDeviceIdentity(motionDevice);
          const sirenDevice = payload.find(item => item?.friendly_name === this.config.siren?.friendlyName);
          this.sirenIdentity = normalizeZigbeeDeviceIdentity(sirenDevice);
          for (const light of this.config.lights || []) {
            const device = payload.find(item => item?.friendly_name === light.name);
            const identity = normalizeZigbeeDeviceIdentity(device);
            if (identity) this.lightIdentities.set(light.id, identity);
          }
          this.notify('doorContacts');
          this.notify('sensors');
          this.notify('motionSensor');
          this.notify('siren');
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
        if (topic === this.sirenTopic) {
          const snapshot = normalizeSirenPayload(payload, this.siren || {}, new Date(this.now()).toISOString(), packet.retain);
          if (!snapshot) return;
          this.siren = snapshot;
          this.notify('siren');
          return;
        }
        const snapshot = sensor.model === 'SNZB-02LD'
          ? normalizeSnzb02ldPayload(payload, { updatedAt: new Date(this.now()).toISOString(), confirmed: packet.retain !== true, previous: this.latest.get(sensor.id) })
          : normalizeSnzb02pPayload(payload, { updatedAt: new Date(this.now()).toISOString(), previous: this.latest.get(sensor.id) });
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
        updatedAt: null, confirmed: false, model: sensor.model, protocol: 'Zigbee',
      };
      const age = now - Date.parse(snapshot.updatedAt);
      const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
      const confirmed = sensor.requiresConfirmedMessage !== true || snapshot.confirmed === true;
      const online = fresh && confirmed && Number.isFinite(snapshot.temperature);
      const identity = this.sensorIdentities.get(sensor.id) || null;
      const identityStatus = !identity ? 'unknown' : sensor.ieeeAddress && identity.ieeeAddress !== sensor.ieeeAddress ? 'ieee_mismatch' : identity.model !== (sensor.zigbeeModel || sensor.model) || identity.manufacturer !== sensor.manufacturer ? 'model_mismatch' : 'verified';
      const reason = online && this.connected ? null : !snapshot.updatedAt ? 'no_data' : !this.connected ? 'broker_offline' : !confirmed ? 'historical' : 'stale';
      return [sensor.id, { ...snapshot, name: sensor.name, model: sensor.model, manufacturer: sensor.manufacturer, protocol: 'Zigbee', identity: { ieeeAddress: identity?.ieeeAddress ?? null }, identityStatus, reportedModel: identity?.model ?? null, reportedManufacturer: identity?.manufacturer ?? null, online, available: this.connected && online, reason }];
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
  readSirenSnapshot() {
    const siren = this.config.siren;
    if (!siren) return null;
    const snapshot = this.siren || { sirenOn: null, powerSupplyMode: null, battery: null, soundEnabled: null, lightEnabled: null, tamper: null, soundType: null, volumeLevel: null, duration: null, linkQuality: null, updatedAt: null, confirmed: false };
    const age = this.now() - Date.parse(snapshot.updatedAt);
    const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
    const identity = this.sirenIdentity;
    const identityStatus = !identity ? 'unknown' : identity.model !== siren.model || identity.manufacturer !== siren.manufacturer ? 'model_mismatch' : 'verified';
    const available = this.connected && snapshot.confirmed === true && fresh;
    return {
      id: siren.id, friendlyName: siren.friendlyName, topic: siren.topic, model: siren.model, manufacturer: siren.manufacturer, protocol: 'Zigbee',
      identity: { ieeeAddress: identity?.ieeeAddress ?? null }, identityStatus, reportedModel: identity?.model ?? null, reportedManufacturer: identity?.manufacturer ?? null,
      sirenOn: snapshot.sirenOn ?? null, powerSupplyMode: snapshot.powerSupplyMode ?? null, battery: snapshot.battery ?? null, soundEnabled: snapshot.soundEnabled ?? null, lightEnabled: snapshot.lightEnabled ?? null, tamper: snapshot.tamper ?? null, tamperState: snapshot.tamper === true ? 'detected' : snapshot.tamper === false ? 'normal' : 'unknown', soundType: snapshot.soundType ?? null, volumeLevel: snapshot.volumeLevel ?? null, duration: snapshot.duration ?? null, linkQuality: snapshot.linkQuality ?? null,
      updatedAt: snapshot.updatedAt ?? null, online: available, available, confirmed: snapshot.confirmed === true,
      reason: available ? null : !snapshot.updatedAt ? 'no_data' : !this.connected ? 'broker_offline' : snapshot.confirmed !== true ? 'historical' : 'stale',
    };
  }
  setSirenConfiguration(input = {}) {
    const siren = this.config.siren;
    if (!siren?.setTopic || !this.client || !this.connected || this.stopped) return Promise.reject(new Error('Sirena non disponibile'));
    const payload = {};
    if (typeof input.soundEnabled === 'boolean') payload.alarm_sound_enable = input.soundEnabled ? 'ON' : 'OFF';
    if (typeof input.lightEnabled === 'boolean') payload.alarm_light_enable = input.lightEnabled ? 'ON' : 'OFF';
    if (['siren_classic', 'siren_steady', 'siren_rising', 'siren_warning', 'siren_rapid', 'siren_emergency', 'tone_chirp', 'tone_hi_lo', 'tone_intermittent', 'tone_pulse', 'chime_doorbell', 'chime_classic_clock', 'chime_electronic_clock', 'chime_bright', 'chime_soft'].includes(input.soundType)) payload.alarm_sound_type = input.soundType;
    if (['low', 'medium', 'high', 'max'].includes(input.volumeLevel)) payload.alarm_volume_level = input.volumeLevel;
    if (Number.isInteger(input.duration) && input.duration >= 1 && input.duration <= 900) payload.alarm_duration = input.duration;
    if (!Object.keys(payload).length || Object.keys(payload).length !== Object.keys(input).length) return Promise.reject(new Error('Configurazione sirena non valida'));
    return new Promise((resolve, reject) => this.client.publish(siren.setTopic, JSON.stringify(payload), { qos: 0 }, error => error ? reject(error) : resolve({ pending: true, expected: payload })));
  }
  setSirenActive(active) {
    const siren = this.config.siren;
    if (!siren?.setTopic || !this.client || !this.connected || this.stopped || typeof active !== 'boolean') return Promise.reject(new Error('Sirena non disponibile'));
    return new Promise((resolve, reject) => this.client.publish(siren.setTopic, JSON.stringify({ siren_on: active ? 'ON' : 'OFF' }), { qos: 0 }, error => error ? reject(error) : resolve({ published: true })));
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
      const identity = this.lightIdentities.get(light.id) || null;
      const age = this.now() - Date.parse(snapshot.updatedAt);
      const fresh = Number.isFinite(age) && age >= 0 && age <= this.config.freshnessMs;
      const known = ['ON', 'OFF'].includes(snapshot.state);
      const available = this.connected && known;
      const identityStatus = !light.ieeeAddress ? null : !identity ? 'unknown' : identity.ieeeAddress !== light.ieeeAddress ? 'ieee_mismatch' : identity.model !== light.model || identity.manufacturer !== light.manufacturer ? 'model_mismatch' : 'verified';
      return [light.id, { id: light.id, name: light.name, state: snapshot.state, updatedAt: snapshot.updatedAt, known, fresh, online: available, available, identity: { ieeeAddress: identity?.ieeeAddress ?? null }, identityStatus, reportedModel: identity?.model ?? null, reportedManufacturer: identity?.manufacturer ?? null }];
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
