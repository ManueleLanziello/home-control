import { switchSound } from './light-sound.js';
import { homeControlPath } from '../base-path.js';
import { floorplanConfig as config } from './floorplan-config.js';
import { backgroundPeriod, createFloorplanState } from './floorplan-state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const assetUrl = name => homeControlPath('/design/' + name);
const svgElement = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

// Mapping drawings are measured invisibly, never painted or modified on disk.
// Native getBBox/getCTM retain the exported transforms and exact marker sizes.
async function loadMapping(name, stage) {
  const response = await fetch(assetUrl(name), { cache: 'no-store' });
  if (!response.ok) throw new Error('Mappatura non disponibile: ' + name);
  const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  if (parsed.querySelector('parsererror')) throw new Error('Mappatura SVG non valida: ' + name);
  const source = document.importNode(parsed.documentElement, true);
  const width = source.width.baseVal.value;
  const height = source.height.baseVal.value;
  source.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  source.classList.add('floorplan-mapping-source');
  source.setAttribute('aria-hidden', 'true');
  stage.append(source);
  const overlay = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'floorplan-stack-layer floorplan-overlay', 'aria-label': name });
  stage.append(overlay);
  return {
    overlay,
    box({ selector, index }) {
      const shape = source.querySelectorAll(selector)[index];
      if (!shape) throw new Error('Marker mancante in ' + name);
      const bounds = shape.getBBox();
      const matrix = source.getCTM().inverse().multiply(shape.getCTM());
      const points = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]]
        .map(([x, y]) => new DOMPoint(x, y).matrixTransform(matrix));
      const x = Math.min(...points.map(point => point.x));
      const y = Math.min(...points.map(point => point.y));
      return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
    },
    dispose() { source.remove(); },
  };
}

function placeHtml(mapping, marker, element) {
  const box = mapping.box(marker);
  const foreign = svgElement('foreignObject', box);
  foreign.append(element);
  mapping.overlay.append(foreign);
  return box;
}

function createIcon(assets, asset, fallback) {
  const wrapper = document.createElement('span');
  wrapper.className = 'floorplan-symbol';
  wrapper.setAttribute('aria-hidden', 'true');
  const placeholder = document.createElement('span');
  placeholder.className = 'floorplan-fallback';
  placeholder.textContent = fallback;
  wrapper.append(placeholder);
  // The inventory is refreshed on page load: absent files are never requested.
  if (assets.has(asset)) {
    const image = document.createElement('img');
    image.alt = '';
    image.hidden = true;
    image.addEventListener('load', () => { image.hidden = false; placeholder.hidden = true; }, { once: true });
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = assetUrl(asset);
    wrapper.append(image);
  }
  return wrapper;
}

function markerElement(label, interactive = false) {
  const element = document.createElement(interactive ? 'button' : 'div');
  element.className = 'floorplan-marker';
  if (interactive) element.type = 'button';
  element.setAttribute('aria-label', label);
  element.title = label;
  return element;
}

const CAMERA_FRAME_INTERVAL_MS = 250;

function cameraEndpoint(id, suffix) { return homeControlPath(`/api/cameras/${id}/${suffix}`); }

async function closeCamera(dialog) {
  const session = dialog._cameraSession;
  if (!session || session.closing) { dialog.close(); return; }
  session.closing = true;
  clearTimeout(session.timer);
  session.controller.abort();
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
  try {
    await fetch(cameraEndpoint(session.id, 'live'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }), keepalive: true });
  } catch {
    // La chiusura della UI non deve dipendere dalla disponibilità momentanea della camera.
  }
  if (dialog._cameraSession === session) dialog._cameraSession = null;
  if (dialog.open) dialog.close();
}

async function refreshCameraFrame(dialog, session) {
  if (session.closing || session.frameBusy) return;
  session.frameBusy = true;
  const image = dialog.querySelector('[data-camera-image]');
  const message = dialog.querySelector('[data-camera-message]');
  try {
    const response = await fetch(`${cameraEndpoint(session.id, 'image')}?v=${Date.now()}`, { cache: 'no-store', signal: session.controller.signal });
    if (!response.ok) throw new Error('Immagine non disponibile');
    const frame = await response.blob();
    if (!frame.type.startsWith('image/')) throw new Error('Formato immagine non valido');
    const nextUrl = URL.createObjectURL(frame);
    if (session.closing) { URL.revokeObjectURL(nextUrl); return; }
    if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
    session.objectUrl = nextUrl;
    image.src = nextUrl;
    image.hidden = false;
    session.hasFrame = true;
  } catch (error) {
    if (!session.closing && !session.hasFrame) message.textContent = 'Connessione…';
  } finally {
    session.frameBusy = false;
    if (!session.closing) session.timer = setTimeout(() => refreshCameraFrame(dialog, session), CAMERA_FRAME_INTERVAL_MS);
  }
}

async function showCamera(camera) {
  let dialog = document.querySelector('[data-floorplan-camera-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.dataset.floorplanCameraDialog = '';
    dialog.className = 'floorplan-camera-dialog';
    dialog.setAttribute('aria-labelledby', 'floorplan-camera-title');
    dialog.innerHTML = '<form><button type="button" data-camera-close aria-label="Chiudi anteprima">Chiudi ×</button></form><h2 id="floorplan-camera-title"></h2><p data-camera-message></p><img data-camera-image alt="Anteprima camera" hidden>';
    dialog.addEventListener('click', event => { if (event.target === dialog) void closeCamera(dialog); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); void closeCamera(dialog); });
    dialog.querySelector('[data-camera-close]').addEventListener('click', () => void closeCamera(dialog));
    document.body.append(dialog);
  }
  if (dialog._cameraSession) await closeCamera(dialog);
  dialog.querySelector('h2').textContent = camera.id + ' ' + camera.room;
  const message = dialog.querySelector('[data-camera-message]');
  const session = { id: camera.id, closing: false, frameBusy: false, hasFrame: false, timer: null, objectUrl: null, controller: new AbortController() };
  dialog._cameraSession = session;
  dialog.dataset.cameraId = camera.id;
  dialog.showModal();
  message.textContent = 'Connessione…';
  void refreshCameraFrame(dialog, session);
  try {
    const response = await fetch(cameraEndpoint(camera.id, 'live'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: true }), signal: session.controller.signal });
    if (!response.ok) throw new Error('Live non disponibile');
    const state = await response.json();
    if (!session.closing) message.textContent = state.live ? 'Live' : 'Connessione…';
  } catch {
    if (!session.closing) message.textContent = session.hasFrame ? 'Non disponibile · ultima immagine' : 'Non disponibile';
  }
}

window.addEventListener('pagehide', () => {
  const dialog = document.querySelector('[data-floorplan-camera-dialog]');
  if (dialog?._cameraSession) void closeCamera(dialog);
});

export function renderBoilerMini(container, boiler) {
  const indicator = document.createElement('span');
  indicator.className = 'floorplan-boiler-status';
  indicator.dataset.on = String(boiler.on === true);
  indicator.setAttribute('aria-hidden', 'true');
  if (typeof boiler.on !== 'boolean') indicator.style.background = 'transparent';
  const mode = String(boiler.mode || '').toLowerCase();
  const modeKey = ['manual', 'auto', 'smart'].includes(mode) ? mode : 'unknown';
  const modeIcon = document.querySelector('[data-boiler-mode-option="' + modeKey + '"] > span');
  const modeHolder = document.createElement('span');
  modeHolder.className = 'floorplan-boiler-mode boiler-mode' + (modeKey !== 'unknown' ? ' is-active' : '');
  modeHolder.dataset.mode = modeKey;
  modeHolder.setAttribute('aria-hidden', 'true');
  if (modeIcon) modeHolder.append(modeIcon.cloneNode(true));
  container.replaceChildren(indicator, modeHolder);
}

function openBoiler(section = 'card') {
  document.dispatchEvent(new CustomEvent('home-control:open-boiler', { detail: { section: typeof section === 'string' ? section : 'card' } }));
}

export async function initFloorplan({ store = createFloorplanState(), onCameraSelect = showCamera, onLightToggle = id => store.setLight(id, !store.snapshot().lights[id]) } = {}) {
  const stage = document.querySelector('[data-layered-floorplan]');
  const status = document.querySelector('[data-floorplan-status]');
  if (!stage) return;
  void switchSound.preload();
  const mappings = [];
  try {
    const response = await fetch(homeControlPath('/api/floorplan/assets'), { cache: 'no-store' });
    if (!response.ok) throw new Error('Elenco asset non disponibile');
    const assets = new Set((await response.json()).assets);
    const required = [...Object.values(config.backgrounds), ...config.rooms.filter(room => !room.optional).flatMap(room => [room.on, room.off]), ...Object.values(config.mappings)];
    const missing = required.filter(name => !assets.has(name));
    if (missing.length) throw new Error('Asset planimetria mancanti: ' + missing.join(', '));
    const imageLayers = new Map();
    await Promise.all([...Object.values(config.backgrounds), ...config.rooms.flatMap(room => [room.off, room.on].filter(name => !room.optional || assets.has(name)))].map(name => new Promise((resolve, reject) => {
      const image = document.createElement('img');
      image.className = 'floorplan-stack-layer';
      image.alt = '';
      image.hidden = true;
      image.dataset.layer = name;
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', () => { image.remove(); reject(new Error('Impossibile caricare ' + name)); }, { once: true });
      stage.append(image);
      imageLayers.set(name, image);
      image.src = assetUrl(name);
    })));
    const background = imageLayers.get(config.backgrounds.day);
    stage.style.setProperty('--floorplan-ratio', background.naturalWidth + ' / ' + background.naturalHeight);
    stage.style.setProperty('--floorplan-width-ratio', String(background.naturalWidth / background.naturalHeight));
    const updateBackground = () => {
      const period = backgroundPeriod();
      stage.dataset.period = period;
      for (const [key, name] of Object.entries(config.backgrounds)) imageLayers.get(name).hidden = key !== period;
    };
    updateBackground();
    const lightMapping = await loadMapping(config.mappings.lights, stage); mappings.push(lightMapping);
    const sensorMapping = await loadMapping(config.mappings.sensors, stage); mappings.push(sensorMapping);
    const cameraMapping = await loadMapping(config.mappings.cameras, stage); mappings.push(cameraMapping);
    const boilerMapping = await loadMapping(config.mappings.boiler, stage); mappings.push(boilerMapping);
    const lightMarkers = new Map();
    for (const light of config.lights) {
      const element = markerElement('Luce ' + light.room, true);
      element.removeAttribute('title');
      element.addEventListener('click', () => {
        if (store.snapshot().lightSources[light.id] !== 'simulation') return;
        onLightToggle(light.id);
        switchSound.play();
      });
      element.addEventListener('dragstart', event => event.preventDefault());
      element.dataset.floorplanLight = light.id;
      placeHtml(lightMapping, light.marker, element);
      lightMarkers.set(light.id, element);
    }
    const sensorReadings = new Map();
    for (const sensor of config.sensors) {
      const element = markerElement('Temperatura ' + sensor.room);
      element.classList.add('floorplan-marker-sensor');
      element.append(createIcon(assets, config.icons.sensor, '🌡'));
      placeHtml(sensorMapping, sensor.marker, element);
      const box = sensorMapping.box(sensor.reading);
      const text = svgElement('text', { x: box.x + box.width / 2, y: box.y + box.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': box.height * .34, class: 'floorplan-reading' });
      text.dataset.sensorReading = sensor.id;
      sensorMapping.overlay.append(text);
      sensorReadings.set(sensor.id, text);
    }
    for (const camera of config.cameras) {
      const element = markerElement('Camera ' + camera.room, true);
      element.classList.add('floorplan-marker-camera');
      element.dataset.cameraId = camera.id;
      element.append(createIcon(assets, config.icons.camera, '📷'));
      element.addEventListener('click', () => onCameraSelect({ ...camera, status: store.snapshot().cameras[camera.id] }));
      placeHtml(cameraMapping, camera.marker, element);
    }
    const boilerIcon = markerElement('Apri card CALDAIA', true);
    boilerIcon.append(createIcon(assets, config.icons.boiler, '♨'));
    boilerIcon.addEventListener('click', openBoiler);
    placeHtml(boilerMapping, config.boiler.marker, boilerIcon);
    const mini = document.createElement('div');
    mini.className = 'floorplan-boiler-mini';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'floorplan-boiler-open';
    open.setAttribute('aria-label', 'Apri CALDAIA completa');
    open.addEventListener('click', openBoiler);
    const settings = document.createElement('a');
    settings.className = 'floorplan-boiler-settings';
    settings.textContent = '⚙';
    settings.setAttribute('aria-label', 'Programmazione CALDAIA');
    settings.href = '#boiler-programming';
    settings.addEventListener('click', event => { event.preventDefault(); openBoiler('programming'); });
    mini.append(open, settings);
    placeHtml(boilerMapping, config.boiler.card, mini);
    let previousLights = {};
    const render = state => {
      for (const room of config.rooms) {
        const on = state.lights[room.lightId] === true;
        if (imageLayers.has(room.on)) imageLayers.get(room.on).hidden = !on;
        if (imageLayers.has(room.off)) imageLayers.get(room.off).hidden = on || state.lights[room.lightId] === null;
      }
      for (const light of config.lights) {
        const on = state.lights[light.id] === true;
        const element = lightMarkers.get(light.id);
        element.dataset.on = String(on);
        element.setAttribute('aria-pressed', String(on));
        const source = state.lightSources[light.id];
        element.disabled = source !== 'simulation';
        element.dataset.source = source;
        element.setAttribute('aria-label', 'Luce ' + light.room + ': ' + (state.lights[light.id] === null ? 'non disponibile' : on ? 'ON' : 'OFF') + (source === 'simulation' ? ' · simulata' : ''));
        if (previousLights[light.id] !== on) element.replaceChildren(createIcon(assets, on ? config.icons.lightOn : config.icons.lightOff, '💡'));
        previousLights[light.id] = on;
      }
      for (const sensor of config.sensors) {
        const value = state.sensors[sensor.id];
        sensorReadings.get(sensor.id).textContent = Number.isFinite(value) ? value.toFixed(1) + ' °C' : '— °C';
      }
      open.setAttribute('aria-label', 'Apri CALDAIA completa · ' + (state.boiler.on === null ? 'stato non disponibile' : state.boiler.on ? 'riscaldamento ON' : 'riscaldamento OFF') + ' · ' + (state.boiler.mode || 'modalità non disponibile'));
      renderBoilerMini(open, state.boiler);
    };
    render(store.snapshot());
    const unsubscribe = store.subscribe(render);

    // Runs at the boundary, also after tab suspension or browser clock changes.
    let timer;
    const tick = () => {
      clearTimeout(timer);
      updateBackground();
      const now = new Date();
      const next = new Date(now);
      if (now.getHours() < 7) next.setHours(7, 0, 0, 0);
      else if (now.getHours() < 19) next.setHours(19, 0, 0, 0);
      else { next.setDate(next.getDate() + 1); next.setHours(7, 0, 0, 0); }
      timer = setTimeout(tick, Math.min(60_000, Math.max(1, next - now)));
    };
    tick();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('pageshow', tick);
    status.hidden = true;
    stage.dataset.ready = 'true';
    return { store, destroy() { clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', tick); window.removeEventListener('pageshow', tick); stage.replaceChildren(); } };
  } catch (error) {
    status.textContent = error.message;
  } finally {
    for (const mapping of mappings) mapping.dispose();
  }
}
