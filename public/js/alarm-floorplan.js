import { homeControlPath } from '../base-path.js';
import { floorplanConfig as config } from './floorplan-config.js';
import { createAlarmAudio } from './alarm-audio.js';

const names = { DW1: 'Porta di ingresso', DW2: 'Finestra sala', DW3: 'Porta finestra sala', DW4: 'Porta finestra cucina', DW5: 'Finestra cucina', DW6: 'Porta finestra camera', DW7: 'Finestra bagno', DW8: 'Porta finestra cameretta', PR1: 'Sensore movimento interno', SR1: 'Sirena esterna' };
const time = until => { const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const request = async (path, options) => { const response = await fetch(homeControlPath(path), options); const body = await response.json(); if (!response.ok) throw Object.assign(new Error(body.error || 'Operazione non disponibile'), body, { status: response.status }); return body; };
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
  const modal = document.createElement('dialog'); modal.className = 'alarm-dialog'; modal.innerHTML = `<header><strong>ANTIFURTO</strong><button type="button" data-close aria-label="Chiudi"><img src="${homeControlPath('/design/close.svg')}" alt=""></button></header><p data-alarm-message></p><div class="alarm-modes"></div><section class="alarm-audio"><strong>Audio antifurto</strong><label class="alarm-audio-enabled"><span>Abilita audio su questo dispositivo</span><input type="checkbox" data-audio-enabled></label><div class="alarm-audio-controls"><label>Volume <input type="range" min="0" max="100" data-audio-volume></label><button type="button" data-audio-test>Prova voce</button></div><small data-audio-status></small></section><section class="alarm-keyboard" data-alarm-keyboard tabindex="-1" aria-label="Inserimento password" hidden><strong data-keyboard-title></strong><div class="alarm-keyboard-display"><output data-keyboard-value aria-label="Password nascosta"></output><button type="button" data-keyboard-reveal aria-label="Mostra temporaneamente la password">Mostra</button></div><small data-keyboard-unicode hidden></small><div data-keyboard-rows></div><div class="alarm-keyboard-actions"><button type="button" data-keyboard-cancel>ANNULLA</button><button type="button" data-keyboard-submit>INVIO</button></div></section><section class="alarm-settings" aria-labelledby="alarm-settings-title"><strong id="alarm-settings-title">Impostazioni</strong><label>Tempo di inserimento<select data-arming><option value="1">1 minuto</option><option value="2">2 minuti</option><option value="3">3 minuti</option></select></label><label>Tempo di ritardo<select data-delay><option value="1">1 minuto</option><option value="2">2 minuti</option><option value="3">3 minuti</option></select></label><label><span>Abilita Automazione CAM</span><input type="checkbox" data-camera-automation></label></section><section class="alarm-problems" data-problems hidden></section>`;
  document.body.append(modal); modal.querySelector('[data-close]').onclick = () => modal.close();
  const audioStatus = modal.querySelector('[data-audio-status]'); const alarmAudio = createAlarmAudio({ onBlocked: message => { audioStatus.textContent = message; } }); const audioSettings = alarmAudio.settings(); const audioEnabled = modal.querySelector('[data-audio-enabled]'); const audioVolume = modal.querySelector('[data-audio-volume]'); audioEnabled.checked = audioSettings.enabled; audioVolume.value = audioSettings.volume; audioEnabled.onchange = () => { alarmAudio.setEnabled(audioEnabled.checked); audioStatus.textContent = ''; }; audioVolume.oninput = () => alarmAudio.setVolume(audioVolume.value); modal.querySelector('[data-audio-test]').onclick = () => alarmAudio.test(); alarmAudio.connect(); alarmAudio.connectTemperatureVoice();
  let alarmModeBusy = false;
  const modes = modal.querySelector('.alarm-modes'); [['none', config.icons.alarmNone], ['partial', config.icons.alarmPartial], ['complete', config.icons.alarmComplete]].forEach(([mode, icon]) => { const control = button(mode, icon); control.onclick = async () => { if (alarmModeBusy) return; alarmModeBusy = true; for (const item of modes.children) item.disabled = true; try { const password = mode === 'none' ? await askPassword('Disinserisci antifurto') : undefined; if (mode === 'none' && password === null) return; try { state = await request('/api/alarm/mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, ...(mode === 'none' ? { password } : {}) }) }); render(); } catch (error) { if (error.status === 401) { audioStatus.textContent = 'Password non corretta'; return; } state = await request('/api/alarm'); state.armingError = error.blocked || []; render(); } } finally { alarmModeBusy = false; for (const item of modes.children) item.disabled = false; } }; modes.append(control); });
  const saveSettings = () => request('/api/alarm/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ armingMinutes: Number(modal.querySelector('[data-arming]').value), delayMinutes: Number(modal.querySelector('[data-delay]').value) }) }).then(next => { state = next; render(); }).catch(() => {});
  modal.querySelector('[data-arming]').onchange = saveSettings; modal.querySelector('[data-delay]').onchange = saveSettings;
  const cameraAutomation = modal.querySelector('[data-camera-automation]');
  cameraAutomation.onchange = async () => { cameraAutomation.disabled = true; try { const next = await request('/api/alarm/camera-automation', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: cameraAutomation.checked }) }); if (state) state.cameraAutomation = next; } catch { cameraAutomation.checked = state?.cameraAutomation?.enabled === true; } finally { cameraAutomation.disabled = false; } };
  let state = null; let doorContacts = {}; let motionSensor = null; let siren = null; const sensorMarkers = new Map();
  const formatTime = value => value ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : 'Non disponibile';
  let sirenPopup = null;
  const keyboard = modal.querySelector('[data-alarm-keyboard]');
  const keyboardValue = keyboard.querySelector('[data-keyboard-value]');
  const keyboardRows = keyboard.querySelector('[data-keyboard-rows]');
  const unicodeInfo = keyboard.querySelector('[data-keyboard-unicode]');
  let pendingPassword = null; let passwordValue = ''; let shifted = false; let symbols = false; let unicodeMode = false; let unicodeHex = ''; let revealed = false; let revealTimer = null;
  const refreshPassword = () => { keyboardValue.textContent = revealed ? passwordValue : '\u2022'.repeat(Array.from(passwordValue).length); keyboardValue.setAttribute('aria-label', revealed ? 'Password visibile temporaneamente' : 'Password nascosta'); unicodeInfo.hidden = !unicodeMode; unicodeInfo.textContent = unicodeMode ? `Codice Unicode U+${unicodeHex ? (revealed ? unicodeHex : '\u2022'.repeat(unicodeHex.length)) : '\u2026'} (esadecimale)` : ''; };
  const clearPassword = () => { passwordValue = ''; shifted = false; symbols = false; unicodeMode = false; unicodeHex = ''; revealed = false; if (revealTimer !== null) clearTimeout(revealTimer); revealTimer = null; refreshPassword(); keyboardRows.replaceChildren(); };
  const keyboardHome = modal.querySelector('.alarm-settings');
  const finishPassword = value => {
    if (!pendingPassword) return;
    const { resolve, host } = pendingPassword; pendingPassword = null;
    keyboard.hidden = true; clearPassword();
    if (host !== modal) modal.insertBefore(keyboard, keyboardHome);
    if (host === modal && !alarmModeBusy) for (const item of modes.children) item.disabled = false;
    resolve(value);
  };
  modal.addEventListener('close', () => { if (!modal.open && pendingPassword?.host === modal) finishPassword(null); });
  const addCharacter = value => { if (!pendingPassword) return; if (unicodeMode) { if (/^[0-9a-f]$/i.test(value) && unicodeHex.length < 6) unicodeHex += value.toUpperCase(); } else { passwordValue += value; } refreshPassword(); };
  const removeCharacter = () => { if (unicodeMode) unicodeHex = unicodeHex.slice(0, -1); else passwordValue = Array.from(passwordValue).slice(0, -1).join(''); refreshPassword(); };
  const submitPassword = () => { if (!passwordValue || !pendingPassword) return; const value = passwordValue; finishPassword(value); };
  const buildKeys = () => {
    const rows = unicodeMode ? ['1234567890', 'abcdef'] : symbols ? ['!@#$%^&*()', '-_=+[]{}|\\', ';:\'",.<>/?', '`~'] : ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
    keyboardRows.replaceChildren();
    const key = (label, action, extra = '') => {
      const element = document.createElement('button'); element.type = 'button'; element.className = `alarm-key ${extra}`; element.textContent = label;
      let pointerClick = false;
      element.addEventListener('pointerdown', () => { pointerClick = true; alarmAudio.keyboardClick(); });
      element.addEventListener('pointercancel', () => { pointerClick = false; });
      element.addEventListener('pointerleave', () => { pointerClick = false; });
      element.addEventListener('click', event => { if (event.detail === 0 && !pointerClick) alarmAudio.keyboardClick(); pointerClick = false; action(); });
      return element;
    };
    for (const keys of rows) {
      const row = document.createElement('div'); row.className = 'alarm-key-row';
      for (const char of Array.from(keys)) { const value = !symbols && !unicodeMode && shifted ? char.toUpperCase() : char; row.append(key(value, () => { addCharacter(value); if (shifted && /[a-z]/i.test(value)) { shifted = false; buildKeys(); } })); }
      keyboardRows.append(row);
    }
    const controls = document.createElement('div'); controls.className = 'alarm-key-row alarm-key-row--controls';
    controls.append(key(shifted ? 'SHIFT ON' : 'SHIFT', () => { shifted = !shifted; if (unicodeMode) unicodeMode = false; buildKeys(); }), key(symbols ? 'ABC' : '?123', () => { symbols = !symbols; unicodeMode = false; buildKeys(); }), key('U+', () => { unicodeMode = !unicodeMode; unicodeHex = ''; buildKeys(); }), key('SPAZIO', () => addCharacter(' '), 'alarm-key--space'), key('\u232b', removeCharacter));
    if (unicodeMode) controls.append(key('AGGIUNGI', () => { const code = Number.parseInt(unicodeHex, 16); if (unicodeHex && Number.isInteger(code) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) { passwordValue += String.fromCodePoint(code); unicodeHex = ''; unicodeMode = false; buildKeys(); } }, 'alarm-key--wide'));
    keyboardRows.append(controls); refreshPassword(); keyboard.focus({ preventScroll:true });
  };
  for (const [selector, action] of [['[data-keyboard-cancel]', () => finishPassword(null)], ['[data-keyboard-submit]', submitPassword]]) {
    const element = keyboard.querySelector(selector);
    let pointerClick = false;
    element.addEventListener('pointerdown', () => { pointerClick = true; alarmAudio.keyboardClick(); });
    element.addEventListener('pointercancel', () => { pointerClick = false; });
    element.addEventListener('pointerleave', () => { pointerClick = false; });
    element.addEventListener('click', event => { if (event.detail === 0 && !pointerClick) alarmAudio.keyboardClick(); pointerClick = false; action(); });
  }
  const revealButton = keyboard.querySelector('[data-keyboard-reveal]');
  const hidePassword = () => { revealed = false; refreshPassword(); };
  let revealPointer = false;
  revealButton.addEventListener('pointerdown', () => { revealPointer = true; alarmAudio.keyboardClick(); revealed = true; refreshPassword(); });
  revealButton.addEventListener('pointerup', hidePassword); revealButton.addEventListener('pointercancel', () => { revealPointer = false; hidePassword(); }); revealButton.addEventListener('pointerleave', () => { revealPointer = false; hidePassword(); });
  revealButton.addEventListener('click', event => { if (event.detail !== 0 || revealPointer) { revealPointer = false; return; } alarmAudio.keyboardClick(); revealed = true; refreshPassword(); if (revealTimer !== null) clearTimeout(revealTimer); revealTimer = setTimeout(hidePassword, 1500); });
  keyboard.addEventListener('keydown', event => {
    if (!pendingPassword || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.key === 'Tab') return;
    if (event.target.closest?.('button') && (event.key === 'Enter' || event.key === ' ')) return;
    if (event.key === 'Enter') { event.preventDefault(); alarmAudio.keyboardClick(); submitPassword(); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); alarmAudio.keyboardClick(); finishPassword(null); }
    else if (event.key === 'Backspace') { event.preventDefault(); alarmAudio.keyboardClick(); removeCharacter(); }
    else if (Array.from(event.key).length === 1) { event.preventDefault(); alarmAudio.keyboardClick(); addCharacter(event.key); }
  });
  const askPassword = (title, host = modal) => {
    if (pendingPassword || !host.open) return Promise.resolve(null);
    if (host !== modal) host.insertBefore(keyboard, host.querySelector('form'));
    clearPassword(); if (host === modal) for (const item of modes.children) item.disabled = true;
    keyboard.querySelector('[data-keyboard-title]').textContent = title;
    keyboard.hidden = false; buildKeys(); keyboard.focus({ preventScroll:true }); keyboard.scrollIntoView({ block:'start', behavior:'smooth' });
    return new Promise(resolve => { pendingPassword = { resolve, host }; });
  };
  const refreshSirenPopup = () => {
    if (!sirenPopup || sirenPopup.dirty) return;
    const source = siren || {}; const configured = state?.sirenSettings || {}; const readOnly = sirenPopup.dialog.querySelector('[data-siren-readonly]');
    readOnly.innerHTML = [['Stato', state?.sensors?.SR1?.active ? 'Attiva (logica antifurto)' : source.sirenOn === true ? 'Attiva (stato fisico)' : source.sirenOn === false ? 'Inattiva (stato fisico)' : 'Stato fisico non riportato'], ['Alimentazione', source.powerSupplyMode ?? 'Non disponibile'], ['Batteria', source.battery ?? 'Non disponibile'], ['Manomissione', source.tamperState === 'detected' ? 'Rilevata' : source.tamperState === 'normal' ? 'Assente' : 'Sconosciuta'], ['Qualità collegamento Zigbee', source.linkQuality ?? 'Non disponibile'], ['Disponibilità', source.available ? 'Disponibile' : source.reason || 'Non disponibile'], ['Ultimo aggiornamento', formatTime(source.updatedAt)]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
    const form = sirenPopup.dialog.querySelector('form'); form.elements.soundEnabled.checked = configured.soundEnabled ?? source.soundEnabled === true; form.elements.lightEnabled.checked = configured.lightEnabled ?? source.lightEnabled === true; form.elements.soundType.value = configured.soundType || source.soundType || 'siren_classic'; form.elements.volumeLevel.value = configured.volumeLevel || source.volumeLevel || 'medium'; form.elements.duration.value = configured.duration ?? source.duration ?? 30; form.elements.pauseSeconds.value = configured.pauseSeconds ?? 30; form.elements.cycleCount.value = configured.cycleCount ?? 5;
  };
  let sirenConfigBusy = false;
  const openSirenConfig = async () => {
    if (sirenConfigBusy || sirenPopup?.dialog?.open) return;
    sirenConfigBusy = true;
    try {
    let authorization = null;
    const dialog = document.createElement('dialog'); dialog.className = 'sensor-dialog siren-config-dialog'; dialog.innerHTML = '<header><div><h2>SR1 — Sirena Terrazzo</h2><p>CONFIGURAZIONE ZIGBEE</p></div><button type="button" data-close>×</button></header><section data-siren-readonly></section><form class="siren-config-form"><fieldset><legend>Configurazione</legend><label>Suono <input name="soundEnabled" type="checkbox"></label><label>Luce <input name="lightEnabled" type="checkbox"></label><label>Tipo suono <select name="soundType"><option value="siren_classic">Sirena classica</option><option value="siren_steady">Sirena continua</option><option value="siren_rising">Sirena crescente</option><option value="siren_warning">Avviso</option><option value="siren_rapid">Sirena rapida</option><option value="siren_emergency">Emergenza</option><option value="tone_chirp">Tono chirp</option><option value="tone_hi_lo">Tono alto/basso</option><option value="tone_intermittent">Tono intermittente</option><option value="tone_pulse">Tono impulso</option><option value="chime_doorbell">Campanello</option><option value="chime_classic_clock">Orologio classico</option><option value="chime_electronic_clock">Orologio elettronico</option><option value="chime_bright">Chime brillante</option><option value="chime_soft">Chime delicato</option></select></label><label>Volume <select name="volumeLevel"><option value="low">Basso</option><option value="medium">Medio</option><option value="high">Alto</option><option value="max">Massimo</option></select></label><label>Durata <span><input name="duration" type="number" min="1" max="900" required><em>secondi</em></span></label><label>Pausa <span><input name="pauseSeconds" type="number" min="0" max="900" required><em>secondi</em></span></label><label>Numero cicli <input name="cycleCount" type="number" min="1" max="20" step="1" required></label></fieldset><small data-save-status></small><footer><button type="submit">SALVA</button><button type="button" data-cancel>ANNULLA</button></footer></form><section class="siren-test-controls"><small data-test-status></small><footer><button type="button" data-siren-test>TEST SIRENA</button><button type="button" data-siren-stop disabled>STOP</button></footer></section>';
    const revoke = () => { if (!authorization?.token) return; const token = authorization.token; authorization.token = ''; fetch(homeControlPath('/api/alarm/siren/session'), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {}); };
    sirenPopup = { dialog, dirty: false }; const form = dialog.querySelector('form'); const testControls = dialog.querySelector('.siren-test-controls');
    form.hidden = true; testControls.hidden = true;
    const authSection = document.createElement('section'); authSection.className = 'siren-auth'; authSection.innerHTML = '<button type="button" data-siren-authorize>AUTORIZZA CONFIGURAZIONE</button><small data-siren-auth-status></small>'; dialog.insertBefore(authSection, form);
    const authButton = authSection.querySelector('[data-siren-authorize]'); const authStatus = authSection.querySelector('[data-siren-auth-status]');
    let authBusy = false;
    const authorizeSiren = async () => {
      if (authBusy || !dialog.open) return;
      authBusy = true; authButton.disabled = true; authStatus.textContent = '';
      try {
        const password = await askPassword('Configura SR1', dialog); if (password === null || !dialog.open) return;
        try {
          authorization = await request('/api/alarm/siren/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
          if (!dialog.open) { revoke(); return; }
          form.hidden = false; testControls.hidden = false; authSection.hidden = true;
        } catch { if (dialog.open) authStatus.textContent = 'Password non corretta'; }
      } finally { authBusy = false; authButton.disabled = false; }
    };
    authButton.onclick = authorizeSiren; refreshSirenPopup();
    form.oninput = () => { if (sirenPopup) sirenPopup.dirty = true; }; form.onsubmit = async event => { event.preventDefault(); const data = new FormData(form); const payload = { soundEnabled: data.get('soundEnabled') === 'on', lightEnabled: data.get('lightEnabled') === 'on', soundType: data.get('soundType'), volumeLevel: data.get('volumeLevel'), duration: Number(data.get('duration')), pauseSeconds: Number(data.get('pauseSeconds')), cycleCount: Number(data.get('cycleCount')) }; const status = dialog.querySelector('[data-save-status]'); try { const result = await request('/api/alarm/siren/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authorization.token}` }, body: JSON.stringify(payload) }); authorization.token = ''; if (state && result.settings) state.sirenSettings = result.settings; sirenPopup.dirty = false; status.textContent = result.deferred ? 'Configurazione salvata per il prossimo allarme.' : 'Configurazione salvata; attendo conferma MQTT.'; } catch { status.textContent = 'Salvataggio non disponibile.'; } };
    const testButton = dialog.querySelector('[data-siren-test]'); const stopButton = dialog.querySelector('[data-siren-stop]'); const testStatus = dialog.querySelector('[data-test-status]'); let testStatusTimer = null;
    let sirenAuthorizationPending = false;
    const ensureTestAuthorization = async () => { if (authorization.token) return true; if (sirenAuthorizationPending) return false; sirenAuthorizationPending = true; try { const testPassword = await askPassword('Test sirena', dialog); if (testPassword === null || !dialog.open) return false; try { authorization = await request('/api/alarm/siren/authorize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: testPassword }) }); if (!dialog.open) { revoke(); return false; } return true; } catch { testStatus.textContent = 'Password non corretta'; return false; } } finally { sirenAuthorizationPending = false; } };
    const showStopped = () => { testStatusTimer = null; testStatus.textContent = 'Comando STOP inviato'; testButton.disabled = false; stopButton.disabled = true; };
    testButton.onclick = async () => { if (testButton.disabled) return; testButton.disabled = true; if (!(await ensureTestAuthorization())) { testButton.disabled = false; return; } try { const result = await request('/api/alarm/siren/test', { method: 'POST', headers: { Authorization: `Bearer ${authorization.token}` } }); testStatus.textContent = 'Test sirena in corso'; stopButton.disabled = false; testStatusTimer = setTimeout(showStopped, result.durationSeconds * 1000 + 100); } catch (error) { testStatus.textContent = error.status === 409 ? error.message : 'Test sirena non disponibile.'; testButton.disabled = false; } };
    stopButton.onclick = async () => { if (!(await ensureTestAuthorization())) return; stopButton.disabled = true; if (testStatusTimer) clearTimeout(testStatusTimer); try { await request('/api/alarm/siren/test', { method: 'DELETE', headers: { Authorization: `Bearer ${authorization.token}` } }); showStopped(); } catch { testStatus.textContent = 'STOP non disponibile.'; testButton.disabled = false; } };
    const close = () => dialog.close(); dialog.querySelector('[data-close]').onclick = close; dialog.querySelector('[data-cancel]').onclick = close; dialog.addEventListener('close', () => { if (pendingPassword?.host === dialog) finishPassword(null); if (testStatusTimer) clearTimeout(testStatusTimer); revoke(); if (sirenPopup?.dialog === dialog) sirenPopup = null; dialog.remove(); }, { once: true }); document.body.append(dialog); dialog.showModal(); void authorizeSiren();
    } finally { sirenConfigBusy = false; }
  };
  const open = () => { render(); if (!modal.open) modal.showModal(); };
  const main = marker('Apri antifurto'); main.append(createIcon(assets, config.icons.alarm, '', { immediate: true })); main.onclick = open; placeHtml(mapping, config.alarm.marker, main, true);
  const card = marker('Apri antifurto'); card.classList.add('floorplan-marker-alarm-card'); card.onclick = open; placeHtml(mapping, config.alarm.card, card, true);
  for (const item of config.alarm.sensors) {
    const element = marker(`${item.id} — ${names[item.id]}`); element.classList.add('floorplan-marker-alarm-sensor'); element.dataset.alarmSensorId = item.id; element.append(createIcon(assets, item.id === 'SR1' ? config.icons.alarmOn : item.id === 'PR1' ? config.icons.alarmMotion : config.icons.alarmDoor, '', { immediate: true })); element.onclick = () => showSensor(item.id); placeHtml(mapping, item.marker, element, true); sensorMarkers.set(item.id, element);
  }
  function showSensor(id) {
    if (id === 'SR1') return openSirenConfig();
    const contact = doorContacts[id] || {}; const sensor = state?.sensors?.[id] || {}; const realContact = /^DW[1-8]$/.test(id); const realMotion = id === 'PR1'; const realSiren = id === 'SR1'; const source = realMotion ? motionSensor || {} : realSiren ? siren || {} : sensor; const dialog = document.createElement('dialog'); dialog.className = 'sensor-dialog';
    const status = realContact ? contact.available !== true ? 'Non disponibile / dato storico' : contact.contact === true ? 'Chiuso' : contact.contact === false ? 'Aperto' : 'Sconosciuto' : realMotion ? source.available !== true || typeof source.occupancy !== 'boolean' ? 'Sconosciuto / non disponibile' : source.occupancy ? 'Movimento rilevato' : 'Nessun movimento' : realSiren ? sensor.active ? 'Attiva (logica antifurto)' : source.available !== true ? 'Non disponibile / dato storico' : source.sirenOn === true ? 'Attiva (stato fisico)' : source.sirenOn === false ? 'Inattiva (stato fisico)' : 'Stato fisico non riportato' : sensor.closed ? 'Chiuso' : 'Aperto';
    const fields = realContact ? [['Stato', status], ['Manomissione', contact.tamperState === 'detected' ? 'Rilevata' : contact.tamperState === 'normal' ? 'Assente' : 'Sconosciuta'], ['Batteria', contact.batteryLow === true ? 'Scarica' : contact.battery ?? 'Non disponibile'], ['Tensione', contact.voltage === null || contact.voltage === undefined ? 'Non disponibile' : `${contact.voltage} mV`], ['Qualità collegamento Zigbee', contact.linkQuality ?? 'Non disponibile'], ['Disponibilità', contact.available ? 'Disponibile' : contact.reason || 'Non disponibile'], ['Ultimo aggiornamento', contact.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(contact.updatedAt)) : 'Non disponibile']] : realMotion ? [['Stato', status], ['Illuminazione', source.illumination ?? 'Non disponibile'], ['Batteria', source.battery ?? 'Non disponibile'], ['Tensione', source.voltage === null || source.voltage === undefined ? 'Non disponibile' : `${source.voltage} mV`], ['Qualità collegamento Zigbee', source.linkQuality ?? 'Non disponibile'], ['Disponibilità', source.available ? 'Disponibile' : source.reason || 'Non disponibile'], ['Ultimo aggiornamento', source.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(source.updatedAt)) : 'Non disponibile']] : realSiren ? [['Stato', status], ['Alimentazione', source.powerSupplyMode ?? 'Non disponibile'], ['Batteria', source.battery ?? 'Non disponibile'], ['Manomissione', source.tamperState === 'detected' ? 'Rilevata' : source.tamperState === 'normal' ? 'Assente' : 'Sconosciuta'], ['Suono', source.soundEnabled === null || source.soundEnabled === undefined ? 'Non disponibile' : source.soundEnabled ? 'Abilitato' : 'Disabilitato'], ['Luce', source.lightEnabled === null || source.lightEnabled === undefined ? 'Non disponibile' : source.lightEnabled ? 'Abilitata' : 'Disabilitata'], ['Tipo suono', source.soundType ?? 'Non disponibile'], ['Volume', source.volumeLevel ?? 'Non disponibile'], ['Durata', source.duration === null || source.duration === undefined ? 'Non disponibile' : `${source.duration} s`], ['Qualità collegamento Zigbee', source.linkQuality ?? 'Non disponibile'], ['Disponibilità', source.available ? 'Disponibile' : source.reason || 'Non disponibile'], ['Ultimo aggiornamento', source.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(source.updatedAt)) : 'Non disponibile']] : [['Stato', status], ['Batteria', sensor.batteryLow ? 'Scarica' : 'Non disponibile'], ['Disponibilità', sensor.available ? 'Disponibile' : 'Non disponibile'], ['Qualità collegamento Zigbee', sensor.linkQuality ?? 'Non disponibile'], ['Ultimo aggiornamento', sensor.updatedAt ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sensor.updatedAt)) : 'Non disponibile']];
    dialog.innerHTML = `<header><div><h2>${id} — ${names[id]}</h2><p>${realContact || realMotion || realSiren ? 'DATI ZIGBEE — non collegati alla logica allarme' : 'STATO LOGICO ANTIFURTO'}</p></div><button>×</button></header><section>${fields.map(([a,b]) => `<div><span>${a}</span><strong>${b}</strong></div>`).join('')}</section>`; dialog.querySelector('button').onclick = () => dialog.close(); dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
    if (id === 'DW1') {
      const section = document.createElement('form'); section.className = 'sensor-voice door-voice';
      section.innerHTML = '<fieldset><legend>AVVISO PORTA APERTA</legend><label>Abilita avviso vocale <input name="enabled" type="checkbox"></label><label>Volume voce <input name="volume" type="range" min="0" max="100"></label><label>Ritardo avviso <select name="delay">' + [15,30,45,60,90,120,180,300].map(value => `<option value="${value}">${value} secondi</option>`).join('') + '</select></label><label>Ripeti avviso <select name="repeat"><option value="0">OFF</option>' + [30,60,120,300].map(value => `<option value="${value}">${value} secondi</option>`).join('') + '</select></label><button type="button" data-door-test>Prova voce</button><small data-door-status></small></fieldset>';
      dialog.append(section); const status = section.querySelector('[data-door-status]');
      const controls = section.elements; let ready = false; let saving = Promise.resolve();
      const current = () => ({ enabled: controls.enabled.checked, volume: Number(controls.volume.value), delay: Number(controls.delay.value), repeat: Number(controls.repeat.value) });
      section.onchange = () => { if (!ready) return; const settings = current(); saving = saving.catch(() => {}).then(() => request('/api/door-contacts/DW1/voice', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(settings) })).then(() => { status.textContent = ''; }).catch(() => { status.textContent = 'Impostazioni non salvate.'; }); };
      section.onsubmit = event => event.preventDefault();
      section.querySelector('[data-door-test]').onclick = () => { if (!alarmAudio.settings().enabled) { status.textContent = 'Abilita audio su questo dispositivo.'; return; } alarmAudio.testDoorVoice({ volume:Number(controls.volume.value) }); };
      for (const control of controls) control.disabled = true;
      request('/api/door-contacts/DW1/voice').then(settings => { if (!dialog.open) return; controls.enabled.checked = settings.enabled; controls.volume.value = settings.volume; controls.delay.value = settings.delay; controls.repeat.value = settings.repeat; ready = true; for (const control of controls) control.disabled = false; }).catch(() => { status.textContent = 'Impostazioni non disponibili.'; });
    }
  }
  function render() { if (!state) return; const involved = Array.from(new Set(state.intrusion?.sensorIds || (state.intrusion?.sensorId ? [state.intrusion.sensorId] : []))); const sensorList = involved.map(id => `${id} — ${state.sensors[id]?.name || names[id]}`).join('\n'); const message = state.intrusion ? state.intrusion.active ? `ALLARME ATTIVO\n\nSensori coinvolti:\n${sensorList}\n\nSirena attiva (simulazione)` : `ALLARME INTRUSIONE\n\n${involved.length > 1 ? 'Sensori coinvolti' : 'Sensore'}:\n${sensorList}\n\nSirena si attiverà tra: ${time(state.intrusion.alarmAt)}` : state.armingUntil ? `Antifurto Totale In Inserimento tra ${time(state.armingUntil)}` : state.mode === 'partial' ? 'Antifurto Parziale Inserito' : state.mode === 'complete' ? 'Antifurto Totale Inserito' : 'Antifurto Disinserito';
    modal.querySelector('[data-alarm-message]').textContent = message; modal.querySelector('[data-arming]').value = state.settings.armingMinutes; modal.querySelector('[data-delay]').value = state.settings.delayMinutes; if (!cameraAutomation.disabled) cameraAutomation.checked = state.cameraAutomation?.enabled === true;
    for (const control of modes.children) control.classList.toggle('is-active', control.dataset.mode === state.mode || (state.armingUntil && control.dataset.mode === 'complete'));
    const problems = modal.querySelector('[data-problems]'); const invalid = state.armingError || []; problems.hidden = !invalid.length; problems.textContent = invalid.length ? `INSERIMENTO NON CONSENTITO: ${invalid.map(id => `${id} — ${names[id]} (${state.sensors[id]?.available ? 'Aperto' : 'Non disponibile'})`).join('; ')}` : '';
    card.replaceChildren(createIcon(assets, state.mode === 'none' || state.armingUntil ? config.icons.antiOff : config.icons.antiOn, '', { immediate: true }), createIcon(assets, state.mode === 'partial' ? config.icons.alarmPartial : state.mode === 'complete' || state.armingUntil ? config.icons.alarmComplete : config.icons.alarmNone, '', { immediate: true })); card.classList.toggle('is-alarm', state.intrusion?.active === true);
    for (const [id, element] of sensorMarkers) {
      const realContact = /^DW[1-8]$/.test(id); const realMotion = id === 'PR1'; const realSiren = id === 'SR1'; const contact = doorContacts[id] || {};
      const visualState = realContact ? doorContactVisualState(contact) : realMotion ? motionSensorVisualState(motionSensor || {}) : realSiren ? alarmVisualState(id, { ...state.sensors[id], available: siren?.available === true, batteryLow: Number.isFinite(siren?.battery) ? siren.battery <= 20 : null }, state.intrusion) : alarmVisualState(id, state.sensors[id], state.intrusion);
      element.dataset.alarmState = visualState; element.dataset.tamperState = realContact ? contact.tamperState || 'unknown' : '';
      element.classList.toggle('is-alarm', !realContact && !realMotion && visualState === 'alarm');
      element.setAttribute('aria-label', realContact ? doorContactLabel(id, contact) : realMotion ? `${id} — ${names[id]}: ${visualState === 'active' ? 'movimento rilevato' : visualState === 'normal' ? 'nessun movimento' : 'stato sconosciuto'}` : realSiren ? `${id} — ${names[id]}: ${visualState === 'alarm' ? 'allarme attivo' : visualState === 'unknown' ? 'non disponibile' : 'disponibile'}` : `${id} — ${names[id]}`);
    }
  }
  const refresh = () => request('/api/alarm').then(next => { state = next; render(); }).catch(() => {}); await refresh(); const refreshTimer = setInterval(refresh, 1000);
  const alarmEvents = typeof EventSource === 'function' ? new EventSource(homeControlPath('/api/alarm/events')) : null;
  if (alarmEvents) { alarmEvents.addEventListener('state', event => { try { siren = JSON.parse(event.data).siren || null; refreshSirenPopup(); render(); } catch { /* Telemetry must not interrupt alarm events. */ } }); alarmEvents.addEventListener('camera-automation', event => { try { if (state) state.cameraAutomation = JSON.parse(event.data); render(); } catch { /* A later refresh restores the authoritative state. */ } }); }
  return { playTemperatureVoice: event => alarmAudio.testTemperatureVoice(event), setDoorContacts(next = {}) { doorContacts = next && typeof next === 'object' ? next : {}; render(); }, setMotionSensor(next = null) { motionSensor = next && typeof next === 'object' ? next : null; render(); }, setSiren(next = null) { siren = next && typeof next === 'object' ? next : null; refreshSirenPopup(); render(); }, destroy() { finishPassword(null); alarmAudio.closeKeyboardAudio(); clearInterval(refreshTimer); alarmEvents?.close(); } };
}
