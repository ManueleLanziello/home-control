import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkPresenceRuntime, PRESENCE_CACHE_MS, normalizeMac } from '../src/network-presence-runtime.js';

const MACS = Object.freeze({ D1: '08:8A:F1:31:9E:FF', D2: 'F0:20:FF:04:F0:C9', D7: '98:03:8E:9C:0C:AF', D8: '18:69:45:C7:DA:2E' });

const item = (marker, method, ip, extra = {}) => ({
  marker, presenceEnabled: true, identity: { mac: MACS[marker] }, network: { ipv4: ip }, presence: { method, timeoutMs: 1_500, failureThreshold: 2, ...extra },
});

test('D1 and D2 keep the previous online state through one transient ICMP failure', async () => {
  let now = 0;
  const results = new Map([['D1', [true, false, false]], ['D2', [true, false, false]]]);
  const runtime = new NetworkPresenceRuntime({ now: () => now, probe: async entry => results.get(entry.marker).shift(), readNeighbor: async ip => ip.endsWith('.13') ? '08-8a-f1-31-9e-ff' : 'f0:20:ff:04:f0:c9' });
  for (const marker of ['D1', 'D2']) {
    const target = item(marker, 'icmp', marker === 'D1' ? '192.0.2.13' : '192.0.2.20');
    assert.equal((await runtime.read(target)).online, true);
    now += PRESENCE_CACHE_MS;
    assert.equal((await runtime.read(target)).online, true, `${marker} remains online after one loss`);
    now += PRESENCE_CACHE_MS;
    assert.equal((await runtime.read(target)).online, false, `${marker} goes offline after the second loss`);
  }
});

test('D7 and D8 use TCP reachability only, independently from relay state', async () => {
  let now = 0;
  const calls = [];
  const results = new Map([['D7', [true, true, false, false]], ['D8', [false, false]]]);
  const runtime = new NetworkPresenceRuntime({ now: () => now, probe: async entry => { calls.push(entry); return results.get(entry.marker).shift(); }, readNeighbor: async ip => ip.endsWith('.5') ? MACS.D7 : MACS.D8 });
  const d7 = item('D7', 'tcp', '192.0.2.5', { port: 80 });
  const d8 = item('D8', 'tcp', '192.0.2.6', { port: 80 });
  assert.equal((await runtime.read({ ...d7, relay: 'on' })).online, true);
  now += PRESENCE_CACHE_MS;
  assert.equal((await runtime.read({ ...d7, relay: 'off' })).online, true);
  assert.equal((await runtime.read({ ...d8, relay: 'off' })).online, null);
  now += PRESENCE_CACHE_MS;
  assert.equal((await runtime.read({ ...d8, relay: 'on' })).online, false);
  now += PRESENCE_CACHE_MS;
  assert.equal((await runtime.read(d7)).online, true);
  now += PRESENCE_CACHE_MS;
  assert.equal((await runtime.read(d7)).online, false);
  assert.deepEqual(calls.map(({ marker, presence }) => [marker, presence.method, presence.port]), [['D7', 'tcp', 80], ['D7', 'tcp', 80], ['D8', 'tcp', 80], ['D8', 'tcp', 80], ['D7', 'tcp', 80], ['D7', 'tcp', 80]]);
});

test('presence reads run only for configured non-camera inventory entries', async () => {
  const calls = [];
  const runtime = new NetworkPresenceRuntime({ probe: async entry => { calls.push(entry.marker); return true; }, readNeighbor: async ip => ip.endsWith('.13') ? MACS.D1 : ip.endsWith('.20') ? MACS.D2 : ip.endsWith('.5') ? MACS.D7 : MACS.D8 });
  const states = await runtime.readInventory([
    item('D1', 'icmp', '192.0.2.13'), item('D2', 'icmp', '192.0.2.20'),
    item('D7', 'tcp', '192.0.2.5', { port: 80 }), item('D8', 'tcp', '192.0.2.6', { port: 80 }),
    { marker: 'D11', presenceEnabled: true, network: { ipv4: '192.0.2.9' } },
    { marker: 'D12', presenceEnabled: true, network: { ipv4: '192.0.2.11' } },
  ]);
  assert.deepEqual(calls, ['D1', 'D2', 'D7', 'D8']);
  assert.deepEqual(Object.keys(states), ['D1', 'D2', 'D7', 'D8']);
});

test('a successful probe is not online when ARP is missing or MAC differs, including D2/C410 collision', async () => {
  let now = 0;
  const d2 = item('D2', 'icmp', '192.168.1.20');
  const d7 = item('D7', 'tcp', '192.168.1.5', { port: 80 });
  const d8 = item('D8', 'tcp', '192.168.1.6', { port: 80 });
  const neighbors = ['30-68-93-2e-83-c2', null, '18:69:45:c7:da:2e'];
  const runtime = new NetworkPresenceRuntime({ now: () => now, probe: async () => true, readNeighbor: async () => neighbors.shift() });
  const collision = await runtime.read(d2);
  assert.equal(collision.online, false);
  assert.equal(collision.identity, 'mismatch');
  now += PRESENCE_CACHE_MS;
  const absent = await runtime.read(d7);
  assert.equal(absent.online, false);
  assert.equal(absent.identity, 'missing');
  now += PRESENCE_CACHE_MS;
  assert.equal((await runtime.read(d8)).online, true);
});

test('a MAC mismatch immediately removes a prior green confirmation', async () => {
  let now = 0;
  const d2 = item('D2', 'icmp', '192.168.1.20');
  const neighbors = [MACS.D2, '30:68:93:2E:83:C2'];
  const runtime = new NetworkPresenceRuntime({ now: () => now, probe: async () => true, readNeighbor: async () => neighbors.shift() });
  assert.equal((await runtime.read(d2)).online, true);
  now += PRESENCE_CACHE_MS;
  const mismatch = await runtime.read(d2);
  assert.equal(mismatch.online, false);
  assert.equal(mismatch.identity, 'mismatch');
});

test('an unreadable ARP table never confirms an otherwise reachable host', async () => {
  const runtime = new NetworkPresenceRuntime({ probe: async () => true, readNeighbor: async () => { throw new Error('ARP unavailable'); } });
  const state = await runtime.read(item('D1', 'icmp', '192.0.2.13'));
  assert.equal(state.online, false);
  assert.equal(state.identity, 'missing');
});

test('a local IPv4 confirms the matching local interface MAC without ARP', async () => {
  let arpReads = 0;
  const runtime = new NetworkPresenceRuntime({
    probe: async () => true,
    readNeighbor: async () => { arpReads++; return null; },
    networkInterfaces: () => ({ WiFi: [{ family: 'IPv4', address: '192.0.2.13', mac: '08-8a-f1-31-9e-ff', internal: false }] }),
  });
  const state = await runtime.read(item('D1', 'icmp', '192.0.2.13'));
  assert.equal(state.online, true);
  assert.equal(state.identity, 'local');
  assert.equal(arpReads, 0);
});

test('a local IPv4 with a different interface MAC is offline and does not bypass identity', async () => {
  let arpReads = 0;
  const runtime = new NetworkPresenceRuntime({
    probe: async () => true,
    readNeighbor: async () => { arpReads++; return MACS.D1; },
    networkInterfaces: () => ({ Ethernet: [{ family: 'IPv4', address: '192.0.2.13', mac: '30:68:93:2e:83:c2', internal: false }] }),
  });
  const state = await runtime.read(item('D1', 'icmp', '192.0.2.13'));
  assert.equal(state.online, false);
  assert.equal(state.identity, 'mismatch');
  assert.equal(arpReads, 0);
});

test('a remote host continues to use ARP for MAC confirmation', async () => {
  let arpReads = 0;
  const runtime = new NetworkPresenceRuntime({
    probe: async () => true,
    readNeighbor: async () => { arpReads++; return MACS.D7; },
    networkInterfaces: () => ({ WiFi: [{ family: 'IPv4', address: '192.0.2.4', mac: MACS.D1, internal: false }] }),
  });
  const state = await runtime.read(item('D7', 'tcp', '192.0.2.5', { port: 80 }));
  assert.equal(state.online, true);
  assert.equal(state.identity, 'arp');
  assert.equal(arpReads, 1);
});

test('MAC normalization accepts separator and case variants', () => {
  assert.equal(normalizeMac('08-8a-f1-31-9e-ff'), MACS.D1);
  assert.equal(normalizeMac('F0:20:ff:04:f0:c9'), MACS.D2);
  assert.equal(normalizeMac('not-a-mac'), null);
});
