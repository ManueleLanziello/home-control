import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { floorplanConfig } from '../public/js/floorplan-config.js';
import { createFloorplanState } from '../public/js/floorplan-state.js';
import { createHomeControlServer } from '../server.js';
import { validateHardwareRegistry } from '../src/hardware-registry.js';
import { normalizeMobilePresence } from '../src/home-status.js';

globalThis.window = { addEventListener() {} };
const { cameraBatteryIcon, renderCameraIcon, shapeForLabel, humidityReadingColor, renderFloorplanReading, sensorReadingFontSize, sensorTemperatureAlertState, sensorVisualState, showPermanentLayers, temperatureReadingColor } = await import('../public/js/floorplan.js');
const { mobileDeviceIcon } = await import('../public/js/floorplan.js');

test('DM personal icons survive registry/Home normalization with unchanged presence and type fallbacks', async () => {
  const registry = validateHardwareRegistry(JSON.parse(await readFile(new URL('../data/config/hardware.json', import.meta.url), 'utf8')));
  const expected = { 'MOBILE-GINEVRA': 'gine.svg', 'MOBILE-TABLET-A8': 'remo.svg', 'MOBILE-MELANIA': 'mela.svg', 'MOBILE-MANU': 'manu.svg', 'MOBILE-ALBA': 'alba.svg' };
  const presence = Object.fromEntries(Object.keys(expected).map(id => [id, { state: 'present', visible: true, lastConfirmedAt: '2026-09-28T00:00:00Z' }]));
  const mobiles = normalizeMobilePresence(registry.inventory, presence);
  assert.equal(mobiles.length, 5);
  for (const mobile of mobiles) {
    assert.equal(mobile.icon, expected[mobile.id]);
    assert.equal(mobileDeviceIcon({ ...mobile, alias: 'Changed alias' }), expected[mobile.id]);
    assert.equal(mobile.visible, true); assert.equal(mobile.presence, 'present');
    assert.match(await readFile(new URL(`../design/${mobile.icon}`, import.meta.url), 'utf8'), /<svg/);
  }
  assert.equal(mobileDeviceIcon({ type: 'phone' }), 'phone.svg');
  assert.equal(mobileDeviceIcon({ type: 'tablet' }), 'tablet.svg');
});

async function labelsIn(file) {
  const source = await readFile(new URL(`../design/${file}`, import.meta.url), 'utf8');
  const labels = [...source.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(([, text]) => text.trim());
  return { source, labels };
}

function includesLabel(labels, label) {
  return labels.some((part, index) => {
    let text = '';
    for (let next = index; next < labels.length && label.startsWith(text); next += 1) {
      text += labels[next];
      if (text === label) return true;
    }
    return false;
  });
}

test('S5 uses the dedicated LS25 water-temperature marker and no removed humidity markers', async () => {
  const svg = (await labelsIn('LAYER-08-SENSORI.svg')).source;
  const source = markerSourceFromSvg(svg);
  const s5 = floorplanConfig.sensors.find(sensor => sensor.id === 'S5');
  assert.equal(s5.reading.label, 'LS25'); assert.equal(s5.humidityReading, null);
  assert.equal(shapeForLabel(source, 'LS25')?.localName, 'rect');
  assert.equal(includesLabel((await labelsIn('LAYER-08-SENSORI.svg')).labels, 'LS5'), false);
  assert.equal(includesLabel((await labelsIn('LAYER-08-SENSORI.svg')).labels, 'LU5'), false);
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /sensorMapping\.box\(sensor\.probeReading\)/);
  assert.match(floorplan, /renderFloorplanReading\(probeReading, probe, '°C', temperatureReadingColor\(probe\)\)/);
  assert.match(floorplan, /renderFloorplanReading\(humidityReading, humidity, '%', humidityReadingColor\(humidity\)\)/);
  assert.match(floorplan, /probe\.dataset\.sensorProbeReading = sensor\.id/);
});

function markerSource(parts) {
  const nodes = parts.map(([localName, textContent = '']) => ({ localName, textContent }));
  for (const [index, node] of nodes.entries()) {
    node.previousElementSibling = nodes[index - 1] || null;
    node.nextElementSibling = nodes[index + 1] || null;
  }
  return { nodes, querySelectorAll: selector => nodes.filter(node => node.localName === selector) };
}

function markerSourceFromSvg(svg) {
  const parts = [...svg.matchAll(/<(path|rect)\b[^>]*\/>|<text\b[^>]*>([^<]*)<\/text>/g)]
    .map(([, shape, text]) => shape ? [shape] : ['text', text.trim()]);
  return markerSource(parts);
}

function labelStart(nodes, label) {
  for (const node of nodes) {
    if (node.localName !== 'text') continue;
    let text = '';
    for (let current = node; current?.localName === 'text'; current = current.nextElementSibling) {
      text += current.textContent;
      if (text === label) return node;
      if (!label.startsWith(text)) break;
    }
  }
  return null;
}

test('mapping SVG aggiornati usano label semantiche, non geometrie fragili', async () => {
  const [lights, sensors, boiler, weather, clock, devices] = await Promise.all(['LAYER-07-LUCI.svg', 'LAYER-08-SENSORI.svg', 'LAYER-10-CALDAIA.svg', 'LAYER-13-METEO.svg', 'LAYER-22-OROLOGIO.svg', 'LAYER-DISPOSITIVI.svg'].map(labelsIn));
  for (const id of ['L1', 'L2', 'L3', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']) assert.equal(includesLabel(lights.labels, id), true, id);
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'LS1', 'LS2', 'LS3', 'LS4', 'LS25']) assert.equal(includesLabel(sensors.labels, id), true, id);
  for (const id of ['D1', 'QD1']) assert.equal(includesLabel(boiler.labels, id), true, id);
  for (const id of ['M1', 'QM1', 'LM1']) assert.equal(includesLabel(weather.labels, id), true, id);
  assert.equal(includesLabel(clock.labels, 'CLK1'), true);
  assert.equal(includesLabel(devices.labels, 'DM'), true);
  assert.deepEqual(floorplanConfig.lights.map(light => light.id), ['L1', 'L2', 'L3', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']);
  assert.deepEqual(floorplanConfig.rooms.map(room => room.lightId), ['L1', 'L2', 'L3', 'L5', 'L6', 'L13', 'L7']);
  assert.deepEqual(floorplanConfig.lights.filter(light => light.localOnly).map(light => light.id), ['L9', 'L10', 'L13']);
  assert.deepEqual(floorplanConfig.sensors.map(sensor => [sensor.reading.label, sensor.humidityReading?.label || null]), [['LS1', 'LU1'], ['LS2', 'LU2'], ['LS3', null], ['LS4', 'LU4'], ['LS25', null]]);
  for (const marker of [...floorplanConfig.lights, ...floorplanConfig.sensors].map(item => item.marker).concat(floorplanConfig.boiler.marker, floorplanConfig.boiler.card, floorplanConfig.weather.marker, floorplanConfig.weather.card, floorplanConfig.weather.currentCard, floorplanConfig.clock.marker)) assert.ok(marker.label);
  assert.deepEqual(floorplanConfig.mobileMonitor, { marker: { label: 'DM' }, icons: { phone: 'phone.svg', tablet: 'tablet.svg' } });
});

test('L7 usa soltanto il nuovo layer ON; L8, L11 e L12 sono Zigbee, L9/L10/L13 restano locali', () => {
  const store = createFloorplanState();
  store.applyHomeSnapshot({ lights: { L1: { source: 'simulation', state: false } } });

  store.setLight('L1', true);
  store.setLight('L9', true);
  store.setLight('L13', true);
  const state = store.snapshot();

  assert.equal(state.lights.L1, true);
  assert.equal(state.lights.L9, true);
  assert.equal(state.lightSources.L9, 'simulation');
  assert.equal(state.lights.L13, true);
  assert.equal(state.lightSources.L13, 'simulation');
  assert.equal(state.lightSources.L8, 'unavailable');
  assert.equal(state.lightSources.L11, 'unavailable');
  assert.equal(state.lightSources.L12, 'unavailable');
  assert.equal(floorplanConfig.rooms.some(room => room.lightId === 'L8'), false);
  assert.equal(floorplanConfig.rooms.some(room => room.lightId === 'L12'), false);
  assert.deepEqual(floorplanConfig.rooms.at(-1), { lightId: 'L7', on: 'LAYER-L7-ON.svg', optional: true });
  assert.equal(floorplanConfig.rooms.at(-1).off, undefined);
});

test('DM resta un contenitore fisso e usa esclusivamente le righe mobile configurate', async () => {
  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /placeHtml\(deviceMapping, config\.mobileMonitor\.marker, mobileMonitor\)/);
  assert.match(floorplan, /mobileMonitor\.replaceChildren\(\)/);
  assert.match(floorplan, /mobile\.visible !== true \|\| mobile\.presence === 'absent'/);
  assert.match(css, /\.floorplan-mobile-monitor \{[^}]*container-type: size;[^}]*width: 100%; height: 100%;/);
  assert.match(css, /\.floorplan-mobile-monitor-row \{[^}]*flex: 0 0 17%;/);
  assert.match(css, /\.floorplan-mobile-monitor-row img \{[^}]*width: 19%; height: 90%;/);
  assert.match(css, /\.floorplan-mobile-monitor-row span \{[^}]*5\.5cqh/);
});

test('L8-L12 usano overlay full-plan indipendenti e conservano lo stato attraverso il cambio base', () => {
  assert.deepEqual(floorplanConfig.externalLightOverlays, {
    L8: 'LAYER-L8-ON.svg', L9: 'LAYER-L9-ON.svg', L10: 'LAYER-L10-ON.svg', L11: 'LAYER-L11-ON.svg', L12: 'LAYER-L12-ON.svg',
  });
  const store = createFloorplanState();
  store.applyHomeSnapshot({ lights: { L8: { source: 'zigbee', available: true, state: 'ON' }, L11: { source: 'zigbee', available: true, state: 'ON' } } });
  store.setLight('L10', true);
  const beforeBaseChange = store.snapshot().lights;
  assert.deepEqual(beforeBaseChange, { L1: null, L2: null, L3: null, L5: null, L6: null, L7: null, L8: true, L9: false, L10: true, L11: true, L12: null, L13: false });
  assert.deepEqual(store.snapshot().lights, beforeBaseChange);
});

test('L3 e L13 usano layer reali mutuamente esclusivi, mentre L4 resta OFF permanente', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.deepEqual(floorplanConfig.permanentLightLayers, ['LAYER-04-OFF.svg']);
  assert.doesNotMatch(floorplanConfig.permanentLightLayers.join(' '), /LAYER-03-(?:ON|OFF)/);
  assert.ok(floorplanConfig.lights.some(light => light.id === 'L3' && light.room === 'SALOTTO'));
  assert.ok(floorplanConfig.rooms.some(room => room.lightId === 'L3' && room.on === 'LAYER-03-ON.svg' && room.off === 'LAYER-03-OFF.svg'));
  assert.ok(floorplanConfig.lights.some(light => light.id === 'L13' && light.localOnly === true));
  assert.ok(floorplanConfig.rooms.some(room => room.lightId === 'L13' && room.on === 'LAYER-13-ON.svg' && room.off === 'LAYER-13-OFF.svg'));
  assert.doesNotMatch(floorplanConfig.lights.map(light => light.id).join(' '), /\bL4\b/);
  assert.match(floorplan, /\.\.\.config\.permanentLightLayers/);
  const layers = new Map(floorplanConfig.permanentLightLayers.map(name => [name, { hidden: true }]));
  showPermanentLayers(layers, floorplanConfig.permanentLightLayers);
  assert.deepEqual([...layers.values()].map(layer => layer.hidden), [false]);
  for (const layer of layers.values()) layer.hidden = true;
  showPermanentLayers(layers, floorplanConfig.permanentLightLayers);
  assert.deepEqual([...layers.values()].map(layer => layer.hidden), [false]);
  assert.match(floorplan, /const render = state => \{\s*showPermanentLayers\(imageLayers, config\.permanentLightLayers\);/);
  assert.match(floorplan, /imageLayers\.get\(room\.on\)\.hidden = !on/);
  assert.match(floorplan, /imageLayers\.get\(room\.off\)\.hidden = on \|\| state\.lights\[room\.lightId\] === null/);
  const store = createFloorplanState();
  store.applyHomeSnapshot({ lights: { L3: { source: 'zigbee', available: true, state: 'OFF' } } });
  assert.equal(store.snapshot().lights.L3, false);
  assert.equal(store.snapshot().lightSources.L3, 'zigbee');
  store.applyHomeSnapshot({ lights: { L3: { source: 'zigbee', available: true, state: 'ON' } } });
  assert.equal(store.snapshot().lights.L3, true);
  store.applyHomeSnapshot({ lights: { L3: { source: 'zigbee', available: false, state: null } } });
  assert.equal(store.snapshot().lights.L3, null);
  assert.equal(store.snapshot().lights.L13, false);
  assert.equal(store.snapshot().lightSources.L13, 'simulation');
  store.setLight('L13', true);
  assert.equal(store.snapshot().lights.L13, true);
  store.setLight('L13', false);
  assert.equal(store.snapshot().lights.L13, false);
});

test('gli overlay L8-L12 sono serviti come SVG e il bootstrap li tratta come grafica opzionale non interattiva', async () => {
  const server = createHomeControlServer({ weatherService: { async getSnapshot() { return {}; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of Object.values(floorplanConfig.externalLightOverlays)) {
      const response = await fetch(`${base}/design/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    }
  } finally {
    server.close(); await once(server, 'close');
  }
  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  const requiredLine = floorplan.match(/const required = [^\n]+/)[0];
  assert.doesNotMatch(requiredLine, /externalLightOverlays/);
  assert.match(floorplan, /externalOverlayNames = new Map\(Object\.entries\(config\.externalLightOverlays\)/);
  assert.match(floorplan, /image\.classList\.add\('floorplan-external-light-overlay'\)/);
  assert.match(floorplan, /if \(externalLightId && !assets\.has\(name\)\)/);
  assert.match(floorplan, /if \(externalLightId\) \{\s*console\.warn\('Overlay luce esterna non caricabile: ' \+ name\);\s*resolve\(\);/);
  assert.match(floorplan, /for \(const \[lightId, name\] of Object\.entries\(config\.externalLightOverlays\)\) \{\s*if \(imageLayers\.has\(name\)\) imageLayers\.get\(name\)\.hidden = state\.lights\[lightId\] !== true;/);
  assert.match(floorplan, /for \(const \[key, name\] of Object\.entries\(config\.backgrounds\)\) imageLayers\.get\(name\)\.hidden = key !== activeBackground/);
  assert.match(css, /\.floorplan-external-light-overlay \{ pointer-events: none; \}/);
});

test('il resolver associa correttamente marker e label anche quando le label sono raggruppate', () => {
  const source = markerSource([
    ['path'], ['path'], ['path'], ['path'],
    ['text', 'L1'], ['text', 'L2'], ['text', 'L5'], ['text', 'L6'],
    ['path'], ['text', 'L'], ['text', '1'], ['text', '1'],
  ]);
  const paths = source.querySelectorAll('path');
  assert.equal(shapeForLabel(source, 'L1'), paths[0]);
  assert.equal(shapeForLabel(source, 'L6'), paths[3]);
  assert.equal(shapeForLabel(source, 'L11'), paths[4]);
});

test('il resolver dei main camera usa la posizione della label, non l ordine dei path', () => {
  const nodes = [
    { localName: 'path', getBBox: () => ({ x: 0, y: 0, width: 10, height: 10 }) },
    { localName: 'path', getBBox: () => ({ x: 200, y: 0, width: 10, height: 10 }) },
    { localName: 'text', textContent: 'C1', getBBox: () => ({ x: 0, y: 0, width: 10, height: 10 }) },
    { localName: 'text', textContent: 'C2', getBBox: () => ({ x: 200, y: 0, width: 10, height: 10 }) },
  ];
  for (const [index, node] of nodes.entries()) {
    node.previousElementSibling = nodes[index - 1] || null;
    node.nextElementSibling = nodes[index + 1] || null;
  }
  const source = { querySelectorAll: selector => nodes.filter(node => node.localName === selector) };
  const paths = nodes.filter(node => node.localName === 'path');
  assert.equal(shapeForLabel(source, 'C1'), paths[0]);
  assert.equal(shapeForLabel(source, 'C2'), paths[1]);
});

test('LAYER-13 associa LM1 al rettangolino immediatamente precedente, non al contenitore', async () => {
  const { source: svg } = await labelsIn('LAYER-13-METEO.svg');
  const source = markerSourceFromSvg(svg);
  for (const [label, shape] of [['M1', 'path'], ['QM1', 'rect'], ['LM1', 'rect']]) {
    const labelNode = source.nodes.find(node => node.localName === 'text' && node.textContent === label);
    const expected = labelNode.previousElementSibling;
    assert.equal(expected.localName, shape);
    assert.equal(shapeForLabel(source, label), expected, label);
  }
  const lm1Label = source.nodes.find(node => node.localName === 'text' && node.textContent === 'LM1');
  const smallMarker = lm1Label.previousElementSibling;
  const structuralContainer = smallMarker.previousElementSibling;
  assert.equal(structuralContainer.localName, 'rect');
  assert.notEqual(shapeForLabel(source, 'LM1'), structuralContainer);
});

test('gli altri marker semantici restano risolvibili nelle rispettive geometrie', async () => {
  const cases = [
    ['LAYER-07-LUCI.svg', ['L1', 'L2', 'L3', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']],
    ['LAYER-08-SENSORI.svg', ['S1', 'S2', 'S3', 'S4', 'S5', 'LS1', 'LS2', 'LS3', 'LS4', 'LS25', 'LU1', 'LU2', 'LU4']],
    ['LAYER-10-CALDAIA.svg', ['D1', 'QD1']],
    ['LAYER-22-OROLOGIO.svg', ['CLK1']],
  ];
  for (const [file, labels] of cases) {
    const { source: svg } = await labelsIn(file);
    const source = markerSourceFromSvg(svg);
    for (const label of labels) assert.ok(shapeForLabel(source, label), `${file}: ${label}`);
  }
});

test('LAYER-16 espone marker semantici sulle nuove posizioni di integrazione', async () => {
  const svg = await readFile(new URL('../design/LAYER-16-INTEGRAZIONE.svg', import.meta.url), 'utf8');
  assert.match(svg, /<rect id="integration-title" x="181\.5" y="1098\.5" width="750" height="201" stroke="none"/);
  assert.match(svg, /<rect id="integration-options" x="947\.5" y="1098\.5" width="201" height="201" stroke="none"/);
  assert.match(svg, /<text display="none"[^>]*>TITOLO \(HOME CONTROL\)<\/text>/);
  assert.match(svg, /<text display="none"[^>]*>Opt<\/text>/);
  assert.equal(floorplanConfig.integration.title.selector, '#integration-title');
  assert.equal(floorplanConfig.integration.options.selector, '#integration-options');
  assert.doesNotMatch(svg, /x="260\.5" y="1039\.5" width="750" height="130"/);
  assert.doesNotMatch(svg, /x="1026\.5" y="1039\.5" width="175" height="130"/);
});

test('LAYER-09 mantiene le identità C1/C2 sulle rispettive posizioni grafiche e controlli', async () => {
  const { source: svg } = await labelsIn('LAYER-09-CAM.svg');
  const source = markerSourceFromSvg(svg);
  assert.deepEqual(floorplanConfig.cameras.map(({ id, room, marker, controls }) => ({ id, room, marker: marker.label, controls: Object.fromEntries(Object.entries(controls).map(([kind, control]) => [kind, control.label])) })), [
    { id: 'C1', room: 'TERRAZZO', marker: 'C1', controls: { detection: 'c1b', battery: 'c1d', events: 'c1e' } },
    { id: 'C2', room: 'POND', marker: 'C2', controls: { detection: 'c2b', battery: 'c2d', events: 'c2e' } },
  ]);
  for (const camera of floorplanConfig.cameras) {
    assert.deepEqual(Object.keys(camera.controls), ['detection', 'battery', 'events']);
    for (const marker of [camera.marker, ...Object.values(camera.controls)]) assert.ok(shapeForLabel(source, marker.label), marker.label);
  }
});

test('marker dispositivi rimossi dal layer non vengono più renderizzati', async () => {
  const { labels } = await labelsIn('LAYER-DISPOSITIVI.svg');
  const retired = ['D14', 'D15', 'D16', 'D17', 'D18'];
  for (const id of retired) {
    assert.equal(floorplanConfig.devices.some(device => device.id === id), false, id);
    assert.equal(includesLabel(labels, id.slice(1)), false, id);
  }
  assert.equal(includesLabel(labels, 'DM'), true);
});

test('S1–S5 usano lo stato visivo conservativo dei sensori', async () => {
  assert.equal(sensorVisualState({ available: true, online: true, battery: 100 }), 'online');
  assert.equal(sensorVisualState({ available: true, online: true, battery: 20 }), 'battery-low');
  assert.equal(sensorVisualState({ available: true, online: true, batteryLow: true, battery: 100 }), 'battery-low');
  assert.equal(sensorVisualState({ available: false, online: true, battery: 5 }), 'offline');
  assert.equal(sensorVisualState({ available: true, online: false, battery: 5 }), 'offline');
  assert.equal(sensorVisualState({ available: true, online: true }), 'online');

  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /marker\.dataset\.sensorState = visualState/);
  assert.match(floorplan, /sensorVisualState\(details\)/);
  for (const state of ['online', 'battery-low', 'offline']) assert.match(css, new RegExp(`\\.floorplan-marker-sensor\\[data-sensor-state="${state}"\\]`));
});

test('allarme minima temperatura ha soglie indipendenti, isteresi e priorità offline', async () => {
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) {
    assert.equal(sensorTemperatureAlertState({ available: true, online: true, value: 17.9 }, 18), true, id);
    assert.equal(sensorTemperatureAlertState({ available: true, online: true, value: 18 }, 18), false, id);
    assert.equal(sensorTemperatureAlertState({ available: true, online: true, value: 18.3 }, 18, true), true, id);
    assert.equal(sensorTemperatureAlertState({ available: true, online: true, value: 18.5 }, 18, true), false, id);
    assert.equal(sensorTemperatureAlertState({ available: false, online: true, value: 10 }, 18), false, id);
    assert.equal(sensorTemperatureAlertState({ available: true, online: false, value: 10 }, 18), false, id);
    assert.equal(sensorTemperatureAlertState({ available: true, online: true, value: null }, 18), false, id);
  }
  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /temperatureAlert \? 'temperature-low' : sensorVisualState/);
  assert.match(floorplan, /api\/sensors\/\$\{id\}\/minimum-temperature/);
  assert.doesNotMatch(floorplan, /api\/thermostat\/(?:setpoint|mode)/);
  for (const color of ['rgb\\(41 223 146 \/ 40%\\)', 'rgb\\(255 229 106 \/ 40%\\)', 'rgb\\(119 136 150 \/ 40%\\)']) assert.match(css, new RegExp(color));
  assert.match(css, /floorplan-sensor-temperature-alert 1\.5s/);
});

test('icone batteria camera rispettano soglie esatte e priorità ricarica', () => {
  assert.equal(cameraBatteryIcon({ percent: 0, charging: false }), 'solar-panel-battery-empty.svg');
  assert.equal(cameraBatteryIcon({ percent: 20, charging: false }), 'solar-panel-battery-empty.svg');
  assert.equal(cameraBatteryIcon({ percent: 21, charging: false }), 'solar-panel-battery-low.svg');
  assert.equal(cameraBatteryIcon({ percent: 40, charging: false }), 'solar-panel-battery-low.svg');
  assert.equal(cameraBatteryIcon({ percent: 41, charging: false }), 'solar-panel-battery-half.svg');
  assert.equal(cameraBatteryIcon({ percent: 60, charging: false }), 'solar-panel-battery-half.svg');
  assert.equal(cameraBatteryIcon({ percent: 61, charging: false }), 'solar-panel-battery-half2.svg');
  assert.equal(cameraBatteryIcon({ percent: 80, charging: false }), 'solar-panel-battery-half2.svg');
  assert.equal(cameraBatteryIcon({ percent: 81, charging: false }), 'solar-panel-battery-full.svg');
  assert.equal(cameraBatteryIcon({ percent: 100, charging: false }), 'solar-panel-battery-full.svg');
  assert.equal(cameraBatteryIcon({ percent: 5, charging: true }), 'solar-panel-battery-charging.svg');
  assert.equal(cameraBatteryIcon({ percent: null, charging: false }), null);
});

test('controllo rilevazione mantiene gli asset reali e unknown fail-safe', async () => {
  assert.deepEqual({
    detection: [floorplanConfig.icons.detectionOn, floorplanConfig.icons.detectionOff],
  }, {
    detection: ['rilevon.svg', 'rilevoff.svg'],
  });
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(floorplan, /setPrivacy|setDetection|setAlarm/);
  assert.match(floorplan, /renderCameraIcon\(control, assets, available && value \? onIcon : offIcon/);
  assert.doesNotMatch(floorplan, /camera\.controls\.privacy|camera\.controls\.alarm/);
  assert.match(floorplan, /renderCameraIcon\(control, assets, available && value \? onIcon : offIcon/);
});

test('unknown resta semanticamente unknown ma usa l icona OFF e le icone camera non vengono ricreate se l asset non cambia', async () => {
  const store = createFloorplanState();
  store.applyHomeSnapshot({ cameras: { C1: { privacy: { available: false, enabled: null }, detection: null } } });
  assert.equal(store.snapshot().cameras.C1.privacy.enabled, null);
  assert.equal(store.snapshot().cameras.C1.detection, null);
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /available && value \? onIcon : offIcon/);
  assert.doesNotMatch(floorplan, /camera\.controls\.privacy|camera\.controls\.alarm/);
  assert.match(floorplan, /renderCameraIcon\(control, assets, available && value \? onIcon : offIcon/);
  assert.match(floorplan, /control\.dataset\.renderKey === renderKey/);
  assert.match(floorplan, /control\.replaceChildren\(createIcon\(assets, asset, fallback, \{ immediate: true \}\)\)/);
});

test('renderCameraIcon aggiorna il DOM solo quando cambia l asset', () => {
  const previousDocument = globalThis.document;
  let imageCreations = 0;
  let srcAssignments = 0;
  const createElement = tag => {
    if (tag === 'img') imageCreations += 1;
    const element = {
      tag,
      dataset: {},
      append() {},
      replaceChildren(...children) { this.children = children; this.replaceCount = (this.replaceCount || 0) + 1; },
      setAttribute() {},
      addEventListener() {},
    };
    if (tag === 'img') Object.defineProperty(element, 'src', { get() { return this._src; }, set(value) { this._src = value; srcAssignments += 1; } });
    return element;
  };
  globalThis.document = { createElement };
  try {
    const control = createElement('button');
    const assets = new Set(['privacyoff.svg', 'privacyon.svg', 'solar-panel-battery-empty.svg', 'solar-panel-battery-low.svg']);
    renderCameraIcon(control, assets, 'privacyoff.svg', '?');
    renderCameraIcon(control, assets, 'privacyoff.svg', '?');
    assert.equal(control.replaceCount, 1);
    assert.equal(control.children.length, 1);
    assert.equal(srcAssignments, 1);
    renderCameraIcon(control, assets, 'privacyon.svg', '?');
    assert.equal(control.replaceCount, 2);
    assert.equal(srcAssignments, 2);
    renderCameraIcon(control, assets, 'solar-panel-battery-empty.svg', '▰');
    renderCameraIcon(control, assets, 'solar-panel-battery-empty.svg', '▰');
    assert.equal(control.replaceCount, 3);
    assert.equal(srcAssignments, 3);
    renderCameraIcon(control, assets, 'solar-panel-battery-low.svg', '▰');
    assert.equal(control.replaceCount, 4);
    assert.equal(srcAssignments, 4);
  } finally {
    globalThis.document = previousDocument;
  }
  assert.equal(imageCreations, 4);
});

test('il badge eventi mantiene il testo se invariato e lo aggiorna quando cambia', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /renderCameraText\(events, available \? String\(cameraState\.events\.count\) : '—'\)/);
});

test('privacy continua a essere letta per i popup, senza marker dedicato', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /\/api\/cameras\/\' \+ id \+ \'\/privacy/);
  assert.match(floorplan, /enabled === null \? \{ toggle: true \} : \{ enabled \}/);
  assert.match(floorplan, /onCameraPrivacyRead\(camera\.id\)\.then\(privacy => store\.applyCameraPrivacy\(camera\.id, privacy\)\)/);
  assert.doesNotMatch(floorplan, /privacyPending|kind === 'privacy'/);
});

test('Rilevazione camera usa C1b/C2b con read-back e resta fail-safe', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /\/api\/cameras\/' \+ id \+ '\/detection/);
  assert.match(floorplan, /onCameraDetectionRead\(camera\.id\)\.then\(detection => store\.applyCameraDetection\(camera\.id, detection\)\)/);
  assert.match(floorplan, /if \(detectionPending\.has\(camera\.id\)\) return;/);
  assert.match(floorplan, /onCameraDetectionToggle\(camera\.id, typeof detection === 'boolean' \? !detection : null\)\s*\.then\(readBack => store\.applyCameraDetection\(camera\.id, readBack\)\)/);
  assert.doesNotMatch(floorplan, /onCameraAlarmToggle\(camera\.id/);
  assert.match(floorplan, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*if \(kind === 'detection'\)/);
  assert.match(floorplan, /renderCameraIcon\(control, assets, available && value \? onIcon : offIcon/);
});

test('snapshot Privacy conserva l’ultimo read-back booleano ma accetta nuovi booleani', () => {
  const store = createFloorplanState();
  store.applyCameraPrivacy('C1', { available: true, enabled: true });
  store.applyHomeSnapshot({ cameras: { C1: { privacy: { available: false, enabled: null } } } });
  assert.equal(store.snapshot().cameras.C1.privacy.enabled, true);
  store.applyHomeSnapshot({ cameras: { C1: { privacy: { available: true, enabled: false } } } });
  assert.equal(store.snapshot().cameras.C1.privacy.enabled, false);
});

test('snapshot Rilevazione conserva l’ultimo master booleano e rispetta C2', () => {
  const store = createFloorplanState();
  store.applyCameraDetection('C2', { available: true, enabled: true });
  store.applyHomeSnapshot({ cameras: { C2: { detection: null } } });
  assert.equal(store.snapshot().cameras.C2.detection, true);
  store.applyHomeSnapshot({ cameras: { C2: { detection: false } } });
  assert.equal(store.snapshot().cameras.C2.detection, false);
});

test('snapshot precedente al read-back Alarm non annulla il PUT e un errore Home conserva camera', () => {
  const store = createFloorplanState();
  const requestedAt = Date.now() - 1000;
  store.applyCameraAlarm('C1', { available: true, enabled: true });
  store.applyCameraPrivacy('C1', { available: true, enabled: false });
  store.applyCameraDetection('C1', { available: true, enabled: true });
  store.applyHomeSnapshot({ cameras: { C1: { alarm: { available: true, enabled: false }, privacy: { available: true, enabled: true }, detection: false, battery: { available: true, percent: 70 }, events: { available: true, count: 2 } } } }, requestedAt);
  assert.equal(store.snapshot().cameras.C1.alarm.enabled, true);
  assert.equal(store.snapshot().cameras.C1.privacy.enabled, false);
  assert.equal(store.snapshot().cameras.C1.detection, true);
  assert.equal(store.snapshot().cameras.C1.battery.percent, 70);
  store.applyHomeSnapshot();
  assert.equal(store.snapshot().cameras.C1.alarm.enabled, true);
  assert.equal(store.snapshot().cameras.C1.events.count, 2);
});

test('controlli B/D/E isolano il click dallo streaming e restano fail-safe', async () => {
  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*if \(kind === 'detection'\)/);
  assert.match(floorplan, /if \(kind === 'events'\) onCameraEventsSelect/);
  assert.match(floorplan, /onCameraAlarmRead\(camera\.id\)/);
  assert.match(floorplan, /showCameraEventsPopup/);
  assert.match(floorplan, /placeHtmlOptional\(cameraMapping, marker, control, true/);
  assert.match(floorplan, /console\.warn\('Marker camera non disponibile: ' \+ label, error\)/);
  assert.doesNotMatch(floorplan, /if \(kind === 'events'\) onCameraSelect/);
  assert.match(css, /\.floorplan-marker-camera-aux \{[^}]*font-size: 56px/);
});

test('LAYER-08 associa ogni lettura LS/LU alla forma immediatamente collegata alla label', async () => {
  const { source: svg } = await labelsIn('LAYER-08-SENSORI.svg');
  const source = markerSourceFromSvg(svg);
  for (const label of ['LS1', 'LS2', 'LS3', 'LS4', 'LS25', 'LU1', 'LU2', 'LU4']) {
    const start = labelStart(source.nodes, label);
    assert.ok(start, label);
    assert.equal(start.previousElementSibling.localName, 'rect', label);
    assert.equal(shapeForLabel(source, label), start.previousElementSibling, label);
  }
});

test('letture temperatura e umidità usano soglie centralizzate e unità più piccole', () => {
  assert.equal(temperatureReadingColor(20.9), '#17c8f4');
  assert.equal(temperatureReadingColor(21), '#29df92');
  assert.equal(temperatureReadingColor(23), '#29df92');
  assert.equal(temperatureReadingColor(23.1), '#ff9d3d');
  assert.equal(humidityReadingColor(0), '#fff');
  assert.equal(humidityReadingColor(50), '#fff');
  assert.equal(humidityReadingColor(50.1), '#17c8f4');

  const attributes = {};
  const styles = {};
  const reading = { dataset: {}, style: { setProperty(name, value, priority) { styles[name] = { value, priority }; } }, setAttribute(name, value) { attributes[name] = value; }, replaceChildren(...children) { this.children = children; } };
  const originalSvgElement = globalThis.document;
  globalThis.document = { createElementNS(namespace, tag) { return { setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = value; }, textContent: '', tag }; } };
  renderFloorplanReading(reading, 26.1, '°C', temperatureReadingColor(26.1));
  assert.equal(attributes.fill, '#ff9d3d');
  assert.deepEqual(styles.fill, { value: '#ff9d3d', priority: 'important' });
  assert.equal(reading.dataset.readingColor, '#ff9d3d');
  assert.equal(reading.children[0].textContent, '26.1');
  assert.equal(reading.children[1].textContent, ' °C');
  assert.equal(reading.children[1].attributes['font-size'], '.62em');
  globalThis.document = originalSvgElement;
});

test('LS3 è il riferimento tipografico comune per tutte le letture LS e LU', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.equal(sensorReadingFontSize({ height: 200 }), 68);
  assert.match(floorplan, /sensorReadingFontSize\(sensorMapping\.box\(config\.sensors\.find\(sensor => sensor\.id === 'S3'\)\.reading\)\)/);
  assert.match(floorplan, /'font-size': sensorTypography\.fontSize/);
  assert.doesNotMatch(floorplan, /text\.setAttribute\('font-size', box\.height/);
  assert.match(floorplan, /'font-size': '\.62em'/);
});

test('LAYER-22 resta una sorgente geometrica invisibile con marker CLK1', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /source\.setAttribute\('visibility', 'hidden'\)/);
  assert.match(floorplan, /source\.style\.setProperty\('opacity', '0', 'important'\)/);
  assert.match(floorplan, /clockMapping\.box\(config\.clock\.marker\)/);
  assert.match(floorplan, /await import\('\.\/floorplan-clock\.js'\)/);
  assert.match(floorplan, /createFloorplanClock\(\{ overlay: clockMapping\.overlay, box: clockMapping\.box\(config\.clock\.marker\) \}\)/);
  assert.match(floorplan, /console\.warn\('Orologio planimetria non disponibile', error\)/);
  assert.doesNotMatch(floorplan, /staticLayerNames = \[[^\n]*config\.mappings\.clock/);
  assert.deepEqual(floorplanConfig.clock.marker, { label: 'CLK1' });
});

test('lo spostamento di coordinate non cambia l identità label-based dei marker', async () => {
  const { source } = await labelsIn('LAYER-13-METEO.svg');
  const moved = source.replace(/M467\.5 3301/, 'M999.5 999').replace(/x="402\.5" y="3504\.5"/, 'x="999.5" y="999.5"');
  for (const label of ['M1', 'QM1', 'LM1']) assert.match(moved, new RegExp(`>${label}</text>`));
  assert.deepEqual(floorplanConfig.weather, { marker: { label: 'M1' }, card: { label: 'QM1' }, currentCard: { label: 'LM1' } });
});
