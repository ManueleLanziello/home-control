const number = value => Number.isFinite(value)
  ? new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value) : '—';
const temperatureOf = sensor => Number.isFinite(sensor?.temperature) ? sensor.temperature : sensor?.value;
const sensorName = (id, sensor) => sensor?.name || (id === 'S3' ? 'Avatto — Salotto' : id === 'S5' ? 'SONOFF — Temperatura acqua' : `SmartHome${id}`);
const sensorModel = (id, sensor) => id === 'S3' ? 'Termostato Avatto' : sensor?.model || (id === 'S5' ? 'SNZB-02LD' : 'SONOFF SNZB-02P');

export function minimumTemperatureFromDraft(draft) {
  const text = String(draft ?? '').trim();
  if (!text) return null;
  return Number(text.replace(',', '.'));
}

export function sensorReadingLines(sensor = {}) {
  return [`${number(temperatureOf(sensor))} °C`, `${number(sensor.humidity)} %`];
}

export function sensorPopupRows(sensor = {}, id = 'S1') {
  const rows = [['Temperatura', `${number(temperatureOf(sensor))} °C`]];
  if (id !== 'S3' && id !== 'S5' && Number.isFinite(sensor.humidity)) rows.push(['Umidità', `${number(sensor.humidity)} %`]);
  if (id !== 'S3' || Number.isFinite(sensor.battery)) rows.push(['Batteria', Number.isFinite(sensor.battery) ? `${sensor.battery} %` : '—']);
  if (id !== 'S3' || Number.isFinite(sensor.linkQuality)) rows.push(['Segnale Zigbee (LQI)', Number.isFinite(sensor.linkQuality) ? String(sensor.linkQuality) : '—']);
  rows.push(['Stato', sensor.online === true && sensor.available === true ? 'Online' : 'Offline'], ['Ultimo aggiornamento', Number.isFinite(Date.parse(sensor.updatedAt)) ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sensor.updatedAt)) : '—']);
  if (id !== 'S3' || sensor.protocol) rows.push(['Protocollo', sensor.protocol || 'Zigbee']);
  return rows;
}

function renderPopup(dialog, id, sensor = {}, options = {}) {
  dialog.dataset.sensorId = id;
  dialog._sensorOptions = options;
  dialog.querySelector('[data-sensor-name]').textContent = sensorName(id, sensor);
  dialog.querySelector('[data-sensor-model]').textContent = sensorModel(id, sensor);
  const details = dialog.querySelector('[data-sensor-details]');
  details.replaceChildren();
  for (const [label, value] of sensorPopupRows(sensor, id)) {
    const row = document.createElement('div');
    const title = document.createElement('span'); title.textContent = label;
    const reading = document.createElement('strong'); reading.textContent = value;
    row.append(title, reading);
    details.append(row);
  }
  const input = dialog.querySelector('[data-sensor-minimum-temperature]');
  const preserveDraft = options.preserveThresholdDraft === true && dialog._thresholdEditing === true;
  if (!preserveDraft) {
    input.value = Number.isFinite(options.minimumTemperature) ? String(options.minimumTemperature) : '';
    dialog._thresholdDraft = input.value;
    dialog._thresholdEditing = false;
    dialog.querySelector('[data-sensor-threshold-status]').textContent = '';
  }
  input.disabled = typeof options.saveMinimumTemperature !== 'function';
  dialog.querySelector('[data-sensor-threshold-save]').disabled = input.disabled;
  const voice = options.voiceSettings || { enabled: false, volume: 100 };
  const voiceEnabled = dialog.querySelector('[data-sensor-voice-enabled]'); const voiceVolume = dialog.querySelector('[data-sensor-voice-volume]');
  voiceEnabled.checked = voice.enabled === true; voiceVolume.value = String(Number.isFinite(voice.volume) ? voice.volume : 100);
  voiceEnabled.disabled = voiceVolume.disabled = typeof options.saveVoiceSettings !== 'function';
}

function bindVoiceForm(dialog) {
  const save = async () => {
    const enabled = dialog.querySelector('[data-sensor-voice-enabled]').checked; const volume = Number(dialog.querySelector('[data-sensor-voice-volume]').value);
    try { await dialog._sensorOptions?.saveVoiceSettings?.(dialog.dataset.sensorId, { enabled, volume }); } catch { /* The next authoritative update restores the control. */ }
  };
  dialog.querySelector('[data-sensor-voice-enabled]').addEventListener('change', save);
  dialog.querySelector('[data-sensor-voice-volume]').addEventListener('change', save);
}

function bindThresholdForm(dialog) {
  dialog.querySelector('[data-sensor-minimum-temperature]').addEventListener('input', event => {
    dialog._thresholdEditing = true;
    dialog._thresholdDraft = event.target.value;
  });
  dialog.querySelector('[data-sensor-threshold-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const input = dialog.querySelector('[data-sensor-minimum-temperature]');
    const status = dialog.querySelector('[data-sensor-threshold-status]');
    const value = minimumTemperatureFromDraft(input.value);
    if (value !== null && !Number.isFinite(value)) { status.textContent = 'Inserisci una soglia valida'; return; }
    try {
      const saved = await dialog._sensorOptions?.saveMinimumTemperature?.(dialog.dataset.sensorId, value);
      input.value = saved === null ? '' : String(saved);
      dialog._thresholdDraft = input.value;
      dialog._thresholdEditing = false;
      status.textContent = value === null ? 'Soglia rimossa' : 'Soglia salvata';
    }
    catch (error) { status.textContent = error.message || 'Soglia non salvata'; }
  });
}

export function showSensorPopup(id, sensor, options = {}) {
  let dialog = document.querySelector('[data-sensor-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.dataset.sensorDialog = '';
    dialog.className = 'sensor-dialog';
    dialog.setAttribute('aria-labelledby', 'sensor-popup-name');
    dialog.innerHTML = '<header><div><h2 id="sensor-popup-name" data-sensor-name></h2><p data-sensor-model></p></div><button type="button" data-sensor-close aria-label="Chiudi sensore">X</button></header><section data-sensor-details></section><form class="sensor-threshold-form" data-sensor-threshold-form><fieldset><legend>ALLARME TEMPERATURA MINIMA</legend><label>Soglia minima <span><input data-sensor-minimum-temperature type="text" inputmode="decimal" autocomplete="off"><em>°C</em></span></label><small data-sensor-threshold-status></small><button type="submit" data-sensor-threshold-save>SALVA</button></fieldset></form><section class="sensor-voice"><fieldset><legend>ALLARME VOCALE</legend><label><input type="checkbox" data-sensor-voice-enabled> Abilita voce</label><label>Volume <input type="range" min="0" max="100" data-sensor-voice-volume></label></fieldset></section>';
    dialog.querySelector('[data-sensor-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { dialog._thresholdDraft = ''; dialog._thresholdEditing = false; });
    bindThresholdForm(dialog);
    bindVoiceForm(dialog);
    document.body.append(dialog);
  }
  renderPopup(dialog, id, sensor, options);
  if (!dialog.open) dialog.showModal();
}

export function updateSensorPopup(sensors, options = {}) {
  const dialog = document.querySelector('[data-sensor-dialog]');
  if (dialog?.open) renderPopup(dialog, dialog.dataset.sensorId, sensors[dialog.dataset.sensorId], {
    minimumTemperature: options.minimumTemperatures?.[dialog.dataset.sensorId] ?? dialog._sensorOptions?.minimumTemperature ?? null,
    saveMinimumTemperature: options.saveMinimumTemperature ?? dialog._sensorOptions?.saveMinimumTemperature,
    voiceSettings: options.voiceSettings ?? dialog._sensorOptions?.voiceSettings,
    saveVoiceSettings: options.saveVoiceSettings ?? dialog._sensorOptions?.saveVoiceSettings,
    preserveThresholdDraft: true,
  });
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
