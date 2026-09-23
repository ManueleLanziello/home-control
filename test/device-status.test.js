import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeviceStatuses } from '../src/device-status.js';
import { HomeStatusRuntime } from '../src/home-status.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';

const now = Date.parse('2026-09-23T12:00:00.000Z');
const fresh = new Date(now - 1_000).toISOString();
const inventory = [
  { marker: 'D1', presenceEnabled: false, status: 'active' }, { marker: 'D6', presenceEnabled: true, status: 'active' },
  { marker: 'D9', presenceEnabled: true, status: 'active' }, { marker: 'D10', presenceEnabled: true, status: 'active' },
  { marker: 'D11', presenceEnabled: true, status: 'active' }, { marker: 'D12', presenceEnabled: true, status: 'active' },
  { marker: 'D13', presenceEnabled: false, status: 'future' }, { marker: 'D14', presenceEnabled: true, status: 'active' },
  { marker: 'D15', presenceEnabled: true, status: 'active' }, { marker: 'D16', presenceEnabled: true, status: 'active' },
  { marker: 'D17', presenceEnabled: true, status: 'active' }, { marker: 'D18', presenceEnabled: true, status: 'active', identity: { deviceId: 'dewin-pond' } },
];

test('normalizza inventory esplicito e riusa esclusivamente gli snapshot runtime', () => {
  const statuses = normalizeDeviceStatuses(inventory, {
    selfOnline: true, ledbar: { online: true, available: true }, hood: { online: true },
    cameras: { C1: { online: true, available: true }, C2: { online: false, available: false } }, thermostat: { online: true },
    zigbee: { S1: { online: true, available: true }, S2: { online: false, available: true }, S4: { online: true, available: true } },
    dewin: { online: true, updatedAt: fresh },
  }, now);
  assert.equal(statuses.D1.status, 'disabled'); assert.equal(statuses.D6.status, 'online'); assert.equal(statuses.D9.status, 'online');
  assert.equal(statuses.D10.status, 'online'); assert.equal(statuses.D11.status, 'online'); assert.equal(statuses.D12.status, 'offline');
  assert.equal(statuses.D13.status, 'not_configured'); assert.equal(statuses.D14.status, 'online'); assert.equal(statuses.D15.status, 'online');
  assert.equal(statuses.D16.status, 'offline'); assert.equal(statuses.D17.status, 'online'); assert.equal(statuses.D18.status, 'online');
});

test('il frontend conserva soltanto il payload normalizzato ricevuto', () => {
  const store = createFloorplanState();
  const devices = { D6: { id: 'D6', presenceEnabled: true, status: 'online' }, D13: { id: 'D13', presenceEnabled: false, status: 'not_configured' } };
  store.applyHomeSnapshot({ devices });
  assert.deepEqual(store.snapshot().devices, devices);
});

test('la configurazione usa tutti i marker geometrici D1-D18 per etichetta, mai coordinate', () => {
  assert.equal(floorplanConfig.mappings.devices, 'LAYER-DISPOSITIVI.svg');
  assert.deepEqual(floorplanConfig.devices.map(device => device.id), Array.from({ length: 18 }, (_, index) => `D${index + 1}`));
  assert.deepEqual(floorplanConfig.devices.map(device => device.marker.label), Array.from({ length: 18 }, (_, index) => String(index + 1)));
});

test('lo snapshot Home pubblica gli stati senza nuove letture per marker', async () => {
  const runtime = new HomeStatusRuntime({
    hardwareStore: { async read() { return { devices: [], inventory }; } },
    roleStore: { async read() { return {}; } }, now: () => now,
    readThermostat: async () => ({ online: true, updatedAt: fresh, thermostat: {} }),
    readHood: async () => ({ online: true, updatedAt: fresh }),
    readZigbeeSensors: () => ({ S1: { online: true, available: true }, S2: { online: false, available: true }, S4: { online: true, available: true } }),
    readZigbeeLedbar: () => ({ online: true, available: true }),
    readCameras: async () => ({ C1: { online: true, available: true }, C2: { online: false, available: false } }),
    createSensorRuntime: () => ({ async readSnapshot() { return { online: true, updatedAt: fresh, measurements: {} }; } }),
  });
  const home = await runtime.readSnapshot();
  assert.equal(home.devices.D6.status, 'online');
  assert.equal(home.devices.D10.status, 'online');
  assert.equal(home.devices.D12.status, 'offline');
  assert.equal(home.devices.D18.status, 'online');
});
