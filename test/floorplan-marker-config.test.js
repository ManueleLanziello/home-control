import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { floorplanConfig } from '../public/js/floorplan-config.js';
import { backgroundPeriod, createFloorplanState } from '../public/js/floorplan-state.js';
import { createHomeControlServer } from '../server.js';

globalThis.window = { addEventListener() {} };
const { cameraBatteryIcon, shapeForLabel, humidityReadingColor, renderFloorplanReading, sensorReadingFontSize, temperatureReadingColor } = await import('../public/js/floorplan.js');

async function labelsIn(file) {
  const source = await readFile(new URL(`../design/${file}`, import.meta.url), 'utf8');
  const labels = [...source.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(([, text]) => text.trim());
  return { source, labels };
}

function includesLabel(labels, label) {
  return labels.includes(label) || labels.some((part, index) => part + (labels[index + 1] || '') === label);
}

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
  const [lights, sensors, boiler, weather, clock] = await Promise.all(['LAYER-07-LUCI.svg', 'LAYER-08-SENSORI.svg', 'LAYER-10-CALDAIA.svg', 'LAYER-13-METEO.svg', 'LAYER-22-OROLOGIO.svg'].map(labelsIn));
  for (const id of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12']) assert.equal(includesLabel(lights.labels, id), true, id);
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5', 'LS1', 'LS2', 'LS3', 'LS4', 'LS5']) assert.equal(includesLabel(sensors.labels, id), true, id);
  for (const id of ['D1', 'QD1']) assert.equal(includesLabel(boiler.labels, id), true, id);
  for (const id of ['M1', 'QM1', 'LM1']) assert.equal(includesLabel(weather.labels, id), true, id);
  assert.equal(includesLabel(clock.labels, 'CLK1'), true);
  assert.deepEqual(floorplanConfig.lights.map(light => light.id), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12']);
  assert.deepEqual(floorplanConfig.rooms.map(room => room.lightId), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7']);
  assert.deepEqual(floorplanConfig.lights.slice(7).map(light => light.localOnly), [true, true, true, true, true]);
  assert.deepEqual(floorplanConfig.sensors.map(sensor => [sensor.reading.label, sensor.humidityReading?.label || null]), [['LS1', 'LU1'], ['LS2', 'LU2'], ['LS3', null], ['LS4', 'LU4'], ['LS5', null]]);
  for (const marker of [...floorplanConfig.lights, ...floorplanConfig.sensors].map(item => item.marker).concat(floorplanConfig.boiler.marker, floorplanConfig.boiler.card, floorplanConfig.weather.marker, floorplanConfig.weather.card, floorplanConfig.weather.temperatureLabel, floorplanConfig.clock.marker)) assert.ok(marker.label);
});

test('L1-L7 mantengono i layer, L8-L12 sono toggle UI locali', () => {
  const store = createFloorplanState();
  store.applyHomeSnapshot({ lights: { L1: { source: 'simulation', state: false } } });

  store.setLight('L1', true);
  store.setLight('L8', true);
  const state = store.snapshot();

  assert.equal(state.lights.L1, true);
  assert.equal(state.lights.L8, true);
  assert.equal(state.lightSources.L8, 'simulation');
  assert.equal(floorplanConfig.rooms.some(room => room.lightId === 'L8'), false);
  assert.equal(floorplanConfig.rooms.some(room => room.lightId === 'L12'), false);
  assert.deepEqual(floorplanConfig.rooms.at(-1), { lightId: 'L7', on: 'LAYER-11-ON.svg', off: 'LAYER-11-OFF.svg', optional: true });
  assert.doesNotMatch(JSON.stringify(floorplanConfig.rooms), /LAYER-L7-ON\.svg/);
});

test('L8-L12 usano overlay full-plan indipendenti e conservano lo stato attraverso il cambio base', () => {
  assert.deepEqual(floorplanConfig.externalLightOverlays, {
    L8: 'LAYER-L8-ON.svg', L9: 'LAYER-L9-ON.svg', L10: 'LAYER-L10-ON.svg', L11: 'LAYER-L11-ON.svg', L12: 'LAYER-L12-ON.svg',
  });
  const store = createFloorplanState();
  store.setLight('L8', true);
  store.setLight('L10', true);
  store.setLight('L11', true);
  const beforeBaseChange = store.snapshot().lights;
  assert.deepEqual(beforeBaseChange, { L1: false, L2: false, L3: false, L4: false, L5: false, L6: false, L7: false, L8: true, L9: false, L10: true, L11: true, L12: false });
  assert.equal(backgroundPeriod(new Date(2026, 8, 22, 12)), 'day');
  assert.equal(backgroundPeriod(new Date(2026, 8, 22, 22)), 'night');
  assert.deepEqual(store.snapshot().lights, beforeBaseChange);
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
  assert.match(floorplan, /for \(const \[key, name\] of Object\.entries\(config\.backgrounds\)\) imageLayers\.get\(name\)\.hidden = key !== period/);
  assert.match(css, /\.floorplan-external-light-overlay \{ pointer-events: none; \}/);
});

test('il resolver associa correttamente marker e label anche quando le label sono raggruppate', () => {
  const source = markerSource([
    ['path'], ['path'], ['path'], ['path'], ['path'], ['path'],
    ['text', 'L1'], ['text', 'L2'], ['text', 'L3'], ['text', 'L4'], ['text', 'L5'], ['text', 'L6'],
    ['path'], ['text', 'L'], ['text', '1'], ['text', '1'],
  ]);
  const paths = source.querySelectorAll('path');
  assert.equal(shapeForLabel(source, 'L1'), paths[0]);
  assert.equal(shapeForLabel(source, 'L6'), paths[5]);
  assert.equal(shapeForLabel(source, 'L11'), paths[6]);
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
    ['LAYER-07-LUCI.svg', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12']],
    ['LAYER-08-SENSORI.svg', ['S1', 'S2', 'S3', 'S4', 'S5', 'LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LU1', 'LU2', 'LU4']],
    ['LAYER-10-CALDAIA.svg', ['D1', 'QD1']],
    ['LAYER-22-OROLOGIO.svg', ['CLK1']],
  ];
  for (const [file, labels] of cases) {
    const { source: svg } = await labelsIn(file);
    const source = markerSourceFromSvg(svg);
    for (const label of labels) assert.ok(shapeForLabel(source, label), `${file}: ${label}`);
  }
});

test('LAYER-09 risolve semanticamente C1-C3 e i cinque marker compatti di ogni camera', async () => {
  const { source: svg } = await labelsIn('LAYER-09-CAM.svg');
  const source = markerSourceFromSvg(svg);
  for (const camera of floorplanConfig.cameras) {
    assert.deepEqual(camera.marker, { label: camera.id });
    assert.deepEqual(Object.keys(camera.controls), ['privacy', 'detection', 'alarm', 'battery', 'events']);
    for (const marker of [camera.marker, ...Object.values(camera.controls)]) assert.ok(shapeForLabel(source, marker.label), marker.label);
  }
});

test('icone batteria camera rispettano soglie esatte e priorità ricarica', () => {
  assert.equal(cameraBatteryIcon({ percent: 0, charging: false }), 'solar-panel-battery-empty.svg');
  assert.equal(cameraBatteryIcon({ percent: 20, charging: false }), 'solar-panel-battery-empty.svg');
  assert.equal(cameraBatteryIcon({ percent: 21, charging: false }), 'solar-panel-battery-low.svg');
  assert.equal(cameraBatteryIcon({ percent: 40, charging: false }), 'solar-panel-battery-low.svg');
  assert.equal(cameraBatteryIcon({ percent: 41, charging: false }), 'solar-panel-battery-half.svg');
  assert.equal(cameraBatteryIcon({ percent: 70, charging: false }), 'solar-panel-battery-half.svg');
  assert.equal(cameraBatteryIcon({ percent: 71, charging: false }), 'solar-panel-battery-full.svg');
  assert.equal(cameraBatteryIcon({ percent: 100, charging: false }), 'solar-panel-battery-full.svg');
  assert.equal(cameraBatteryIcon({ percent: 5, charging: true }), 'solar-panel-battery-charging.svg');
  assert.equal(cameraBatteryIcon({ percent: null, charging: false }), null);
});

test('stati futuri privacy, rilevamento e allarme hanno gli asset esatti senza setter', async () => {
  assert.deepEqual({
    privacy: [floorplanConfig.icons.privacyOn, floorplanConfig.icons.privacyOff],
    detection: [floorplanConfig.icons.detectionOn, floorplanConfig.icons.detectionOff],
    alarm: [floorplanConfig.icons.alarmOn, floorplanConfig.icons.alarmOff],
  }, {
    privacy: ['privacyon.svg', 'privacyoff.svg'],
    detection: ['rilevon.svg', 'rilevoff.svg'],
    alarm: ['alarmon.svg', 'alarmoff.svg'],
  });
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(floorplan, /setPrivacy|setDetection|setAlarm/);
  assert.match(floorplan, /createIcon\(assets, available && value \? onIcon : offIcon, '\?'\)/);
});

test('Privacy camera usa read-back reale, non fallback OFF né click streaming', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /\/api\/cameras\/\' \+ id \+ \'\/privacy/);
  assert.match(floorplan, /onCameraPrivacyToggle\(camera\.id, !privacy\.enabled\)/);
  assert.match(floorplan, /onCameraPrivacyRead\(camera\.id\)\.then\(privacy => store\.applyCameraPrivacy\(camera\.id, privacy\)\)/);
  assert.match(floorplan, /\.then\(readBack => store\.applyCameraPrivacy\(camera\.id, readBack\)\)/);
  assert.match(floorplan, /if \(kind === 'privacy' && !available\) control\.replaceChildren\(document\.createTextNode\('\?'\)\)/);
  assert.match(floorplan, /event\.stopPropagation\(\);\s*if \(kind === 'privacy'\)/);
});

test('controlli camera compatti isolano il click dallo streaming e restano fail-safe', async () => {
  const [floorplan, css] = await Promise.all([
    readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8'),
  ]);
  assert.match(floorplan, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*if \(kind === 'privacy'\)/);
  assert.match(floorplan, /if \(kind === 'events'\) onCameraEventsSelect/);
  assert.match(floorplan, /placeHtmlOptional\(cameraMapping, marker, control, true/);
  assert.match(floorplan, /console\.warn\('Marker camera non disponibile: ' \+ label, error\)/);
  assert.doesNotMatch(floorplan, /if \(kind === 'events'\) onCameraSelect/);
  assert.match(css, /\.floorplan-marker-camera-aux \{[^}]*font-size: 56px/);
});

test('LAYER-08 associa ogni lettura LS/LU alla forma immediatamente collegata alla label', async () => {
  const { source: svg } = await labelsIn('LAYER-08-SENSORI.svg');
  const source = markerSourceFromSvg(svg);
  for (const label of ['LS1', 'LS2', 'LS3', 'LS4', 'LS5', 'LU1', 'LU2', 'LU4']) {
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
  assert.deepEqual(floorplanConfig.weather, { marker: { label: 'M1' }, card: { label: 'QM1' }, temperatureLabel: { label: 'LM1' } });
});
