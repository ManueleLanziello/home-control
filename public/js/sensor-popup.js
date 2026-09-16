const number = value => Number.isFinite(value)
  ? new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value) : '—';

export function sensorReadingLines(sensor = {}) {
  return [`${number(sensor.temperature)} °C`, `${number(sensor.humidity)} %`];
}

export function sensorPopupRows(sensor = {}) {
  return [
    ['Temperatura', `${number(sensor.temperature)} °C`],
    ['Umidità', `${number(sensor.humidity)} %`],
    ['Batteria', Number.isFinite(sensor.battery) ? `${sensor.battery} %` : '—'],
    ['Segnale Zigbee (LQI)', Number.isFinite(sensor.linkQuality) ? String(sensor.linkQuality) : '—'],
    ['Stato', sensor.online === true ? 'Online' : 'Offline'],
    ['Ultimo aggiornamento', Number.isFinite(Date.parse(sensor.updatedAt))
      ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sensor.updatedAt)) : '—'],
    ['Protocollo', 'Zigbee'],
  ];
}

function renderPopup(dialog, id, sensor = {}) {
  dialog.dataset.sensorId = id;
  dialog.querySelector('[data-sensor-name]').textContent = sensor.name || `SmartHome${id}`;
  dialog.querySelector('[data-sensor-model]').textContent = 'SONOFF SNZB-02P';
  const details = dialog.querySelector('[data-sensor-details]');
  details.replaceChildren();
  for (const [label, value] of sensorPopupRows(sensor)) {
    const row = document.createElement('div');
    const title = document.createElement('span'); title.textContent = label;
    const reading = document.createElement('strong'); reading.textContent = value;
    row.append(title, reading);
    details.append(row);
  }
}

export function showSensorPopup(id, sensor) {
  let dialog = document.querySelector('[data-sensor-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.dataset.sensorDialog = '';
    dialog.className = 'sensor-dialog';
    dialog.setAttribute('aria-labelledby', 'sensor-popup-name');
    dialog.innerHTML = '<header><div><h2 id="sensor-popup-name" data-sensor-name></h2><p data-sensor-model></p></div><button type="button" data-sensor-close aria-label="Chiudi sensore">X</button></header><section data-sensor-details></section>';
    dialog.querySelector('[data-sensor-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  renderPopup(dialog, id, sensor);
  if (!dialog.open) dialog.showModal();
}

export function updateSensorPopup(sensors) {
  const dialog = document.querySelector('[data-sensor-dialog]');
  if (dialog?.open) renderPopup(dialog, dialog.dataset.sensorId, sensors[dialog.dataset.sensorId]);
}

export function bindSensorPopupTrigger(element, opener) {
  element.classList.add('floorplan-sensor-trigger');
  element.addEventListener('click', opener);
  if (element.tagName.toLowerCase() !== 'button') {
    element.setAttribute('role', 'button');
    element.setAttribute('tabindex', '0');
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); opener(); }
    });
  }
}
