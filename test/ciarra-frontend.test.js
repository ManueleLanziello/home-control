import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { floorplanConfig } from '../public/js/floorplan-config.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('K1 mappa la CAPPA sul layer dedicato senza renderizzare l etichetta tecnica', async () => {
  const [floorplan, html] = await Promise.all([read('../public/js/floorplan.js'), read('../public/index.html')]);
  assert.equal(floorplanConfig.cappa.id, 'K1');
  assert.equal(floorplanConfig.mappings.cappa, 'LAYER-12-CAPPA.svg');
  assert.match(floorplan, /loadMapping\(config\.mappings\.cappa/);
  assert.match(floorplan, /placeHtml\(cappaMapping, config\.cappa\.marker, cappa\)/);
  assert.doesNotMatch(html, />\s*K1\s*</);
  assert.doesNotMatch(floorplan, /textContent\s*=\s*config\.cappa\.id/);
});

test('icona planimetria usa solo CAPPAON e CAPPAOFF e conserva lo stato durante indisponibilita', async () => {
  const floorplan = await read('../public/js/floorplan.js');
  assert.equal(floorplanConfig.icons.cappaOn, 'CAPPAON.svg');
  assert.equal(floorplanConfig.icons.cappaOff, 'CAPPAOFF.svg');
  assert.doesNotMatch(floorplan, /cappa\.svg/i);
  const store = createFloorplanState();
  store.applyHoodSnapshot({ online: true, power: true, fanSpeed: 3, light: 'level1', operatingStatus: 'on', updatedAt: 'now' });
  store.applyHomeSnapshot();
  assert.deepEqual(store.snapshot().hood, { online: false, power: true, fanSpeed: 3, light: 'level1', operatingStatus: 'on', updatedAt: 'now' });
});

test('popup CAPPA eredita il modal CALDAIA e offre controlli indipendenti power fan e luce', async () => {
  const [html, script, style] = await Promise.all([read('../public/index.html'), read('../public/js/dashboard.js'), read('../public/floorplan.css')]);
  assert.match(html, /class="boiler-modal cappa-modal"/);
  assert.equal((html.match(/data-cappa-fan-speed=/g) || []).length, 5);
  assert.equal((html.match(/data-cappa-light=/g) || []).length, 3);
  assert.match(html, /design\/ventola\.svg/);
  assert.match(html, /type="range"[^>]*data-cappa-fan-slider/);
  assert.match(html, /data-cappa-light="off">OFF<\/button>/);
  assert.match(script, /\/api\/hood\/power/);
  assert.match(script, /\/api\/hood\/fan-speed/);
  assert.match(script, /\/api\/hood\/light/);
  assert.match(script, /power \? 'CAPPAON\.svg' : 'CAPPAOFF\.svg'/);
  assert.match(script, /light === 'off' \? 'lampoff\.svg' : 'lampon\.svg'/);
  assert.match(script, /power \? 'poweron\.svg' : 'poweroff\.svg'/);
  assert.match(script, /power \? 'SPEGNI' : 'ACCENDI'/);
  assert.match(script, /syncCappaFanPresentation/);
  assert.doesNotMatch(script, /fanSpeed[\s\S]{0,80}\/api\/hood\/power/);
  assert.match(style, /\.boiler-modal \{ width: min\(780px/);
});
