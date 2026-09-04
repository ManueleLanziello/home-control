import assert from 'node:assert/strict';
import test from 'node:test';
import { DewinTuyaAdapter } from '@smarthome/core';
import { defaultHardwareRegistry, validateHardwareRegistry } from '../src/hardware-registry.js';
import { HomeDewinRuntime, dewinCapabilitiesFromSnapshot, isDewinTuyaDevice } from '../src/dewin-runtime.js';

const specification = {
  status: [
    { code: 'temp_current', type: 'Integer', name: 'Environment Temperature', values: '{"scale":1,"unit":"℃"}' },
    { code: 'humidity_value', type: 'Integer', name: 'Environment Humidity', values: '{"scale":0,"unit":"%"}' },
  ],
};

function homeDewinDevice() {
  return {
    id: 'dewin-home-test',
    alias: 'Sensore test',
    model: 'Dewin T&H Sensor',
    protocol: 'tuya-cloud',
    connectionType: 'cloud',
    metadata: { adapter: 'dewin-tuya' },
    capabilities: ['ambientTemperature', 'ambientHumidity'],
  };
}

test('Home-Control importa e usa DewinTuyaAdapter dal Core', async () => {
  let readCount = 0;
  const client = {
    async readDevice() {
      readCount += 1;
      return {
        device: { id: 'cloud-device-test', online: true, name: 'Dewin test', category: 'wsdcg' },
        statuses: [
          { code: 'temp_current', value: 234 },
          { code: 'humidity_value', value: 58 },
        ],
        specification,
      };
    },
  };

  const runtime = new HomeDewinRuntime({
    device: homeDewinDevice(),
    adapter: new DewinTuyaAdapter({ client, now: () => '2026-09-04T10:00:00.000Z' }),
  });

  const snapshot = await runtime.readSnapshot();

  assert.equal(readCount, 1);
  assert.equal(snapshot.deviceId, 'dewin-home-test');
  assert.equal(snapshot.physicalDeviceId, 'cloud-device-test');
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.updatedAt, '2026-09-04T10:00:00.000Z');
  assert.equal(snapshot.measurements.ambientTemperature.value, 23.4);
  assert.equal(snapshot.measurements.ambientHumidity.value, 58);
});

test('assenza sonda esterna gestita come capability non disponibile', () => {
  const capabilities = dewinCapabilitiesFromSnapshot({
    measurements: {
      ambientTemperature: { value: 21.5 },
      ambientHumidity: { value: 48 },
      externalProbeTemperature: null,
    },
  });

  assert.deepEqual(capabilities, ['ambientTemperature', 'ambientHumidity']);
});

test('importare il runtime non effettua chiamate cloud', () => {
  let called = false;
  const runtime = new HomeDewinRuntime({
    device: homeDewinDevice(),
    client: { async readDevice() { called = true; throw new Error('Non deve essere chiamato durante import/costruttore.'); } },
  });

  assert.equal(runtime.device.id, 'dewin-home-test');
  assert.equal(called, false);
});

test('registry Home vuoto resta valido', () => {
  assert.deepEqual(validateHardwareRegistry(defaultHardwareRegistry()), { version: 4, devices: [] });
});

test('riconoscimento Dewin Home senza ruoli o stanze hardcoded', () => {
  assert.equal(isDewinTuyaDevice(homeDewinDevice()), true);
  assert.equal(isDewinTuyaDevice({ ...homeDewinDevice(), protocol: 'lan' }), false);
});
