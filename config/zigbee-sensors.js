export const ZIGBEE_SENSOR_CONFIG = Object.freeze({
  brokerUrl: 'mqtt://localhost:1883',
  freshnessMs: 120 * 60 * 1000,
  sensors: Object.freeze([
    Object.freeze({ id: 'S1', name: 'SmartHomeS1', friendlyName: 'SmartHomeS1', topic: 'zigbee2mqtt/SmartHomeS1', model: 'SONOFF SNZB-02P', zigbeeModel: 'SNZB-02P', manufacturer: 'SONOFF', humidity: true }),
    Object.freeze({ id: 'S2', name: 'SmartHomeS2', friendlyName: 'SmartHomeS2', topic: 'zigbee2mqtt/SmartHomeS2', model: 'SONOFF SNZB-02P', zigbeeModel: 'SNZB-02P', manufacturer: 'SONOFF', humidity: true }),
    Object.freeze({ id: 'S4', name: 'SmartHomeS4', friendlyName: 'SmartHomeS4', topic: 'zigbee2mqtt/SmartHomeS4', model: 'SONOFF SNZB-02P', zigbeeModel: 'SNZB-02P', manufacturer: 'SONOFF', humidity: true }),
    Object.freeze({ id: 'S5', name: 'SONOFF — Temperatura acqua', friendlyName: 'pond-temp-acqua', topic: 'zigbee2mqtt/pond-temp-acqua', ieeeAddress: '0xa4c1380cd121ffff', model: 'SNZB-02LD', manufacturer: 'SONOFF', humidity: false, requiresConfirmedMessage: true }),
  ]),
  doorContacts: Object.freeze([
    ['DW1', 'sala-dw1'], ['DW2', 'sala-dw2'], ['DW3', 'sala-dw3'], ['DW4', 'cucina-dw4'],
    ['DW5', 'cucina-dw5'], ['DW6', 'camera-dw6'], ['DW7', 'bagno-dw7'], ['DW8', 'cameretta-dw8'],
  ].map(([id, friendlyName]) => Object.freeze({ id, friendlyName, topic: `zigbee2mqtt/${friendlyName}`, model: 'SNZB-04PR2', manufacturer: 'SONOFF' }))),
  motionSensor: Object.freeze({ id: 'PR1', friendlyName: 'sala-pr1', topic: 'zigbee2mqtt/sala-pr1', ieeeAddress: '0xf044d3fffef6cb7a', model: 'SNZB-03P', manufacturer: 'SONOFF' }),
  siren: Object.freeze({ id: 'SR1', friendlyName: 'terrazzo-SR1', topic: 'zigbee2mqtt/terrazzo-SR1', setTopic: 'zigbee2mqtt/terrazzo-SR1/set', model: 'SNZB-09P', manufacturer: 'SONOFF' }),
  bridgeDevicesTopic: 'zigbee2mqtt/bridge/devices',
  ledbar: Object.freeze({ id: 'LB1', name: 'SmartHomeLB1', topic: 'zigbee2mqtt/SmartHomeLB1', setTopic: 'zigbee2mqtt/SmartHomeLB1/set', getTopic: 'zigbee2mqtt/SmartHomeLB1/get', getPayload: Object.freeze({ state: '', brightness: '' }) }),
  lights: Object.freeze([
    Object.freeze({ id: 'L1', name: 'cucina-L1', topic: 'zigbee2mqtt/cucina-L1', setTopic: 'zigbee2mqtt/cucina-L1/set', getTopic: 'zigbee2mqtt/cucina-L1/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L2', name: 'camera-L2', topic: 'zigbee2mqtt/camera-L2', setTopic: 'zigbee2mqtt/camera-L2/set', getTopic: 'zigbee2mqtt/camera-L2/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L5', name: 'bagno-L5', topic: 'zigbee2mqtt/bagno-L5', setTopic: 'zigbee2mqtt/bagno-L5/set', getTopic: 'zigbee2mqtt/bagno-L5/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L6', name: 'cameretta-L6', topic: 'zigbee2mqtt/cameretta-L6', setTopic: 'zigbee2mqtt/cameretta-L6/set', getTopic: 'zigbee2mqtt/cameretta-L6/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L8', name: 'giardino-L8', topic: 'zigbee2mqtt/giardino-L8', setTopic: 'zigbee2mqtt/giardino-L8/set', getTopic: 'zigbee2mqtt/giardino-L8/get', getPayload: Object.freeze({ state: '' }) }),
    Object.freeze({ id: 'L11', name: 'terrazzo-L11', topic: 'zigbee2mqtt/terrazzo-L11', setTopic: 'zigbee2mqtt/terrazzo-L11/set', getTopic: 'zigbee2mqtt/terrazzo-L11/get', getPayload: Object.freeze({ state: '' }) }),
  ]),
});
