import { renderWt200Schedule } from './boiler-schedule.js';
import { homeControlPath } from '../base-path.js';

const NORMAL_NAMES = ['Mattina presto', 'Mattina', 'Mezzogiorno', 'Pomeriggio', 'Sera', 'Notte'];
let snapshot = null;
let draft = null;
let saving = false;

function temperatureText(value) {
  if (!Number.isFinite(value)) return '— °C';
  return `${new Intl.NumberFormat('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} °C`;
}

function booleanText(value) {
  if (value === true) return 'Attivo';
  if (value === false) return 'Disattivo';
  return '—';
}

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.textContent = value;
}

function cloneSchedule(schedule) {
  return schedule ? structuredClone(schedule) : null;
}

function periodRow(period, name, group, index) {
  const time = `${String(period.hour).padStart(2, '0')}:${String(period.minute).padStart(2, '0')}`;
  return `<label class="thermostat-period"><strong>${name}</strong><span>Ora<input required type="time" data-group="${group}" data-index="${index}" data-field="time" value="${time}"></span><span>Temperatura<input required type="number" step="0.1" data-group="${group}" data-index="${index}" data-field="temperature" value="${period.temperature}"> °C</span></label>`;
}

function renderEditor() {
  const normal = document.querySelector('[data-normal-periods]');
  const rest = document.querySelector('[data-rest-periods]');
  const save = document.querySelector('[data-schedule-save]');
  const pattern = document.querySelector('[data-thermostat-week-pattern]');
  if (!normal || !rest || !save || !pattern) return;
  pattern.textContent = `Modalita settimanale: ${draft?.weekPattern || 'non disponibile'}`;
  normal.innerHTML = draft ? draft.normalPeriods.map((period, index) => periodRow(period, NORMAL_NAMES[index], 'normalPeriods', index)).join('') : '';
  rest.innerHTML = draft ? draft.restDayPeriods.map((period, index) => periodRow(period, `Fascia riposo ${index + 1}`, 'restDayPeriods', index)).join('') : '';
  const changed = JSON.stringify(draft?.normalPeriods) !== JSON.stringify(snapshot?.schedule?.normalPeriods)
    || JSON.stringify(draft?.restDayPeriods) !== JSON.stringify(snapshot?.schedule?.restDayPeriods);
  save.disabled = !draft || saving || !changed;
}

function renderDraft() {
  renderWt200Schedule(document.querySelector('[data-boiler-schedule]'), draft);
  renderEditor();
}

function renderThermostat(snapshot = null) {
  const thermostat = snapshot?.thermostat || {};
  const online = snapshot?.online === true;
  const onlineElement = document.querySelector('[data-thermostat-online]');
  if (onlineElement) {
    onlineElement.textContent = online ? 'Online' : 'Offline';
    onlineElement.classList.toggle('static-status--online', online);
    onlineElement.classList.toggle('static-status--offline', !online);
  }
  setText('[data-thermostat-current]', temperatureText(thermostat.currentTemperature));
  setText('[data-thermostat-setpoint]', temperatureText(thermostat.setpointTemperature));
  setText('[data-thermostat-mode]', thermostat.mode || '—');
  setText('[data-thermostat-heating]', snapshot?.heatingActive === true ? 'Attivo' : snapshot?.heatingActive === false ? 'Inattivo' : 'Non disponibile');
  setText('[data-thermostat-frost]', booleanText(thermostat.frostProtection));
  setText('[data-thermostat-lock]', booleanText(thermostat.childLock));
  renderWt200Schedule(document.querySelector('[data-boiler-schedule]'), snapshot?.schedule);
}

async function loadThermostat() {
  try {
    const response = await fetch(homeControlPath('/api/thermostat'));
    if (!response.ok) throw new Error('Termostato non disponibile');
    snapshot = await response.json();
    draft = cloneSchedule(snapshot.schedule);
    renderThermostat(snapshot);
    renderEditor();
  } catch {
    renderThermostat();
  }
}

renderThermostat();
void loadThermostat();

document.querySelector('[data-schedule-form]')?.addEventListener('input', (event) => {
  const input = event.target;
  if (!draft || !input.dataset.group) return;
  const period = draft[input.dataset.group][Number(input.dataset.index)];
  if (input.dataset.field === 'time') [period.hour, period.minute] = input.value.split(':').map(Number);
  if (input.dataset.field === 'temperature') period.temperature = Number(input.value);
  renderDraft();
});

document.querySelector('[data-schedule-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!draft || saving) return;
  saving = true;
  renderEditor();
  const message = document.querySelector('[data-schedule-message]');
  try {
    const response = await fetch(homeControlPath('/api/thermostat/schedule'), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normalPeriods: draft.normalPeriods, restDayPeriods: draft.restDayPeriods }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Salvataggio non riuscito');
    draft = cloneSchedule(result.schedule);
    snapshot = { ...snapshot, schedule: draft };
    if (message) message.textContent = 'Programmazione salvata';
  } catch (error) {
    if (message) message.textContent = error.message;
  } finally {
    saving = false;
    renderDraft();
  }
});
