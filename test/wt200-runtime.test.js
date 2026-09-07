import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createHomeControlServer } from '../server.js';
import { HomeWt200Runtime } from '../src/wt200-runtime.js';

const snapshot = {
  deviceId: 'wt200-cloud-id',
  online: true,
  name: 'Temp-3',
  category: 'wk',
  thermostat: {
    enabled: true,
    currentTemperature: 27.8,
    setpointTemperature: 31.5,
    mode: 'manual',
    childLock: false,
    fault: 0,
    upperTemperatureLimit: 60,
    temperatureCorrection: -1,
    frostProtection: false,
    sound: true,
  },
  rawDatapoints: [{ code: 'temp_current', value: 278 }],
  updatedAt: '2026-09-07T10:00:00.000Z',
};

test('runtime WT200 restituisce lo snapshot normalizzato del Core', async () => {
  const runtime = new HomeWt200Runtime({
    adapter: { async read() { return snapshot; } },
  });

  assert.deepEqual(await runtime.readSnapshot(), snapshot);
});

test('GET /api/thermostat restituisce il runtime WT200 iniettato', async () => {
  const server = createHomeControlServer({
    thermostatRuntime: { async readSnapshot() { return snapshot; } },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/thermostat`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
