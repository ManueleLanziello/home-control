const VIEWBOX = { x: 926, y: 105, width: 2214, height: 2306 };

const deviceOverlays = [
  { id: 'temperature-cucina', type: 'temperature', room: 'Cucina', x: 3.184, y: 3.404, width: 11.698, height: 11.232, value: '22 °C' },
  { id: 'temperature-camera-matrimoniale', type: 'temperature', room: 'Camera matrimoniale', x: 84.485, y: 3.274, width: 11.698, height: 11.232, value: '22 °C' },
  { id: 'temperature-salotto', type: 'temperature', room: 'Salotto', x: 3.184, y: 86.535, width: 11.698, height: 11.232, value: '22 °C' },
  { id: 'temperature-camera-ragazzi', type: 'temperature', room: 'Camera ragazzi', x: 84.53, y: 86.622, width: 11.698, height: 11.232, value: '22 °C' },
  { id: 'light-cucina', type: 'light', room: 'Cucina', x: 20.393, y: 16.11, width: 11.698, height: 11.232 },
  { id: 'light-camera-matrimoniale', type: 'light', room: 'Camera matrimoniale', x: 67.367, y: 15.633, width: 11.743, height: 11.232 },
  { id: 'light-disimpegno', type: 'light', room: 'Disimpegno', x: 53.5, y: 47.203, width: 11.698, height: 11.232 },
  { id: 'light-bagno', type: 'light', room: 'Bagno', x: 77.484, y: 47.203, width: 11.698, height: 11.232 },
  { id: 'light-salotto', type: 'light', room: 'Salotto', x: 20.303, y: 63.075, width: 11.698, height: 11.232 },
  { id: 'light-camera-ragazzi', type: 'light', room: 'Camera ragazzi', x: 67.502, y: 76.258, width: 11.698, height: 11.275 },
];

const roomLabels = [
  { id: 'label-cucina', name: 'Cucina', x: 39.2, y: 13.2, compact: false },
  { id: 'label-camera-matrimoniale', name: 'Camera matrimoniale', x: 56.6, y: 12.8, compact: true },
  { id: 'label-salotto', name: 'Salotto', x: 12.6, y: 30.8, compact: false },
  { id: 'label-disimpegno', name: 'Disimpegno', x: 59.2, y: 62.4, compact: true },
  { id: 'label-bagno', name: 'Bagno', x: 88.8, y: 36.2, compact: false },
  { id: 'label-camera-ragazzi', name: 'Camera ragazzi', x: 64.2, y: 68.2, compact: true },
  { id: 'label-sgabuzzino', name: 'Sgabuzzino', x: 43.8, y: 84.2, compact: true },
];

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
  element.innerHTML = `
    <svg class="device-icon" viewBox="0 0 64 64" aria-hidden="true">
      <path d="M20 29c0-7.2 5.5-13 12-13s12 5.8 12 13c0 4.2-1.9 7.1-4.4 10.3-1.8 2.3-2.9 4.2-3.3 6.7h-8.6c-.4-2.5-1.5-4.4-3.3-6.7C21.9 36.1 20 33.2 20 29Z"/>
      <path d="M27 50h10M28.5 55h7"/>
    </svg>
  `;
  return element;
}

function createTemperature(item) {
  const element = document.createElement('div');
  element.className = 'floorplan-device floorplan-device--temperature';
  element.id = item.id;
  element.setAttribute('aria-label', `Placeholder temperatura ${item.room}: ${item.value}`);
  element.setAttribute('data-device-type', item.type);
  setPercentBox(element, item);
  element.innerHTML = `
    <svg class="temperature-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 14.2V5.5a2 2 0 1 1 4 0v8.7a4.4 4.4 0 1 1-4 0Z"/>
      <path d="M12 7v8.7"/>
    </svg>
    <span>${item.value}</span>
  `;
  return element;
}

function renderDashboard() {
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

window.homeControlFloorplan = {
  viewBox: VIEWBOX,
  deviceOverlays,
  roomLabels,
};

renderDashboard();
