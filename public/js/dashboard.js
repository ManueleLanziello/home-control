const FLOORPLAN_VIEWBOX = { x: 1763.5, y: 1736.5, width: 1656, height: 1723 };
const REFERENCE_VIEWBOX = { x: 925, y: 1730, width: 3343, height: 1731 };

const deviceOverlays = [
  { id: 'temperature-cucina', type: 'temperature', room: 'Cucina', x: 3.08, y: 3.25, width: 11.715, height: 11.317 },
  { id: 'temperature-camera-matrimoniale', type: 'temperature', room: 'Camera matrimoniale', x: 84.601, y: 3.25, width: 11.715, height: 11.317 },
  { id: 'temperature-salotto', type: 'temperature', room: 'Salotto', temperatureSource: 'thermostat.currentTemperature', x: 3.08, y: 86.709, width: 11.715, height: 11.259 },
  { id: 'temperature-camera-ragazzi', type: 'temperature', room: 'Camera ragazzi', x: 84.601, y: 86.709, width: 11.715, height: 11.259 },
  { id: 'light-cucina', type: 'light', room: 'Cucina', x: 20.35, y: 16.019, width: 11.715, height: 11.259 },
  { id: 'light-camera-matrimoniale', type: 'light', room: 'Camera matrimoniale', x: 67.452, y: 15.554, width: 11.715, height: 11.259 },
  { id: 'light-disimpegno', type: 'light', room: 'Disimpegno', x: 53.502, y: 47.243, width: 11.775, height: 11.259 },
  { id: 'light-bagno', type: 'light', room: 'Bagno', x: 77.597, y: 47.243, width: 11.715, height: 11.259 },
  { id: 'light-salotto', type: 'light', room: 'Salotto', x: 20.229, y: 63.146, width: 11.775, height: 11.317 },
  { id: 'light-camera-ragazzi', type: 'light', room: 'Camera ragazzi', x: 67.572, y: 76.436, width: 11.775, height: 11.259 },
];

const roomLabels = [
  { id: 'label-cucina', name: 'Cucina', x: 34.8, y: 10.3, compact: false },
  { id: 'label-camera-matrimoniale', name: 'Camera matrimoniale', x: 61.2, y: 10.2, compact: true },
  { id: 'label-salotto', name: 'Salotto', x: 29.5, y: 50.1, compact: false },
  { id: 'label-bagno', name: 'Bagno', x: 87.4, y: 40.4, compact: false },
  { id: 'label-camera-ragazzi', name: 'Camera ragazzi', x: 68.8, y: 68.4, compact: true },
];

const externalLights = [
  { id: 'external-light-garden', title: 'Luce esterna', label: 'Giardino', sourceBox: { x: 9.767, y: 16.551, width: 5.803, height: 11.207 } },
  { id: 'external-light-courtyard', title: 'Luce esterna', label: 'Cortile', sourceBox: { x: 83.832, y: 69.931, width: 5.803, height: 11.207 } },
];

function lightIcon(className = 'device-icon') {
  return `
    <svg class="${className}" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M20 29c0-7.2 5.5-13 12-13s12 5.8 12 13c0 4.2-1.9 7.1-4.4 10.3-1.8 2.3-2.9 4.2-3.3 6.7h-8.6c-.4-2.5-1.5-4.4-3.3-6.7C21.9 36.1 20 33.2 20 29Z"/>
      <path d="M27 50h10M28.5 55h7"/>
    </svg>
  `;
}

function temperatureIcon(className = 'temperature-icon') {
  return `
    <svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14.2V5.5a2 2 0 1 1 4 0v8.7a4.4 4.4 0 1 1-4 0Z"/>
      <path d="M12 7v8.7"/>
    </svg>
  `;
}

function cameraIcon() {
  return `
    <svg class="widget-icon widget-icon--camera" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="26" r="15"/>
      <circle cx="32" cy="26" r="6"/>
      <path d="M24 45h16M28 45l-4 9M36 45l4 9M24 54h16M32 11v-5"/>
    </svg>
  `;
}

function boilerIcon() {
  return `
    <svg class="widget-icon widget-icon--boiler" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M24 22h16a4 4 0 0 1 4 4v24H20V26a4 4 0 0 1 4-4Z"/>
      <path d="M26 34h12M28 44h8M25 14c-3-4 3-6 0-10M33 14c-3-4 3-6 0-10M41 14c-3-4 3-6 0-10"/>
      <circle cx="40" cy="34" r="1.8"/>
    </svg>
  `;
}

function setPercentBox(element, item) {
  element.style.setProperty('--x', `${item.x}%`);
  element.style.setProperty('--y', `${item.y}%`);
  element.style.setProperty('--w', `${item.width}%`);
  element.style.setProperty('--h', `${item.height}%`);
}

function createLight(item) {
  const element = document.createElement('div');
  element.className = 'floorplan-device floorplan-device--light';
  element.id = item.id;
  element.setAttribute('aria-label', `Placeholder luce ${item.room}`);
  element.setAttribute('data-device-type', item.type);
  setPercentBox(element, item);
  element.innerHTML = lightIcon();
  return element;
}

function createTemperature(item) {
  const element = document.createElement('div');
  element.className = 'floorplan-device floorplan-device--temperature is-unavailable';
  element.id = item.id;
  element.setAttribute('aria-label', `Temperatura ${item.room}: non disponibile`);
  element.setAttribute('data-device-type', item.type);
  if (item.temperatureSource) element.dataset.temperatureSource = item.temperatureSource;
  setPercentBox(element, item);
  element.innerHTML = `${temperatureIcon()}<span>— °C</span>`;
  return element;
}

function createExternalLight(item) {
  const element = document.createElement('article');
  element.className = 'external-light-card neon-card';
  element.id = item.id;
  element.setAttribute('aria-label', `${item.title} ${item.label}`);
  element.setAttribute('data-widget-type', 'external-light');
  element.innerHTML = `
    <div>
      <strong>${item.title}</strong>
      <span>${item.label}</span>
    </div>
    <div class="external-light-bulb" aria-hidden="true">${lightIcon('device-icon device-icon--external')}</div>
  `;
  return element;
}

function renderFloorplan() {
  const deviceLayer = document.querySelector('[data-floorplan-devices]');
  const labelLayer = document.querySelector('[data-floorplan-labels]');
  if (!deviceLayer || !labelLayer) return;

  const fragment = document.createDocumentFragment();
  for (const item of deviceOverlays) {
    fragment.append(item.type === 'light' ? createLight(item) : createTemperature(item));
  }
  deviceLayer.append(fragment);

  const labelFragment = document.createDocumentFragment();
  for (const label of roomLabels) {
    const element = document.createElement('span');
    element.className = `room-label${label.compact ? ' room-label--compact' : ''}`;
    element.id = label.id;
    element.style.setProperty('--x', `${label.x}%`);
    element.style.setProperty('--y', `${label.y}%`);
    element.textContent = label.name;
    labelFragment.append(element);
  }
  labelLayer.append(labelFragment);
}

function renderExternalLights() {
  const slots = document.querySelectorAll('[data-external-light-slot]');
  for (const slot of slots) {
    const light = externalLights.find((item) => item.id === slot.dataset.externalLightSlot);
    if (light) slot.append(createExternalLight(light));
  }
}

function renderWidgetIcons() {
  const cameraSlot = document.querySelector('[data-camera-icon]');
  const boilerSlot = document.querySelector('[data-boiler-icon]');
  if (cameraSlot) cameraSlot.innerHTML = cameraIcon();
  if (boilerSlot) boilerSlot.innerHTML = boilerIcon();
}

function temperatureText(value) {
  if (!Number.isFinite(value)) return '— °C';
  return `${new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} °C`;
}

function booleanText(value) {
  if (value === true) return 'Attivo';
  if (value === false) return 'Disattivo';
  return '—';
}

function updatedAtText(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function renderFloorplanThermostatTemperature(snapshot) {
  const marker = document.querySelector('[data-temperature-source="thermostat.currentTemperature"]');
  if (!marker) return;

  const value = snapshot?.thermostat?.currentTemperature;
  const available = Number.isFinite(value);
  marker.classList.toggle('is-unavailable', !available);
  marker.querySelector('span').textContent = available ? temperatureText(value) : '— °C';
  marker.setAttribute('aria-label', available ? `Temperatura Salotto: ${temperatureText(value)}` : 'Temperatura Salotto: non disponibile');
}

function renderBoiler(snapshot = null) {
  const thermostat = snapshot?.thermostat || {};
  const online = snapshot?.online === true;
  const onlineElement = document.querySelector('[data-boiler-online]');
  const setpoint = document.querySelector('[data-boiler-setpoint]');
  const current = document.querySelector('[data-boiler-current]');
  const frost = document.querySelector('[data-boiler-frost]');
  const lock = document.querySelector('[data-boiler-lock]');
  const updated = document.querySelector('[data-boiler-updated]');
  const rawMode = document.querySelector('[data-boiler-raw-mode]');

  if (onlineElement) {
    onlineElement.textContent = online ? 'Online' : 'Offline';
    onlineElement.classList.toggle('static-status--online', online);
    onlineElement.classList.toggle('static-status--offline', !online);
  }
  if (setpoint) setpoint.textContent = temperatureText(thermostat.setpointTemperature);
  if (current) current.textContent = temperatureText(thermostat.currentTemperature);
  if (frost) frost.textContent = booleanText(thermostat.frostProtection);
  if (lock) lock.textContent = booleanText(thermostat.childLock);
  if (updated) updated.textContent = updatedAtText(snapshot?.updatedAt);
  renderFloorplanThermostatTemperature(snapshot);

  const mode = thermostat.mode;
  for (const option of document.querySelectorAll('[data-boiler-mode-option]')) {
    option.classList.toggle('is-active', option.dataset.boilerModeOption === mode);
  }
  if (rawMode) {
    const isKnown = mode === 'manual' || mode === 'auto';
    rawMode.hidden = !mode || isKnown;
    rawMode.textContent = isKnown || !mode ? '' : `Stato WT200: ${mode}`;
  }
}

async function loadBoilerSnapshot() {
  try {
    const response = await fetch('/api/thermostat');
    if (!response.ok) throw new Error('Termostato non disponibile');
    renderBoiler(await response.json());
  } catch {
    renderBoiler();
  }
}

function renderDashboard() {
  renderFloorplan();
  renderExternalLights();
  renderWidgetIcons();
  renderBoiler();
  void loadBoilerSnapshot();
}

window.homeControlFloorplan = {
  floorplanViewBox: FLOORPLAN_VIEWBOX,
  referenceViewBox: REFERENCE_VIEWBOX,
  deviceOverlays,
  externalLights,
  roomLabels,
};

renderDashboard();
