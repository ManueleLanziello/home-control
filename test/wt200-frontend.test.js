import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { displayedThermostatSetpoint, shouldAcceptThermostatStatus, shouldDeferScheduleSnapshot } from '../public/js/thermostat.js';
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

test('setpoint ottimistico applica lo snapshot confermato e scarta status precedenti', async () => {
  const dashboard = await readFile(dashboardScriptPath, 'utf8');
  assert.match(dashboard, /setpointDraft = temperature;\s*setpointSaving = true/);
  assert.match(dashboard, /boilerSnapshot = result\.snapshot/);
  assert.match(dashboard, /shouldAcceptThermostatStatus\(\{ saving: setpointSaving \|\| modeSaving, requestedRevision: requestedThermostatRevision, currentRevision: thermostatRevision \}\)/);
  assert.match(dashboard, /acceptThermostat \? home : \{ \.\.\.home, thermostat: boilerSnapshot \}/);
  assert.match(dashboard, /boilerSnapshot = error\.snapshot \|\| previousSnapshot/);
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
  let draft = 22;
  const command = runtime.setSetpointTemperature(22);
  await waiting;
  assert.equal(displayedThermostatSetpoint(uiSnapshot, draft), 22);
  assert.equal(shouldAcceptThermostatStatus({ saving: true, requestedRevision: 0, currentRevision: 1 }), false);
  releaseFirstRetry();

  uiSnapshot = await command;
  draft = null;
  assert.equal(uiSnapshot.rawDps['2'], 220);
  assert.equal(displayedThermostatSetpoint(uiSnapshot, draft), 22);
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
  assert.equal(shouldAcceptThermostatStatus({ saving: true, requestedRevision: 0, currentRevision: 1 }), false);
  assert.equal(displayedThermostatSetpoint(manual, null), 20);
  const confirmed = await runtime.setMode('auto');
  assert.equal(confirmed.thermostat.mode, 'auto');
  assert.equal(displayedThermostatSetpoint(confirmed, null), 22);
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
  assert.equal(shouldAcceptThermostatStatus({ saving: true, requestedRevision: 1, currentRevision: 2 }), false);
  assert.equal(displayedThermostatSetpoint(automatic, null), 22);
  const confirmed = await runtime.setMode('manual');
  assert.equal(confirmed.thermostat.mode, 'manual');
  assert.equal(displayedThermostatSetpoint(confirmed, null), 19);
  assert.equal(confirmed.thermostat.currentTemperature, 20);
  assert.equal(confirmed.heatingActive, false);
});
