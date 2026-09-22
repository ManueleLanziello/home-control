import { switchSound } from './light-sound.js';
import { homeControlPath } from '../base-path.js';
import { floorplanConfig as config } from './floorplan-config.js';
import { backgroundPeriod, createFloorplanState } from './floorplan-state.js';
import { bindSensorPopupTrigger, showSensorPopup, updateSensorPopup } from './sensor-popup.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const assetUrl = name => homeControlPath('/design/' + name);
let weatherSnapshot = null;
let renderWeatherSnapshot = () => {};

// Keep the physical 0..254 Zigbee brightness domain at the UI boundary.
export function ledbarLayerFor({ state, brightness } = {}) {
  if (state !== 'ON' || !Number.isInteger(brightness) || brightness === 0) return 'off';
  if (brightness <= 127) return 'low';
  if (brightness <= 222) return 'medium';
  return 'high';
}

export function updateFloorplanWeather(snapshot) {
  weatherSnapshot = snapshot;
  renderWeatherSnapshot(snapshot);
}
const svgElement = (tag, attributes = {}) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
};

export function shapeForLabel(source, label) {
  for (const candidate of source.querySelectorAll('text')) {
    let first = candidate;
    while (first.previousElementSibling?.localName === 'text') first = first.previousElementSibling;
    if (first !== candidate) continue;

    const labels = [];
    for (let current = first; current?.localName === 'text'; current = current.nextElementSibling) labels.push(current.textContent.trim());

    let lastShape = first.previousElementSibling;
    const shapeType = lastShape?.localName;
    if (!shapeType) continue;
    const shapes = [];
    while (lastShape?.localName === shapeType) {
      shapes.unshift(lastShape);
      lastShape = lastShape.previousElementSibling;
    }

    for (let start = 0; start < labels.length; start += 1) {
      let text = '';
      for (let index = start; index < labels.length; index += 1) {
        text += labels[index];
        if (text === label) return (shapes.length === labels.length ? shapes[start] : shapes.at(-1)) || null;
        if (!label.startsWith(text)) break;
      }
    }
  }
  return null;
}

export const temperatureReadingColor = value => !Number.isFinite(value) ? '#fff' : value < 21 ? '#17c8f4' : value <= 23 ? '#29df92' : '#ff9d3d';
export const humidityReadingColor = value => Number.isFinite(value) && value > 50 ? '#17c8f4' : '#fff';
export const sensorReadingFontSize = referenceBox => referenceBox.height * .34;
export function cameraBatteryIcon({ percent, charging } = {}) {
  if (charging === true) return config.icons.batteryCharging;
  if (!Number.isFinite(percent)) return null;
  if (percent <= 20) return config.icons.batteryEmpty;
  if (percent <= 40) return config.icons.batteryLow;
  if (percent <= 70) return config.icons.batteryHalf;
  return config.icons.batteryFull;
}

export function renderFloorplanReading(reading, value, unit, color) {
  reading.setAttribute('fill', color);
  reading.style.setProperty('fill', color, 'important');
  reading.dataset.readingColor = color;
  const number = svgElement('tspan');
  number.textContent = Number.isFinite(value) ? value.toFixed(1) : '—';
  const suffix = svgElement('tspan', { 'font-size': '.62em' });
  suffix.textContent = ' ' + unit;
  reading.replaceChildren(number, suffix);
}

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
  // Mapping sources stay measurable for getBBox/getCTM but are never painted.
  source.setAttribute('visibility', 'hidden');
  source.style.setProperty('opacity', '0', 'important');
  source.style.setProperty('pointer-events', 'none', 'important');
  stage.append(source);
  const overlay = svgElement('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'floorplan-stack-layer floorplan-overlay', 'aria-label': name });
  stage.append(overlay);
  return {
    overlay,
    box({ selector, index, label }) {
      const shape = label === undefined ? (index === undefined ? source.querySelector(selector) : source.querySelectorAll(selector)[index]) : shapeForLabel(source, label);
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

function placeHtml(mapping, marker, element, interactive = false) {
  const box = mapping.box(marker);
  const foreign = svgElement('foreignObject', box);
  if (interactive) foreign.classList.add('floorplan-interaction-host');
  foreign.append(element);
  mapping.overlay.append(foreign);
  return box;
}

function placeHtmlOptional(mapping, marker, element, interactive, label) {
  try { placeHtml(mapping, marker, element, interactive); return true; }
  catch (error) { console.warn('Marker camera non disponibile: ' + label, error); return false; }
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

async function closeCameraViewer(dialog) {
  const session = dialog._cameraSession;
  if (!session || session.closing) {
    if (dialog.open) dialog.close();
    dialog.remove();
    return;
  }
  session.closing = true;
  clearTimeout(session.timer);
  session.controller.abort();
  if (session.objectUrl) URL.revokeObjectURL(session.objectUrl);
  let stopRequest;
  try {
    stopRequest = fetch(cameraEndpoint(session.id, 'live'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }), keepalive: true });
  } catch {
    // La chiusura della UI non deve dipendere dalla disponibilità momentanea della camera.
  }
  if (dialog._cameraSession === session) dialog._cameraSession = null;
  if (dialog.open) dialog.close();
  dialog.remove();
  try {
    await stopRequest;
  } catch {
    // La chiusura della UI non deve dipendere dalla disponibilità momentanea della camera.
  }
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
    dialog.innerHTML = '<div class="floorplan-camera-header"><h2 id="floorplan-camera-title"></h2><button type="button" data-camera-close aria-label="Chiudi anteprima"><img src="' + assetUrl('close.svg') + '" alt=""></button></div><p data-camera-message></p><img data-camera-image alt="Anteprima camera" hidden>';
    dialog.addEventListener('click', event => { if (event.target === dialog) void closeCameraViewer(dialog); });
    dialog.addEventListener('cancel', event => { event.preventDefault(); void closeCameraViewer(dialog); });
    dialog.querySelector('[data-camera-close]').addEventListener('click', () => void closeCameraViewer(dialog));
    document.body.append(dialog);
  }
  if (dialog._cameraSession) await closeCameraViewer(dialog);
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
  if (dialog?._cameraSession) void closeCameraViewer(dialog);
});

export function renderBoilerMini(container, boiler) {
  const indicator = document.createElement('img');
  indicator.className = 'floorplan-boiler-status';
  indicator.src = assetUrl(boiler.on === true ? 'fire.svg' : 'nofire.svg');
  indicator.alt = '';
  indicator.dataset.on = String(boiler.on === true);
  indicator.setAttribute('aria-hidden', 'true');
  if (typeof boiler.on !== 'boolean') indicator.dataset.available = 'false';
  const mode = String(boiler.mode || '').toLowerCase();
  const modeKey = ['manual', 'auto', 'smart'].includes(mode) ? mode : 'unknown';
  const modeIcon = document.createElement('img');
  modeIcon.className = 'floorplan-boiler-mode';
  modeIcon.src = assetUrl((modeKey === 'unknown' ? 'auto' : modeKey) + '.svg');
  modeIcon.alt = '';
  modeIcon.dataset.mode = modeKey;
  modeIcon.setAttribute('aria-hidden', 'true');
  container.replaceChildren(indicator, modeIcon);
}

function openBoiler(section = 'card') {
  document.dispatchEvent(new CustomEvent('home-control:open-boiler', { detail: { section: typeof section === 'string' ? section : 'card' } }));
}

function openCappa() {
  document.dispatchEvent(new CustomEvent('home-control:open-cappa'));
}

const weatherNumber = value => Number.isFinite(value) ? new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 }).format(value) : '—';
const weatherTemperature = value => Number.isFinite(value) ? `${weatherNumber(value)} °C` : '— °C';
const weatherPercent = value => Number.isFinite(value) ? `${Math.round(value)}%` : '—';
const weatherTime = value => value ? new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const weatherDay = value => value ? new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`)) : '—';
const windDirection = value => {
  if (!Number.isFinite(value)) return '—';
  return ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(value / 45) % 8];
};

function weatherImage(assets, icon, className = '') {
  const image = document.createElement('img');
  image.className = className;
  image.alt = '';
  image.src = assetUrl(assets.has(icon) ? icon : 'cloudy.svg');
  return image;
}

function updateWeatherDialog(snapshot) {
  const dialog = document.querySelector('[data-weather-dialog]');
  if (!dialog) return;
  const current = snapshot?.current;
  dialog.querySelector('[data-weather-popup-location]').textContent = snapshot?.location || 'METEO OGGI';
  dialog.querySelector('[data-weather-popup-updated]').textContent = snapshot?.updatedAt ? `Aggiornato ${weatherTime(snapshot.updatedAt)}${snapshot.stale ? ' · dati precedenti' : ''}` : 'Dati non disponibili';
  const currentHost = dialog.querySelector('[data-weather-popup-current]');
  const details = dialog.querySelector('[data-weather-popup-details]');
  const hourly = dialog.querySelector('[data-weather-popup-hourly]');
  const daily = dialog.querySelector('[data-weather-popup-daily]');
  currentHost.replaceChildren(); details.replaceChildren(); hourly.replaceChildren(); daily.replaceChildren();
  if (!current) {
    currentHost.textContent = 'Dati meteo non disponibili';
    return;
  }
  const icon = document.createElement('img'); icon.src = assetUrl(current.icon || 'cloudy.svg'); icon.alt = '';
  const text = document.createElement('div'); text.innerHTML = `<strong>${weatherTemperature(current.temperature)}</strong><span>${current.condition}</span><small>Percepita ${weatherTemperature(current.apparentTemperature)}</small>`;
  currentHost.append(icon, text);
  for (const [label, value] of [
    ['Min / Max', `${weatherTemperature(snapshot.today?.minTemperature)} / ${weatherTemperature(snapshot.today?.maxTemperature)}`],
    ['Umidità', weatherPercent(current.humidity)], ['Vento', `${weatherNumber(current.windSpeed)} km/h ${windDirection(current.windDirection)}`],
    ['Probabilità pioggia', weatherPercent(current.rainProbability)], ['Precipitazioni', Number.isFinite(current.precipitation) ? `${weatherNumber(current.precipitation)} mm` : '—'],
  ]) {
    const item = document.createElement('div'); item.innerHTML = `<span>${label}</span><strong>${value}</strong>`; details.append(item);
  }
  for (const item of snapshot.hourly || []) {
    const card = document.createElement('div');
    card.innerHTML = `<strong>${weatherTime(item.time)}</strong><img src="${assetUrl(item.icon || 'cloudy.svg')}" alt=""><span>${weatherTemperature(item.temperature)}</span><small>${weatherPercent(item.rainProbability)}</small>`;
    hourly.append(card);
  }
  for (const item of snapshot.daily || []) {
    const card = document.createElement('div');
    card.innerHTML = `<strong>${weatherDay(item.date)}</strong><img src="${assetUrl(item.icon || 'cloudy.svg')}" alt=""><span>${item.condition}</span><small>${weatherTemperature(item.minTemperature)} / ${weatherTemperature(item.maxTemperature)} · ${weatherPercent(item.rainProbability)}</small>`;
    daily.append(card);
  }
}

function openWeather() {
  let dialog = document.querySelector('[data-weather-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'weather-dialog';
    dialog.dataset.weatherDialog = '';
    dialog.innerHTML = '<header><div><h2 data-weather-popup-location>METEO OGGI</h2><p data-weather-popup-updated></p></div><button type="button" data-weather-popup-close aria-label="Chiudi METEO"><img src="' + assetUrl('close.svg') + '" alt=""></button></header><section class="weather-popup-current" data-weather-popup-current></section><section class="weather-popup-details" data-weather-popup-details></section><section><h3>Prossime ore</h3><div class="weather-popup-hourly" data-weather-popup-hourly></div></section><section><h3>Previsioni</h3><div class="weather-popup-daily" data-weather-popup-daily></div></section>';
    dialog.querySelector('[data-weather-popup-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  updateWeatherDialog(weatherSnapshot);
  if (!dialog.open) dialog.showModal();
}

export function bindWeatherPopupTrigger(element, opener = openWeather) {
  element.addEventListener('click', opener);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); opener(); }
  });
}

export async function initFloorplan({ store = createFloorplanState(), onCameraSelect = showCamera, onCameraEventsSelect = () => {}, onCameraPrivacyToggle = async (id, enabled) => {
  const response = await fetch(homeControlPath('/api/cameras/' + id + '/privacy'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  if (!response.ok) throw new Error('Comando Privacy non disponibile');
  return response.json();
}, onCameraPrivacyRead = async id => {
  const response = await fetch(homeControlPath('/api/cameras/' + id + '/privacy'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Privacy non disponibile');
  return response.json();
}, onCameraDetectionToggle = async (id, enabled) => {
  const response = await fetch(homeControlPath('/api/cameras/' + id + '/detection'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
  if (!response.ok) throw new Error('Comando Rilevazione non disponibile');
  return response.json();
}, onCameraDetectionRead = async id => {
  const response = await fetch(homeControlPath('/api/cameras/' + id + '/detection'), { cache: 'no-store' });
  if (!response.ok) throw new Error('Rilevazione non disponibile');
  return response.json();
}, onLightToggle = id => store.setLight(id, !store.snapshot().lights[id]), onLedbarPower = on => fetch(homeControlPath('/api/ledbar/power'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) }), onLedbarBrightness = brightness => fetch(homeControlPath('/api/ledbar/brightness'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brightness }) }) } = {}) {
  const stage = document.querySelector('[data-layered-floorplan]');
  const status = document.querySelector('[data-floorplan-status]');
  if (!stage) return;
  void switchSound.preload();
  const mappings = [];
  let floorplanClock;
  try {
    const response = await fetch(homeControlPath('/api/floorplan/assets'), { cache: 'no-store' });
    if (!response.ok) throw new Error('Elenco asset non disponibile');
    const assets = new Set((await response.json()).assets);
    const required = [...Object.values(config.backgrounds), ...config.rooms.filter(room => !room.optional).flatMap(room => [room.on, room.off]), ...Object.values(config.mappings).filter(name => name !== config.mappings.clock), ...Object.values(config.ledbar.layers), config.icons.ledbarOn, config.icons.ledbarOff, config.icons.cappaOn, config.icons.cappaOff];
    const missing = required.filter(name => !assets.has(name));
    if (missing.length) throw new Error('Asset planimetria mancanti: ' + missing.join(', '));
    const imageLayers = new Map();
    const externalOverlayNames = new Map(Object.entries(config.externalLightOverlays).map(([lightId, name]) => [name, lightId]));
    // Place exterior effects immediately above the base, before every interactive mapping overlay.
    const staticLayerNames = [...Object.values(config.backgrounds), ...externalOverlayNames.keys(), ...config.rooms.flatMap(room => [room.off, room.on].filter(name => !room.optional || assets.has(name))), ...Object.values(config.ledbar.layers), config.mappings.integration];
    await Promise.all(staticLayerNames.map(name => new Promise((resolve, reject) => {
      const externalLightId = externalOverlayNames.get(name);
      if (externalLightId && !assets.has(name)) {
        console.warn('Overlay luce esterna non disponibile: ' + name);
        resolve();
        return;
      }
      const image = document.createElement('img');
      image.className = 'floorplan-stack-layer';
      if (externalLightId) image.classList.add('floorplan-external-light-overlay');
      image.alt = '';
      image.hidden = true;
      image.dataset.layer = name;
      if (externalLightId) image.dataset.externalLightOverlay = externalLightId;
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', () => {
        image.remove();
        if (externalLightId) {
          console.warn('Overlay luce esterna non caricabile: ' + name);
          resolve();
          return;
        }
        reject(new Error('Impossibile caricare ' + name));
      }, { once: true });
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
    imageLayers.get(config.mappings.integration).hidden = false;
    const lightMapping = await loadMapping(config.mappings.lights, stage); mappings.push(lightMapping);
    const sensorMapping = await loadMapping(config.mappings.sensors, stage); mappings.push(sensorMapping);
    const cameraMapping = await loadMapping(config.mappings.cameras, stage); mappings.push(cameraMapping);
    const boilerMapping = await loadMapping(config.mappings.boiler, stage); mappings.push(boilerMapping);
    const cappaMapping = await loadMapping(config.mappings.cappa, stage); mappings.push(cappaMapping);
    const weatherMapping = await loadMapping(config.mappings.weather, stage); mappings.push(weatherMapping);
    const integrationMapping = await loadMapping(config.mappings.integration, stage); mappings.push(integrationMapping);
    // LAYER-17 is a hidden geometric source only; it is never a painted stack layer.
    const ledbarMapping = await loadMapping(config.mappings.ledbar, stage); mappings.push(ledbarMapping);
    // The decorative clock is isolated: any asset, marker or module failure leaves the Dashboard available.
    try {
      const { createFloorplanClock } = await import('./floorplan-clock.js');
      const clockMapping = await loadMapping(config.mappings.clock, stage); mappings.push(clockMapping);
      floorplanClock = createFloorplanClock({ overlay: clockMapping.overlay, box: clockMapping.box(config.clock.marker) });
    } catch (error) {
      console.warn('Orologio planimetria non disponibile', error);
    }
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
    const ledbarMarker = markerElement('Barre LED cucina', true);
    ledbarMarker.classList.add('floorplan-marker-ledbar');
    ledbarMarker.removeAttribute('title');
    ledbarMarker.addEventListener('click', () => {
      const ledbar = store.snapshot().ledbar;
      if (!ledbar.available) return;
      void onLedbarPower(ledbar.state !== 'ON');
      switchSound.play();
    });
    placeHtml(ledbarMapping, config.ledbar.marker, ledbarMarker, true);
    const ledbarSlider = document.createElement('input');
    ledbarSlider.type = 'range'; ledbarSlider.min = '0'; ledbarSlider.max = '254'; ledbarSlider.step = '1';
    ledbarSlider.className = 'floorplan-ledbar-slider';
    ledbarSlider.setAttribute('aria-label', 'Luminosità barre LED cucina');
    let ledbarThrottle;
    const sendLedbarBrightness = () => {
      clearTimeout(ledbarThrottle);
      const brightness = Number(ledbarSlider.value);
      if (Number.isInteger(brightness)) void onLedbarBrightness(brightness);
    };
    ledbarSlider.addEventListener('input', () => { clearTimeout(ledbarThrottle); ledbarThrottle = setTimeout(sendLedbarBrightness, 150); });
    ledbarSlider.addEventListener('change', sendLedbarBrightness);
    placeHtml(ledbarMapping, config.ledbar.slider, ledbarSlider, true);
    const sensorReadings = new Map();
    const sensorHumidityReadings = new Map();
    const sensorTypography = { fontSize: sensorReadingFontSize(sensorMapping.box(config.sensors.find(sensor => sensor.id === 'S3').reading)) };
    for (const sensor of config.sensors) {
      const zigbee = ['S1', 'S2', 'S4'].includes(sensor.id);
      const element = markerElement('Temperatura ' + sensor.room, zigbee);
      element.classList.add('floorplan-marker-sensor');
      element.append(createIcon(assets, config.icons.sensor, '🌡'));
      placeHtml(sensorMapping, sensor.marker, element);
      const box = sensorMapping.box(sensor.reading);
      const text = svgElement('text', { x: box.x + box.width / 2, y: box.y + box.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': sensorTypography.fontSize, class: 'floorplan-reading' });
      text.dataset.sensorReading = sensor.id;
      if (zigbee) {
        text.setAttribute('aria-label', 'Apri sensore ' + sensor.room);
        const opener = () => showSensorPopup(sensor.id, store.snapshot().sensorDetails[sensor.id]);
        bindSensorPopupTrigger(element, opener);
        bindSensorPopupTrigger(text, opener);
      }
      sensorMapping.overlay.append(text);
      sensorReadings.set(sensor.id, text);
      if (sensor.humidityReading) {
        const humidityBox = sensorMapping.box(sensor.humidityReading);
        const humidity = svgElement('text', { x: humidityBox.x + humidityBox.width / 2, y: humidityBox.y + humidityBox.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': sensorTypography.fontSize, class: 'floorplan-reading' });
        humidity.dataset.sensorHumidityReading = sensor.id;
        if (zigbee) bindSensorPopupTrigger(humidity, () => showSensorPopup(sensor.id, store.snapshot().sensorDetails[sensor.id]));
        sensorMapping.overlay.append(humidity);
        sensorHumidityReadings.set(sensor.id, humidity);
      }
    }
    const cameraControls = new Map();
    const detectionPending = new Set();
    const privacyPending = new Set();
    for (const camera of config.cameras) {
      const element = markerElement('Camera ' + camera.room, true);
      element.classList.add('floorplan-marker-camera');
      element.dataset.cameraId = camera.id;
      element.append(createIcon(assets, config.icons.camera, '📷'));
      element.addEventListener('click', () => onCameraSelect({ ...camera, status: store.snapshot().cameras[camera.id] }));
      placeHtmlOptional(cameraMapping, camera.marker, element, true, camera.id);
      const controls = {};
      for (const [kind, marker] of Object.entries(camera.controls)) {
        const control = markerElement(kind === 'events' ? 'Eventi recenti ' + camera.room : kind + ' ' + camera.room, true);
        control.classList.add('floorplan-marker-camera-aux');
        control.dataset.cameraControl = kind;
        control.dataset.cameraId = camera.id;
        control.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          if (kind === 'privacy') {
            const privacy = store.snapshot().cameras[camera.id]?.privacy;
            if (privacyPending.has(camera.id) || typeof privacy?.enabled !== 'boolean') return;
            privacyPending.add(camera.id);
            control.disabled = true;
            void onCameraPrivacyToggle(camera.id, !privacy.enabled)
              .then(readBack => store.applyCameraPrivacy(camera.id, readBack))
              .catch(() => {})
              .finally(() => { privacyPending.delete(camera.id); control.disabled = false; });
            return;
          }
          if (kind === 'detection') {
            const detection = store.snapshot().cameras[camera.id]?.detection;
            if (detectionPending.has(camera.id) || typeof detection !== 'boolean') return;
            detectionPending.add(camera.id);
            control.disabled = true;
            void onCameraDetectionToggle(camera.id, !detection)
              .then(readBack => store.applyCameraDetection(camera.id, readBack))
              .catch(() => {})
              .finally(() => { detectionPending.delete(camera.id); control.disabled = false; });
            return;
          }
          if (kind === 'events') onCameraEventsSelect({ ...camera, status: store.snapshot().cameras[camera.id] });
        });
        if (placeHtmlOptional(cameraMapping, marker, control, true, camera.id + ':' + kind)) controls[kind] = control;
      }
      cameraControls.set(camera.id, controls);
    }
    for (const camera of config.cameras.filter(camera => camera.id !== 'C3')) {
      void onCameraPrivacyRead(camera.id).then(privacy => store.applyCameraPrivacy(camera.id, privacy)).catch(() => {});
      void onCameraDetectionRead(camera.id).then(detection => store.applyCameraDetection(camera.id, detection)).catch(() => {});
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
    const settingsIcon = document.createElement('img');
    settingsIcon.src = assetUrl('option.svg');
    settingsIcon.alt = '';
    settings.append(settingsIcon);
    settings.setAttribute('aria-label', 'Programmazione CALDAIA');
    settings.href = '#boiler-programming';
    settings.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openBoiler('programming'); });
    mini.append(open, settings);
    placeHtml(boilerMapping, config.boiler.card, mini);
    const cappa = markerElement('Apri controllo CAPPA', true);
    cappa.classList.add('floorplan-marker-cappa');
    cappa.addEventListener('click', openCappa);
    placeHtml(cappaMapping, config.cappa.marker, cappa);
    const weatherMarker = markerElement('Apri METEO OGGI', true);
    weatherMarker.classList.add('floorplan-marker-weather');
    bindWeatherPopupTrigger(weatherMarker);
    placeHtml(weatherMapping, config.weather.marker, weatherMarker);
    const weatherCard = document.createElement('article');
    weatherCard.className = 'floorplan-weather-card';
    weatherCard.setAttribute('aria-label', 'Apri METEO OGGI');
    weatherCard.tabIndex = 0;
    weatherCard.setAttribute('role', 'button');
    bindWeatherPopupTrigger(weatherCard);
    placeHtml(weatherMapping, config.weather.card, weatherCard);
    const weatherTemperatureBox = weatherMapping.box(config.weather.temperatureLabel);
    const weatherTemperatureReading = svgElement('text', { x: weatherTemperatureBox.x + weatherTemperatureBox.width / 2, y: weatherTemperatureBox.y + weatherTemperatureBox.height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': weatherTemperatureBox.height * .34, class: 'floorplan-reading' });
    weatherTemperatureReading.dataset.weatherTemperature = '';
    weatherMapping.overlay.append(weatherTemperatureReading);
    const integrationTitle = document.createElement('div');
    integrationTitle.className = 'floorplan-integration-title';
    integrationTitle.setAttribute('aria-label', 'Home Control');
    integrationTitle.innerHTML = '<span class="floorplan-integration-home">HOME</span><span class="floorplan-integration-control">CONTROL</span>';
    placeHtml(integrationMapping, config.integration.title, integrationTitle);
    const integrationOptions = document.createElement('a');
    integrationOptions.className = 'floorplan-integration-options';
    integrationOptions.href = homeControlPath('/settings');
    integrationOptions.setAttribute('aria-label', 'Apri Impostazioni');
    integrationOptions.title = 'Impostazioni';
    const integrationOptionsIcon = document.createElement('img');
    integrationOptionsIcon.src = assetUrl('option.svg');
    integrationOptionsIcon.alt = '';
    integrationOptions.append(integrationOptionsIcon);
    placeHtml(integrationMapping, config.integration.options, integrationOptions);
    const renderWeather = snapshot => {
      const current = snapshot?.current;
      weatherMarker.replaceChildren(weatherImage(assets, current?.icon || 'cloudy.svg'));
      weatherMarker.dataset.available = String(Boolean(current));
      weatherMarker.setAttribute('aria-label', current ? `Apri METEO OGGI · ${current.condition}, ${weatherTemperature(current.temperature)}` : 'Apri METEO OGGI · dati non disponibili');
      weatherCard.replaceChildren();
      const facts = document.createElement('div'); facts.className = 'floorplan-weather-facts';
      for (const [icon, valueText] of [['umidity.svg', weatherPercent(current?.humidity)], ['wind.svg', `${weatherNumber(current?.windSpeed)} km/h`], ['rain.svg', weatherPercent(snapshot?.today?.rainProbability)]]) {
        const fact = document.createElement('span'); fact.append(weatherImage(assets, icon), document.createTextNode(valueText)); facts.append(fact);
      }
      weatherCard.append(facts);
      weatherTemperatureReading.textContent = Number.isFinite(current?.temperature) ? current.temperature.toFixed(1) + ' °C' : '— °C';
      updateWeatherDialog(snapshot);
    };
    renderWeatherSnapshot = renderWeather;
    renderWeather(weatherSnapshot);
    let previousLights = {};
    let previousCappaPower;
    let previousLedbarOn;
    const render = state => {
      for (const room of config.rooms) {
        const on = state.lights[room.lightId] === true;
        if (imageLayers.has(room.on)) imageLayers.get(room.on).hidden = !on;
        if (imageLayers.has(room.off)) imageLayers.get(room.off).hidden = on || state.lights[room.lightId] === null;
      }
      for (const [lightId, name] of Object.entries(config.externalLightOverlays)) {
        if (imageLayers.has(name)) imageLayers.get(name).hidden = state.lights[lightId] !== true;
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
        const reading = sensorReadings.get(sensor.id);
        renderFloorplanReading(reading, value, '°C', temperatureReadingColor(value));
        const humidityReading = sensorHumidityReadings.get(sensor.id);
        if (humidityReading) {
          const humidity = state.sensorDetails[sensor.id]?.humidity;
          renderFloorplanReading(humidityReading, humidity, '%', humidityReadingColor(humidity));
        }
      }
      for (const camera of config.cameras) {
        const cameraState = state.cameras[camera.id] || {};
        const controls = cameraControls.get(camera.id) || {};
        const binaryControls = {
          detection: [config.icons.detectionOn, config.icons.detectionOff],
          alarm: [config.icons.alarmOn, config.icons.alarmOff],
        };
        for (const [kind, [onIcon, offIcon]] of Object.entries(binaryControls)) {
          const control = controls[kind];
          if (!control) continue;
          const value = cameraState[kind];
          const available = typeof value === 'boolean';
          control.dataset.available = String(available);
          control.setAttribute('aria-label', `${kind} ${camera.room}: ${available ? value ? 'ON' : 'OFF' : 'stato non disponibile'}`);
          if (kind === 'detection' && !available) control.replaceChildren(document.createTextNode('?'));
          else control.replaceChildren(createIcon(assets, available && value ? onIcon : offIcon, '?'));
        }
        const privacy = controls.privacy;
        if (privacy) {
          const value = cameraState.privacy?.enabled;
          const available = typeof value === 'boolean';
          privacy.dataset.available = String(available);
          privacy.setAttribute('aria-label', `privacy ${camera.room}: ${available ? value ? 'ON' : 'OFF' : 'stato non disponibile'}`);
          if (!available) privacy.replaceChildren(document.createTextNode('?'));
          else privacy.replaceChildren(createIcon(assets, value ? config.icons.privacyOn : config.icons.privacyOff, '?'));
        }
        const battery = controls.battery;
        if (battery) {
          const available = cameraState.battery?.available === true;
          const percent = available ? cameraState.battery.percent : null;
          const icon = cameraBatteryIcon(cameraState.battery);
          battery.dataset.available = String(available);
          battery.setAttribute('aria-label', `Batteria ${camera.room}: ${available ? percent + '%' + (cameraState.battery.charging ? ', in carica' : '') : 'non disponibile'}`);
          battery.replaceChildren(icon ? createIcon(assets, icon, '▰') : document.createTextNode('—'));
        }
        const events = controls.events;
        if (events) {
          const available = cameraState.events?.available === true;
          events.dataset.available = String(available);
          events.textContent = available ? String(cameraState.events.count) : '—';
          events.setAttribute('aria-label', `Eventi ${camera.room}, ultime 12 ore: ${available ? cameraState.events.count : 'non disponibili'}`);
        }
      }
      const ledbar = state.ledbar;
      const ledbarLayer = ledbarLayerFor(ledbar);
      for (const [key, name] of Object.entries(config.ledbar.layers)) imageLayers.get(name).hidden = key !== ledbarLayer;
      const ledbarOn = ledbar.state === 'ON';
      ledbarMarker.dataset.on = String(ledbarOn);
      // Keep the controls usable while the retained MQTT state is arriving; the API remains authoritative.
      ledbarMarker.disabled = ledbar.online === false && ledbar.state === null;
      ledbarMarker.setAttribute('aria-pressed', String(ledbarOn));
      ledbarMarker.setAttribute('aria-label', 'Barre LED cucina: ' + (ledbar.available ? ledbarOn ? 'ON' : 'OFF' : 'non disponibili'));
      if (previousLedbarOn !== ledbarOn) ledbarMarker.replaceChildren(createIcon(assets, ledbarOn ? config.icons.ledbarOn : config.icons.ledbarOff, '━'));
      previousLedbarOn = ledbarOn;
      if (Number.isInteger(ledbar.brightness)) ledbarSlider.value = String(ledbar.brightness);
      ledbarSlider.disabled = ledbar.online === false && ledbar.state === null;
      updateSensorPopup(state.sensorDetails);
      open.setAttribute('aria-label', 'Apri CALDAIA completa · ' + (state.boiler.on === null ? 'stato non disponibile' : state.boiler.on ? 'riscaldamento ON' : 'riscaldamento OFF') + ' · ' + (state.boiler.mode || 'modalità non disponibile'));
      renderBoilerMini(open, state.boiler);
      const cappaPower = typeof state.hood.power === 'boolean' ? state.hood.power : previousCappaPower ?? false;
      cappa.dataset.on = String(cappaPower);
      cappa.dataset.online = String(state.hood.online === true);
      cappa.setAttribute('aria-label', 'Apri controllo CAPPA · ' + (state.hood.online ? cappaPower ? 'ON' : 'OFF' : 'stato non disponibile'));
      if (cappaPower !== previousCappaPower) cappa.replaceChildren(createIcon(assets, cappaPower ? config.icons.cappaOn : config.icons.cappaOff, '⌂'));
      previousCappaPower = cappaPower;
    };
    render(store.snapshot());
    const unsubscribe = store.subscribe(render);
    const ledbarEvents = typeof EventSource === 'function' ? new EventSource(homeControlPath('/api/ledbar/events')) : null;
    if (ledbarEvents) ledbarEvents.onmessage = event => {
      try { store.applyLedbarSnapshot(JSON.parse(event.data)); } catch { /* A malformed event must not break the floorplan. */ }
    };

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
    return { store, destroy() { clearTimeout(timer); clearTimeout(ledbarThrottle); ledbarEvents?.close(); unsubscribe(); document.removeEventListener('visibilitychange', tick); window.removeEventListener('pageshow', tick); floorplanClock?.destroy(); if (renderWeatherSnapshot === renderWeather) renderWeatherSnapshot = () => {}; stage.replaceChildren(); } };
  } catch (error) {
    status.textContent = error.message;
  } finally {
    for (const mapping of mappings) mapping.dispose();
  }
}
