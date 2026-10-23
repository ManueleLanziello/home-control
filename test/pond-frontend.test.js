import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPondControls, pondRoleState } from '../public/js/pond-popup.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';

const runtime = (state, age = 0, overrides = {}) => ({
  online: true,
  communicationDegraded: false,
  consecutiveFailures: 0,
  state,
  lastReadAt: new Date(Date.now() - age).toISOString(),
  ...overrides,
});
const snapshot = (revision, role, state, age = 0) => ({ revision, plugs: [{ role, runtime: runtime(state, age) }] });
const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, async json() { return body; } });

test('payload SmartHome confermato rende pompa ON e riscaldatore OFF anche senza confrontare orologi server e browser', () => {
  const controls = createPondControls();
  controls.applySnapshot({
    ownership: 'home', revision: 570, observedAt: '2026-10-23T08:19:11.335Z',
    plugs: [
      { id: 'pond-plug-pump', role: 'pump', configurationStatus: 'complete', verificationStatus: 'verified', runtime: { state: 'ON', online: true, communicationDegraded: false, consecutiveFailures: 0 } },
      { id: 'pond-plug-heater', role: 'heater', configurationStatus: 'complete', verificationStatus: 'verified', runtime: { state: 'OFF', online: true, communicationDegraded: false, consecutiveFailures: 0 } },
    ],
  });
  assert.deepEqual(pondRoleState(controls.snapshot(), 'pump'), { known: true, on: true, state: 'ON' });
  assert.deepEqual(pondRoleState(controls.snapshot(), 'heater'), { known: true, on: false, state: 'OFF' });
  assert.equal(controls.error('pump'), null); assert.equal(controls.error('heater'), null);
});

test('freschezza confronta lastReadAt e observedAt dello stesso server, non l orologio del browser', () => {
  const controls = createPondControls();
  controls.applySnapshot({
    revision: 571, observedAt: '2020-01-01T00:00:02.000Z',
    plugs: [{ role: 'pump', runtime: { state: 'ON', online: true, communicationDegraded: false, consecutiveFailures: 0, lastReadAt: '2020-01-01T00:00:01.000Z' } }],
  });
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, 'ON');
});

test('P1a e P1b recuperano uno snapshot stale prima del toggle e applicano subito il readback', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  for (const role of ['pump', 'heater']) {
    const calls = [];
    const responses = [snapshot(1, role, 'ON', 6_000), snapshot(2, role, 'ON'), { pond: snapshot(3, role, 'OFF') }];
    globalThis.fetch = async (url, options = {}) => { calls.push([String(url), options.method || 'GET']); return jsonResponse(responses.shift()); };
    const controls = createPondControls(); await controls.refresh();
    const command = controls.toggle(role);
    assert.equal(controls.pending(role), true);
    assert.deepEqual(await command, { ok: true, state: { known: true, on: false, state: 'OFF' } });
    assert.deepEqual(calls.map(([, method]) => method), ['GET', 'GET', 'PUT']);
    assert.equal(controls.error(role), null);
  }
});

test('snapshot fresco esegue direttamente il PUT e un secondo click pending non duplica il comando', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let release; const gate = new Promise(resolve => { release = resolve; }); let puts = 0;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.method === 'PUT') { puts += 1; await gate; return jsonResponse({ pond: snapshot(2, 'pump', 'OFF') }); }
    throw new Error('GET inatteso');
  };
  const controls = createPondControls(); controls.applySnapshot(snapshot(1, 'pump', 'ON'));
  const first = controls.toggle('pump');
  assert.deepEqual(await controls.toggle('pump'), { ok: false, reason: 'pending' });
  release(); assert.equal((await first).ok, true); assert.equal(puts, 1);
});

test('unknown resta unknown, usa asset neutrali e non conserva ON/OFF', async () => {
  assert.deepEqual(pondRoleState([], 'pump'), { known: false, on: false, state: null });
  const controls = createPondControls();
  controls.applySnapshot(snapshot(1, 'pump', 'ON'));
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, 'ON');
  controls.applySnapshot({ revision: 2, plugs: [{ role: 'pump', runtime: runtime('ON', 0, { online: false }) }] });
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, null);
  assert.equal(floorplanConfig.icons.pondPump, 'pump.svg');
  assert.equal(floorplanConfig.icons.pondHeater, 'heater.svg');
  assert.equal(floorplanConfig.icons.pondPumpOn, 'pumpon.svg'); assert.equal(floorplanConfig.icons.pondPumpOff, 'pumpoff.svg');
  assert.equal(floorplanConfig.icons.pondHeaterOn, 'heateron.svg'); assert.equal(floorplanConfig.icons.pondHeaterOff, 'heateroff.svg');
  const [floorplan, popup] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/pond-popup.js', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /config\.icons\.pondPump\s*:\s*config\.icons\.pondHeater/);
  assert.match(popup, /'pump\.svg'/); assert.match(popup, /'heater\.svg'/);
});

test('eventi Pond duplicati o fuori ordine non sovrascrivono lo stato più recente', () => {
  const controls = createPondControls();
  assert.equal(controls.applySnapshot(snapshot(5, 'pump', 'ON')), true);
  assert.equal(controls.applySnapshot(snapshot(5, 'pump', 'OFF')), false);
  assert.equal(controls.applySnapshot(snapshot(4, 'pump', 'OFF')), false);
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, 'ON');
  assert.equal(controls.applySnapshot(snapshot(6, 'pump', 'OFF')), true);
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, 'OFF');
});

test('errori refresh e PUT sono visibili e non inventano uno stato', async t => {
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const controls = createPondControls();
  globalThis.fetch = async () => { throw new Error('offline'); };
  const refreshFailure = await controls.toggle('pump');
  assert.equal(refreshFailure.ok, false); assert.equal(controls.error('pump'), 'Impossibile recuperare lo stato della presa');
  controls.applySnapshot(snapshot(1, 'pump', 'OFF'));
  globalThis.fetch = async () => jsonResponse({ error: 'Comando non confermato' }, { ok: false, status: 409 });
  const commandFailure = await controls.toggle('pump');
  assert.equal(commandFailure.ok, false); assert.equal(controls.error('pump'), 'Comando non confermato');
  assert.equal(pondRoleState(controls.snapshot(), 'pump').state, 'OFF');
});

test('dashboard Pond usa SSE e non dipende più dal refresh generale a 30 secondi', async () => {
  const [floorplan, dashboard] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/dashboard.js', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /new EventSource\(homeControlPath\('\/api\/pond\/events'\)\)/);
  assert.match(floorplan, /pondControls\.applySnapshot\(JSON\.parse\(event\.data\)\)/);
  assert.doesNotMatch(dashboard, /refreshPondStatus/);
});
