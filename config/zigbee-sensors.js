export const ZIGBEE_SENSOR_CONFIG = Object.freeze({
  brokerUrl: 'mqtt://localhost:1883',
  freshnessMs: 120 * 60 * 1000,
  sensors: Object.freeze([
    Object.freeze({ id: 'S1', name: 'SmartHomeS1', topic: 'zigbee2mqtt/SmartHomeS1' }),
    Object.freeze({ id: 'S2', name: 'SmartHomeS2', topic: 'zigbee2mqtt/SmartHomeS2' }),
    Object.freeze({ id: 'S4', name: 'SmartHomeS4', topic: 'zigbee2mqtt/SmartHomeS4' }),
  ]),
  ledbar: Object.freeze({ id: 'LB1', name: 'SmartHomeLB1', topic: 'zigbee2mqtt/SmartHomeLB1', setTopic: 'zigbee2mqtt/SmartHomeLB1/set' }),
});
