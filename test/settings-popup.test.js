import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dashboardHtmlPath = new URL('../public/index.html', import.meta.url);
const dashboardScriptPath = new URL('../public/js/dashboard.js', import.meta.url);
const settingsHtmlPath = new URL('../public/settings.html', import.meta.url);
const settingsScriptPath = new URL('../public/settings.js', import.meta.url);
const floorplanStylePath = new URL('../public/floorplan.css', import.meta.url);

test('il comando Impostazioni della dashboard apre un dialog e riusa la route settings', async () => {
  const [html, dashboard, style] = await Promise.all([
    readFile(dashboardHtmlPath, 'utf8'),
    readFile(dashboardScriptPath, 'utf8'),
    readFile(floorplanStylePath, 'utf8'),
  ]);
  assert.match(html, /<dialog class="settings-modal"[^>]*data-settings-modal>/);
  assert.match(html, /data-settings-modal-close[^>]*aria-label="Chiudi popup Impostazioni"/);
  assert.match(html, /data-settings-modal-close[^>]*><img src="design\/close\.svg"/);
  assert.match(html, /data-settings-modal-content/);
  assert.match(dashboard, /fetch\(homeControlPath\('\/settings'\), \{ cache: 'no-store' \}\)/);
  assert.match(dashboard, /document\.importNode\(settingsContent, true\)/);
  assert.match(dashboard, /initSettings\(content\.querySelector\('\[data-settings-content\]'\)\)/);
  assert.match(dashboard, /trigger = event\.target\.closest\('\.floorplan-integration-options'\)/);
  assert.match(dashboard, /event\.preventDefault\(\);\s*void open\(\);/);
  assert.match(style, /\.settings-modal \{[^}]*max-height: calc\(100dvh - 24px\)/);
  assert.match(style, /\.settings-modal-content \{[^}]*overflow-y: auto/);
});

test('la route impostazioni conserva prese e telecamere, senza pannelli Dewin o diagnostica', async () => {
  const [html, script] = await Promise.all([
    readFile(settingsHtmlPath, 'utf8'),
    readFile(settingsScriptPath, 'utf8'),
  ]);
  assert.match(html, /data-settings-content/);
  assert.match(html, /id="pond-plug-form"/);
  assert.match(html, /id="camera-form"/);
  assert.doesNotMatch(html, /Sensori Dewin|DIAGNOSTICA|home-diagnostics|id="sensor-form"/);
  assert.match(script, /export function initSettings\(root = document\)/);
  assert.match(script, /dataset\.settingsInitialized === 'true'/);
  assert.match(script, /\/api\/hardware\/pond-plugs/);
  assert.match(script, /\/api\/hardware\/cameras/);
  assert.doesNotMatch(script, /\/api\/hardware\/sensors|\/api\/device-roles|loadDiagnostics/);
});
