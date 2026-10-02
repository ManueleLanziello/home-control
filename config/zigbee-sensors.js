export const ZIGBEE_SENSOR_CONFIG = Object.freeze({
  brokerUrl: 'mqtt://localhost:1883',
  freshnessMs: 120 * 60 * 1000,
  sensors: Object.freeze([
    Object.freeze({ id: 'S1', name: 'SmartHomeS1', topic: 'zigbee2mqtt/SmartHomeS1' }),
    Object.freeze({ id: 'S2', name: 'SmartHomeS2', topic: 'zigbee2mqtt/SmartHomeS2' }),
    Object.freeze({ id: 'S4', name: 'SmartHomeS4', topic: 'zigbee2mqtt/SmartHomeS4' }),
  ]),
  ledbar: Object.freeze({ id: 'LB1', name: 'SmartHomeLB1', topic: 'zigbee2mqtt/SmartHomeLB1', setTopic: 'zigbee2mqtt/SmartHomeLB1/set', getTopic: 'zigbee2mqtt/SmartHomeLB1/get', getPayload: Object.freeze({ state: '', brightness: '' }) }),
  lights: Object.freeze([
    Object.freeze({ id: 'L5', name: 'bagno-L5', topic: 'zigbee2mqtt/bagno-L5', setTopic: 'zigbee2mqtt/bagno-L5/set', getTopic: 'zigbee2mqtt/bagno-L5/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L6', name: 'cameretta-L6', topic: 'zigbee2mqtt/cameretta-L6', setTopic: 'zigbee2mqtt/cameretta-L6/set', getTopic: 'zigbee2mqtt/cameretta-L6/get', getPayload: Object.freeze({ state: '' }) }),
  ]),
});
