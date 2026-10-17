import { homeControlPath } from '../base-path.js';
import { floorplanConfig as config } from './floorplan-config.js';
import { createAlarmAudio } from './alarm-audio.js';

const names = { DW1: 'Porta di ingresso', DW2: 'Finestra sala', DW3: 'Porta finestra sala', DW4: 'Porta finestra cucina', DW5: 'Finestra cucina', DW6: 'Porta finestra camera', DW7: 'Finestra bagno', DW8: 'Porta finestra cameretta', PR1: 'Sensore movimento interno', SR1: 'Sirena esterna' };
const time = until => { const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const request = async (path, options) => { const response = await fetch(homeControlPath(path), options); const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error || 'Operazione non disponibile'), body); return body; };
const button = (label, icon) => { const element = document.createElement('button'); element.type = 'button'; element.className = 'alarm-mode'; element.dataset.mode = label; element.innerHTML = `<img src="${homeControlPath('/design/' + icon)}" alt=""><span>${label === 'none' ? 'Nessuno' : label === 'partial' ? 'Parziale' : 'Completo'}</span>`; return element; };

// Keep visual priority independent from presentation: an alarm always wins over availability.
export function alarmVisualState(id, sensor = {}, intrusion = null) {
  if ((intrusion?.sensorIds || [intrusion?.sensorId]).includes(id) || (id === 'SR1' && sensor.active === true)) return 'alarm';
  if (sensor.available !== true) return 'unknown';
  if (sensor.batteryLow === true) return 'battery-low';
  if (id === 'PR1') return sensor.motion === true ? 'active' : 'normal';
  if (id === 'SR1') return sensor.testActive === true ? 'active' : 'normal';
  return sensor.closed === false ? 'active' : 'normal';
}

// Physical contacts have an independent source of truth. Their state is never
// inferred from the simulated alarm, and tamper remains separate from opening.
export function doorContactVisualState(contact = {}) {
  if (contact.available !== true || typeof contact.contact !== 'boolean') return 'unknown';
  if (contact.batteryLow === true) return 'battery-low';
  return contact.contact ? 'normal' : 'active';
}

export function doorContactLabel(id, contact = {}) {
  const status = contact.available !== true ? 'non disponibile o stato storico' : contact.contact === true ? 'chiuso' : contact.contact === false ? 'aperto' : 'sconosciuto';
  const tamper = contact.tamperState === 'detected' ? 'manomissione rilevata' : contact.tamperState === 'normal' ? 'manomissione assente' : 'manomissione sconosciuta';
  return `${id} — ${names[id]}: ${status}; ${tamper}`;
}

export function motionSensorVisualState(sensor = {}) {
  if (sensor.available !== true || typeof sensor.occupancy !== 'boolean') return 'unknown';
  if (sensor.battery !== null && sensor.battery !== undefined && sensor.battery <= 20) return 'battery-low';
  return sensor.occupancy ? 'active' : 'normal';
}

export async function initAlarmFloorplan({ mapping, assets, placeHtml, createIcon }) {
  const marker = (label, interactive = true) => { const el = document.createElement('button'); el.type = 'button'; el.className = 'floorplan-marker'; el.setAttribute('aria-label', label); el.disabled = !interactive; return el; };
  const modal = document.createElement('dialog'); modal.className = 'alarm-dialog'; modal.innerHTML = '<header><div><strong>ANTIFURTO</strong><small>SIMULAZIONE — nessun dispositivo reale collegato</small></div><button type="button" data-close aria-label="Chiudi">×</button></header><p data-alarm-message></p><div class="alarm-modes"></div><label>Tempo di inserimento<select data-arming><option value="1">1 minuto</option><option value="2">2 minuti</option><option value="3">3 minuti</option></select></label><label>Tempo di ritardo<select data-delay><option value="1">1 minuto</option><option value="2">2 minuti</option><option value="3">3 minuti</option></select></label><section class="alarm-audio"><strong>AUDIO ANTIFURTO</strong><label><input type="checkbox" data-audio-enabled> Abilita audio su questo dispositivo</label><label>Volume <input type="range" min="0" max="100" data-audio-volume></label><button type="button" data-audio-test>Prova voce</button><small data-audio-status></small></section><section class="alarm-problems" data-problems hidden></section><details><summary>Controlli simulazione</summary><div class="alarm-simulation" data-simulation></div></details>';
  document.body.append(modal); modal.querySelector('[data-close]').onclick = () => modal.close();
  const audioStatus = modal.querySelector('[data-audio-status]'); const alarmAudio = createAlarmAudio({ onBlocked: message => { audioStatus.textContent = message; } }); const audioSettings = alarmAudio.settings(); const audioEnabled = modal.querySelector('[data-audio-enabled]'); const audioVolume = modal.querySelector('[data-audio-volume]'); audioEnabled.checked = audioSettings.enabled; audioVolume.value = audioSettings.volume; audioEnabled.onchange = () => { alarmAudio.setEnabled(audioEnabled.checked); audioStatus.textContent = ''; }; audioVolume.oninput = () => alarmAudio.setVolume(audioVolume.value); modal.querySelector('[data-audio-test]').onclick = () => alarmAudio.test(); alarmAudio.connect();
  const modes = modal.querySelector('.alarm-modes'); [['none', config.icons.alarmNone], ['partial', config.icons.alarmPartial], ['complete', config.icons.alarmComplete]].forEach(([mode, icon]) => { const control = button(mode, icon); control.onclick = async () => { try { state = await request('/api/alarm/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); render(); } catch (error) { state = await request('/api/alarm'); state.armingError = error.blocked || []; render(); } }; modes.append(control); });
  const saveSettings = () => request('/api/alarm/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armingMinutes: Number(modal.querySelector('[data-arming]').value), delayMinutes: Number(modal.querySelector('[data-delay]').value) }) }).then(next => { state = next; render(); }).catch(() => {});
  modal.querySelector('[data-arming]').onchange = saveSettings; modal.querySelector('[data-delay]').onchange = saveSettings;
  let state = null; let doorContacts = {}; let motionSensor = null; const sensorMarkers = new Map();
  const open = () => { render(); if (!modal.open) modal.showModal(); };
  const main = marker('Apri antifurto'); main.append(createIcon(assets, config.icons.alarm, '', { immediate: true })); main.onclick = open; placeHtml(mapping, config.alarm.marker, main, true);
  const card = marker('Apri antifurto'); card.classList.add('floorplan-marker-alarm-card'); card.onclick = open; placeHtml(mapping, config.alarm.card, card, true);
  for (const item of config.alarm.sensors) {
    const element = marker(`${item.id} — ${names[item.id]}`); element.classList.add('floorplan-marker-alarm-sensor'); element.dataset.alarmSensorId = item.id; element.append(createIcon(assets, item.id === 'SR1' ? config.icons.alarmOn : item.id === 'PR1' ? config.icons.alarmMotion : config.icons.alarmDoor, '', { immediate: true })); element.onclick = () => showSensor(item.id); placeHtml(mapping, item.marker, element, true); sensorMarkers.set(item.id, element);
  }
  function showSensor(id) {
    const contact = doorContacts[id] || {}; const sensor = state?.sensors?.[id] || {}; const realContact = /^DW[1-8]$/.test(id); const realMotion = id === 'PR1'; const source = realMotion ? motionSensor || {} : sensor;
    const status = realContact ? contact.available !== true ? 'Non disponibile / dato storico' : contact.contact === true ? 'Chiuso' : contact.contact === false ? 'Aperto' : 'Sconosciuto' : realMotion ? source.available !== true || typeof source.occupancy !== 'boolean' ? 'Sconosciuto / non disponibile' : source.occupancy ? 'Movimento rilevato' : 'Nessun movimento' : id === 'SR1' ? sensor.active ? 'Attiva (simulazione)' : sensor.available ? 'Inattiva (simulazione)' : 'Non disponibile' : sensor.closed ? 'Chiuso' : 'Aperto';
    const fields = realContact ? [['Stato', status], ['Manomissione', contact.tamperState === 'detected' ? 'Rilevata' : contact.tamperState === 'normal' ? 'Assente' : 'Sconosciuta'], ['Batteria', contact.batteryLow === true ? 'Scarica' : contact.battery ?? 'Non disponibile'], ['Tensione', contact.voltage === null || contact.voltage === undefined ? 'Non disponibile' : `${contact.voltage} mV`], ['Qualità collegamento Zigbee', contact.linkQuality ?? 'Non disponibile'], ['Disponibilità', contact.available ? 'Disponibile' : contact.reason || 'Non disponibile'], ['Ultimo aggiornamento', contact.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(contact.updatedAt)) : 'Non disponibile']] : realMotion ? [['Stato', status], ['Illuminazione', source.illumination ?? 'Non disponibile'], ['Batteria', source.battery ?? 'Non disponibile'], ['Tensione', source.voltage === null || source.voltage === undefined ? 'Non disponibile' : `${source.voltage} mV`], ['Qualità collegamento Zigbee', source.linkQuality ?? 'Non disponibile'], ['Disponibilità', source.available ? 'Disponibile' : source.reason || 'Non disponibile'], ['Ultimo aggiornamento', source.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(source.updatedAt)) : 'Non disponibile']] : [['Stato', status], ['Batteria', sensor.batteryLow ? 'Scarica' : 'Non disponibile'], ['Disponibilità', sensor.available ? 'Disponibile' : 'Non disponibile'], ['Qualità collegamento Zigbee', sensor.linkQuality ?? 'Non disponibile'], ['Ultimo aggiornamento', sensor.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sensor.updatedAt)) : 'Non disponibile']];
    dialog.innerHTML = `<header><div><h2>${id} — ${names[id]}</h2><p>${realContact || realMotion ? 'DATI ZIGBEE — non collegati alla logica allarme' : 'SIMULAZIONE'}</p></div><button>×</button></header><section>${fields.map(([a,b]) => `<div><span>${a}</span><strong>${b}</strong></div>`).join('')}</section>`; dialog.querySelector('button').onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
  }
  function renderSimulation() { const host = modal.querySelector('[data-simulation]'); host.replaceChildren(); for (const id of Object.keys(names).filter(id => id !== 'PR1')) { const sensor = state.sensors[id]; const row = document.createElement('div'); const label = document.createElement('strong'); label.textContent = id; row.append(label); const fields = id === 'SR1' ? [] : [['closed', 'Chiuso']]; fields.push(['available', 'Disponibile'], ['batteryLow', 'Batteria scarica']); for (const [key, text] of fields) { const control = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.checked = sensor[key] === true; input.onchange = () => request('/api/alarm/simulation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sensors: { [id]: { [key]: input.checked } } }) }).then(next => { state = next; render(); }); control.append(input, document.createTextNode(text)); row.append(control); } host.append(row); } }
  function render() { if (!state) return; const involved = Array.from(new Set(state.intrusion?.sensorIds || (state.intrusion?.sensorId ? [state.intrusion.sensorId] : []))); const sensorList = involved.map(id => `${id} — ${state.sensors[id]?.name || names[id]}`).join('\n'); const message = state.intrusion ? state.intrusion.active ? `ALLARME ATTIVO\n\nSensori coinvolti:\n${sensorList}\n\nSirena attiva (simulazione)` : `ALLARME INTRUSIONE\n\n${involved.length > 1 ? 'Sensori coinvolti' : 'Sensore'}:\n${sensorList}\n\nSirena si attiverà tra: ${time(state.intrusion.alarmAt)}` : state.armingUntil ? `Antifurto Totale In Inserimento tra ${time(state.armingUntil)}` : state.mode === 'partial' ? 'Antifurto Parziale Inserito' : state.mode === 'complete' ? 'Antifurto Totale Inserito' : 'Antifurto Disinserito';
    modal.querySelector('[data-alarm-message]').textContent = message; modal.querySelector('[data-arming]').value = state.settings.armingMinutes; modal.querySelector('[data-delay]').value = state.settings.delayMinutes;
    for (const control of modes.children) control.classList.toggle('is-active', control.dataset.mode === state.mode || (state.armingUntil && control.dataset.mode === 'complete'));
    const problems = modal.querySelector('[data-problems]'); const invalid = state.armingError || []; problems.hidden = !invalid.length; problems.textContent = invalid.length ? `INSERIMENTO NON CONSENTITO: ${invalid.map(id => `${id} — ${names[id]} (${state.sensors[id]?.available ? 'Aperto' : 'Non disponibile'})`).join('; ')}` : '';
    card.replaceChildren(createIcon(assets, state.mode === 'none' || state.armingUntil ? config.icons.antiOff : config.icons.antiOn, '', { immediate: true }), createIcon(assets, state.mode === 'partial' ? config.icons.alarmPartial : state.mode === 'complete' || state.armingUntil ? config.icons.alarmComplete : config.icons.alarmNone, '', { immediate: true })); card.classList.toggle('is-alarm', state.intrusion?.active === true);
    for (const [id, element] of sensorMarkers) {
      const realContact = /^DW[1-8]$/.test(id); const realMotion = id === 'PR1'; const contact = doorContacts[id] || {};
      const visualState = realContact ? doorContactVisualState(contact) : realMotion ? motionSensorVisualState(motionSensor || {}) : alarmVisualState(id, state.sensors[id], state.intrusion);
      element.dataset.alarmState = visualState; element.dataset.tamperState = realContact ? contact.tamperState || 'unknown' : '';
      element.classList.toggle('is-alarm', !realContact && !realMotion && visualState === 'alarm');
      element.setAttribute('aria-label', realContact ? doorContactLabel(id, contact) : realMotion ? `${id} — ${names[id]}: ${visualState === 'active' ? 'movimento rilevato' : visualState === 'normal' ? 'nessun movimento' : 'stato sconosciuto'}` : `${id} — ${names[id]}`);
    }
    if (modal.open) renderSimulation();
  }
  const refresh = () => request('/api/alarm').then(next => { state = next; render(); }).catch(() => {}); await refresh(); const refreshTimer = setInterval(refresh, 1000);
  return { setDoorContacts(next = {}) { doorContacts = next && typeof next === 'object' ? next : {}; render(); }, setMotionSensor(next = null) { motionSensor = next && typeof next === 'object' ? next : null; render(); }, destroy() { clearInterval(refreshTimer); } };
}
