import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  beginModeRequest,
  beginSetpointInteraction,
  beginSetpointRequest,
  createThermostatMutationState,
  displayedThermostatSetpoint,
  finishThermostatRequest,
  isCurrentThermostatRequest,
  mergeThermostatRefreshSnapshot,
  runHeatingFastFollow,
  shouldAcceptThermostatStatus,
  shouldDeferScheduleSnapshot,
} from '../public/js/thermostat.js';
import { HomeWt200Runtime } from '../src/wt200-runtime.js';

const htmlPath = new URL('../public/thermostat.html', import.meta.url);
const scriptPath = new URL('../public/js/thermostat.js', import.meta.url);
const dashboardHtmlPath = new URL('../public/index.html', import.meta.url);
const dashboardScriptPath = new URL('../public/js/dashboard.js', import.meta.url);
const floorplanScriptPath = new URL('../public/js/floorplan.js', import.meta.url);
const stylePath = new URL('../public/style.css', import.meta.url);

test('popup CALDAIA espone soltanto i tre week pattern consentiti', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const values = [...html.matchAll(/data-week-pattern="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['5+2', '6+1', '7']);
  assert.doesNotMatch(html, /data-week-pattern="(?:0|Chiuso)"/);
});

test('frontend cambia modalita con endpoint specifico, blocca concorrenza e riallinea lo schedule confermato', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /if \(!draft \|\| saving \|\| weekPattern === draft\.weekPattern\) return/);
  assert.match(script, /\/api\/thermostat\/week-pattern/);
  assert.match(script, /draft = cloneSchedule\(result\.schedule\)/);
  assert.match(script, /button\.disabled = saving \|\| !draft/);
});

test('frontend nasconde il gruppo inattivo in 7 e invia payload schedule specifico', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /weekPattern === '7'.*rest: null/);
  assert.match(script, /draft\.weekPattern === '7' \? \{\} : \{ restDayPeriods: draft\.restDayPeriods \}/);
});

test('snapshot durante editing viene differito, poi puo riallinearsi al dato confermato', () => {
  assert.equal(shouldDeferScheduleSnapshot({ saving: false, scheduleEditing: true, hasChanges: false }), true);
  assert.equal(shouldDeferScheduleSnapshot({ saving: false, scheduleEditing: false, hasChanges: true }), true);
  assert.equal(shouldDeferScheduleSnapshot({ saving: false, scheduleEditing: false, hasChanges: false }), false);
});

test('editing delle celle non ricrea gli input e protegge il rendering schedule dal polling', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /scheduleForm\?\.addEventListener\('focusin'/);
  assert.match(script, /scheduleForm\?\.addEventListener\('focusout'/);
  assert.match(script, /pendingSnapshot = next;\s*renderThermostat\(next, \{ renderSchedule: false \}\)/);
  assert.match(script, /scheduleForm\?\.addEventListener\('input'[\s\S]*?updateEditorControls\(\);\s*}\);/);
  assert.doesNotMatch(script.match(/scheduleForm\?\.addEventListener\('input'[\s\S]*?\n  }\);/)?.[0] || '', /render(?:Draft|Editor)\(/);
});

test('dashboard CALDAIA usa il nuovo set icone e QD1 resta sincronizzata allo stato esistente', async () => {
  const [html, dashboard, floorplan, style] = await Promise.all([
    readFile(dashboardHtmlPath, 'utf8'),
    readFile(dashboardScriptPath, 'utf8'),
    readFile(floorplanScriptPath, 'utf8'),
    readFile(stylePath, 'utf8'),
  ]);
  for (const icon of ['close', 'boiler', 'manual', 'auto', 'smart', 'prog', 'nofire']) assert.match(html, new RegExp(`design/${icon}\\.svg`));
  assert.equal((html.match(/class="boiler-tile-icon"/g) || []).length, 0);
  assert.match(dashboard, /heatingActive === true \? 'fire\.svg' : 'nofire\.svg'/);
  assert.match(floorplan, /boiler\.on === true \? 'fire\.svg' : 'nofire\.svg'/);
  assert.match(floorplan, /modeKey.*manual.*auto.*smart/);
  assert.match(floorplan, /container\.replaceChildren\(indicator, modeIcon\)/);
  assert.match(floorplan, /assetUrl\('option\.svg'\)/);
  assert.match(floorplan, /settings\.append\(settingsIcon\)/);
  assert.doesNotMatch(floorplan, /settings\.textContent/);
  assert.match(floorplan, /event\.stopPropagation\(\)/);
  assert.match(style, /height: clamp\(252px, 30\.8vw, 294px\)/);
});

test('setpoint usa un solo transaction state e scarta status appartenenti a revisioni precedenti', async () => {
  const dashboard = await readFile(dashboardScriptPath, 'utf8');
  assert.match(dashboard, /thermostatMutation = beginSetpointInteraction\(thermostatMutation, temperature\)/);
  assert.match(dashboard, /thermostatMutation = beginSetpointRequest\(thermostatMutation\)/);
  assert.match(dashboard, /boilerSnapshot = mergeConfirmedThermostatSnapshot\(boilerSnapshot, result\.snapshot\)/);
  assert.match(dashboard, /isCurrentThermostatRequest\(thermostatMutation, requestId, 'setpoint'\)/);
  assert.doesNotMatch(dashboard, /setpointDraft|setpointSaving|modeSaving/);
});

test('DP2 55 dopo write 220 non ripristina la UI e il successivo DP2 220 conferma 22 gradi', async () => {
  const oldSnapshot = { updatedAt: '2026-09-15T10:00:00.000Z', heatingActive: false,
    thermostat: { currentTemperature: 20, setpointTemperature: 5.5, mode: 'manual' }, rawDps: { 2: 55, 3: 200, 4: 'home', 5: '0' } };
  const confirmedSnapshot = { updatedAt: '2026-09-15T10:00:01.000Z', heatingActive: true,
    thermostat: { currentTemperature: 20, setpointTemperature: 22, mode: 'manual' }, rawDps: { 2: 220, 3: 200, 4: 'home', 5: '1' } };
  let releaseFirstRetry;
  let signalFirstRetry;
  let waiting = new Promise(resolve => { signalFirstRetry = resolve; });
  const runtime = new HomeWt200Runtime({
    lanAdapter: {
      async setSetpointTemperature(value) { assert.equal(value, 22); },
      async read() { return this.firstRead ? confirmedSnapshot : (this.firstRead = true, oldSnapshot); },
    },
    postWriteReadbackAttempts: 4,
    postWriteReadbackDelayMs: 0,
    wait: async () => {
      if (!releaseFirstRetry) {
        await new Promise(resolve => { releaseFirstRetry = resolve; signalFirstRetry(); });
      }
    },
  });

  let uiSnapshot = oldSnapshot;
  let transaction = beginSetpointInteraction(createThermostatMutationState(), 22);
  transaction = beginSetpointRequest(transaction);
  const command = runtime.setSetpointTemperature(22);
  await waiting;
  assert.equal(displayedThermostatSetpoint(uiSnapshot, transaction), 22);
  assert.equal(shouldAcceptThermostatStatus({ requestedRevision: 0, currentRevision: transaction.revision }), false);
  releaseFirstRetry();

  uiSnapshot = await command;
  transaction = finishThermostatRequest(transaction, transaction.requestId, 'setpoint');
  assert.equal(uiSnapshot.rawDps['2'], 220);
  assert.equal(displayedThermostatSetpoint(uiSnapshot, transaction), 22);
  assert.equal(uiSnapshot.heatingActive, true);
});

test('transizione UI MANUALE verso AUTO mantiene i dati e applica il DP2 programmato dopo DP4 auto', async () => {
  const manual = { updatedAt: '2026-09-15T10:00:00.000Z', heatingActive: false,
    thermostat: { currentTemperature: 20, setpointTemperature: 20, mode: 'manual' } };
  const automatic = { updatedAt: '2026-09-15T10:00:01.000Z', heatingActive: true,
    thermostat: { currentTemperature: 20.5, setpointTemperature: 22, mode: 'auto' } };
  const snapshots = [manual, automatic, automatic, automatic];
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setOperatingMode(value) { assert.equal(value, 'auto'); }, async read() { return snapshots.shift(); } },
    postWriteReadbackAttempts: 4, postWriteReadbackDelayMs: 0, wait: async () => {},
  });
  assert.equal(shouldAcceptThermostatStatus({ requestedRevision: 0, currentRevision: 1 }), false);
  assert.equal(displayedThermostatSetpoint(manual, createThermostatMutationState()), 20);
  const confirmed = await runtime.setMode('auto');
  assert.equal(confirmed.thermostat.mode, 'auto');
  assert.equal(displayedThermostatSetpoint(confirmed, createThermostatMutationState()), 22);
  assert.equal(confirmed.thermostat.currentTemperature, 20.5);
  assert.equal(confirmed.heatingActive, true);
});

test('transizione UI AUTO verso MANUALE mantiene i dati e applica il DP2 manuale dopo DP4 home', async () => {
  const automatic = { updatedAt: '2026-09-15T10:00:00.000Z', heatingActive: true,
    thermostat: { currentTemperature: 20.5, setpointTemperature: 22, mode: 'auto' } };
  const manual = { updatedAt: '2026-09-15T10:00:01.000Z', heatingActive: false,
    thermostat: { currentTemperature: 20, setpointTemperature: 19, mode: 'manual' } };
  const snapshots = [automatic, manual, manual, manual];
  const runtime = new HomeWt200Runtime({
    lanAdapter: { async setOperatingMode(value) { assert.equal(value, 'home'); }, async read() { return snapshots.shift(); } },
    postWriteReadbackAttempts: 4, postWriteReadbackDelayMs: 0, wait: async () => {},
  });
  assert.equal(shouldAcceptThermostatStatus({ requestedRevision: 1, currentRevision: 2 }), false);
  assert.equal(displayedThermostatSetpoint(automatic, createThermostatMutationState()), 22);
  const confirmed = await runtime.setMode('manual');
  assert.equal(confirmed.thermostat.mode, 'manual');
  assert.equal(displayedThermostatSetpoint(confirmed, createThermostatMutationState()), 19);
  assert.equal(confirmed.thermostat.currentTemperature, 20);
  assert.equal(confirmed.heatingActive, false);
});

test('dragging e pending mantengono requestedValue contro snapshot polling con DP2 vecchio', () => {
  const staleSnapshot = { thermostat: { setpointTemperature: 5.5, currentTemperature: 25.9, mode: 'manual' }, heatingActive: false };
  let transaction = beginSetpointInteraction(createThermostatMutationState(), 22);
  assert.equal(transaction.phase, 'dragging');
  assert.equal(displayedThermostatSetpoint(staleSnapshot, transaction), 22);
  transaction = beginSetpointRequest(transaction);
  assert.equal(transaction.phase, 'pending');
  assert.equal(displayedThermostatSetpoint(staleSnapshot, transaction), 22);
});

test('una risposta DP2 precedente non puo chiudere o rollbackare la richiesta corrente', () => {
  let first = beginSetpointRequest(beginSetpointInteraction(createThermostatMutationState(), 21));
  first = finishThermostatRequest(first, first.requestId, 'setpoint');
  let current = beginSetpointRequest(beginSetpointInteraction(first, 22));
  const currentId = current.requestId;
  assert.equal(isCurrentThermostatRequest(current, currentId - 1, 'setpoint'), false);
  current = finishThermostatRequest(current, currentId - 1, 'setpoint');
  assert.equal(current.phase, 'pending');
  assert.equal(current.requestId, currentId);
  assert.equal(displayedThermostatSetpoint({ thermostat: { setpointTemperature: 21 } }, current), 22);
});

test('ownership impedisce in modo simmetrico la sovrapposizione DP2 e DP4', () => {
  const dragging = beginSetpointInteraction(createThermostatMutationState(), 22);
  assert.equal(beginModeRequest(dragging), null);
  const modePending = beginModeRequest(createThermostatMutationState());
  assert.equal(beginSetpointInteraction(modePending, 22), modePending);
});

test('molti input conservano l ultimo valore e il dashboard invia un solo write al change', async () => {
  let transaction = createThermostatMutationState();
  for (const value of [20, 20.5, 21, 21.5, 22]) transaction = beginSetpointInteraction(transaction, value);
  transaction = beginSetpointRequest(transaction);
  assert.equal(transaction.requestedValue, 22);
  assert.equal(transaction.requestId, 1);

  const dashboard = await readFile(dashboardScriptPath, 'utf8');
  assert.equal((dashboard.match(/addEventListener\('input', previewSetpoint\)/g) || []).length, 1);
  assert.equal((dashboard.match(/addEventListener\('change', \(\) => void saveSetpoint\(\)\)/g) || []).length, 1);
  const previewBody = dashboard.match(/function previewSetpoint\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(previewBody, /fetch\(/);
});

test('fast-follow applica DP5 reale appena cambia e poi termina', async () => {
  const snapshots = [
    { heatingActive: false, thermostat: { setpointTemperature: 22, currentTemperature: 25.9, mode: 'manual' } },
    { heatingActive: true, thermostat: { setpointTemperature: 22, currentTemperature: 26, mode: 'manual' } },
  ];
  const applied = [];
  let clock = 0;
  const result = await runHeatingFastFollow({
    previousHeatingActive: false,
    readSnapshot: async () => snapshots.shift(),
    applySnapshot: snapshot => applied.push(snapshot),
    durationMs: 5_000,
    intervalMs: 450,
    now: () => clock,
    wait: async delay => { clock += delay; },
  });
  assert.equal(result.changed, true);
  assert.equal(applied.length, 2);
  assert.equal(applied.at(-1).heatingActive, true);
});

test('fast-follow termina normalmente se DP5 reale non cambia nella finestra', async () => {
  let clock = 0;
  let reads = 0;
  const result = await runHeatingFastFollow({
    previousHeatingActive: false,
    readSnapshot: async () => (reads += 1, { heatingActive: false, thermostat: { setpointTemperature: 22 } }),
    applySnapshot() {},
    durationMs: 1_000,
    intervalMs: 400,
    now: () => clock,
    wait: async delay => { clock += delay; },
  });
  assert.equal(result.changed, false);
  assert.equal(reads, 3);
});

test('fast-follow e refresh durante dragging o pending non modificano il DP2 visualizzato', () => {
  const current = { heatingActive: false, thermostat: { setpointTemperature: 20, currentTemperature: 25.9, mode: 'manual' } };
  const incoming = { heatingActive: true, thermostat: { setpointTemperature: 5.5, currentTemperature: 26, mode: 'manual' } };
  const dragging = beginSetpointInteraction(createThermostatMutationState(), 22);
  const pending = beginSetpointRequest(dragging);

  const duringDrag = mergeThermostatRefreshSnapshot(current, incoming, { mutation: dragging });
  const duringPending = mergeThermostatRefreshSnapshot(current, incoming, { mutation: pending });
  const fastFollow = mergeThermostatRefreshSnapshot(current, incoming, { mutation: createThermostatMutationState(), preserveSetpoint: true });
  for (const snapshot of [duringDrag, duringPending, fastFollow]) {
    assert.equal(snapshot.thermostat.setpointTemperature, 20);
    assert.equal(snapshot.thermostat.currentTemperature, 26);
    assert.equal(snapshot.heatingActive, true);
  }
  assert.equal(displayedThermostatSetpoint(duringDrag, dragging), 22);
  assert.equal(displayedThermostatSetpoint(duringPending, pending), 22);
  assert.equal(fastFollow.thermostat.setpointTemperature, 20);
});

test('refresh WT200 in idle applica DP2 DP3 DP4 DP5 reali', () => {
  const current = { heatingActive: false, thermostat: { setpointTemperature: 20, currentTemperature: 25.9, mode: 'manual' } };
  const incoming = { heatingActive: true, thermostat: { setpointTemperature: 22, currentTemperature: 26, mode: 'auto' } };
  const refreshed = mergeThermostatRefreshSnapshot(current, incoming, { mutation: createThermostatMutationState() });
  assert.deepEqual(refreshed, incoming);
});

test('evento DP5 parziale conserva DP2 DP3 e DP4 gia validi', () => {
  const current = { online: true, heatingActive: false, thermostat: { setpointTemperature: 22, currentTemperature: 25.9, mode: 'manual' } };
  const eventSnapshot = { online: true, heatingActive: true, thermostat: { setpointTemperature: null, currentTemperature: null, mode: null } };
  const merged = mergeThermostatRefreshSnapshot(current, eventSnapshot, {
    mutation: createThermostatMutationState(), preserveSetpoint: true, preserveMissing: true,
  });
  assert.deepEqual(merged.thermostat, current.thermostat);
  assert.equal(merged.heatingActive, true);
});

test('refresh WT200 dedicato resta a 5 secondi e polling generale resta a 30 secondi', async () => {
  const dashboard = await readFile(dashboardScriptPath, 'utf8');
  assert.match(dashboard, /THERMOSTAT_REFRESH_MS = 5_000/);
  assert.match(dashboard, /setTimeout\(loadThermostatSnapshot, THERMOSTAT_REFRESH_MS\)/);
  assert.match(dashboard, /setTimeout\(loadHomeSnapshot, 30_000\)/);
  assert.match(dashboard, /\/api\/thermostat\/live/);
  assert.match(dashboard, /\/api\/thermostat\/events/);
});
