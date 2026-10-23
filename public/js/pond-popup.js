import { homeControlPath } from '../base-path.js';

const request = async (path, options = {}) => {
  const response = await fetch(homeControlPath(path), { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'Operazione Pond non riuscita');
    error.status = response.status;
    throw error;
  }
  return body;
};

// Keep the UI conservative with the shared P105 runtime's 5-second freshness window.
const POND_RUNTIME_FRESHNESS_MS = 5_000;
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();

export function pondRoleState(plugs, role) {
  const runtime = plugs.find(plug => plug.role === role)?.runtime;
  const state = runtime?.state;
  const readAt = Date.parse(runtime?.lastReadAt);
  const receivedAt = Number(runtime?.frontendReceivedAt);
  const receivedAge = monotonicNow() - receivedAt;
  const receivedFresh = runtime?.freshWhenReceived === true && Number.isFinite(receivedAt) && receivedAge >= 0 && receivedAge <= POND_RUNTIME_FRESHNESS_MS;
  const legacyFresh = runtime?.freshWhenReceived === undefined && Number.isFinite(readAt) && Date.now() - readAt <= POND_RUNTIME_FRESHNESS_MS;
  const fresh = receivedFresh || legacyFresh;
  const reliable = runtime?.online === true && runtime?.communicationDegraded !== true && runtime?.consecutiveFailures === 0 && fresh && (state === 'ON' || state === 'OFF');
  return { known: reliable, on: reliable && state === 'ON', state: reliable ? state : null };
}

export function createPondControls() {
  let plugs = [];
  let heating = null;
  let revision = -1;
  const listeners = new Set();
  const pending = new Set();
  const errors = new Map();
  const notify = () => { for (const listener of listeners) listener(plugs); };
  const applySnapshot = snapshot => {
    if (!snapshot || !Array.isArray(snapshot.plugs)) return false;
    const nextRevision = Number(snapshot.revision);
    if (Number.isFinite(nextRevision) && nextRevision <= revision) return false;
    if (Number.isFinite(nextRevision)) revision = nextRevision;
    const receivedAt = monotonicNow();
    const observedAt = Date.parse(snapshot.observedAt);
    plugs = snapshot.plugs.map(plug => {
      if (!plug?.runtime) return plug;
      const readAt = Date.parse(plug.runtime.lastReadAt);
      const ageAtSnapshot = observedAt - readAt;
      const freshWhenReceived = Number.isFinite(ageAtSnapshot)
        ? ageAtSnapshot >= 0 && ageAtSnapshot <= POND_RUNTIME_FRESHNESS_MS
        : Number.isFinite(readAt)
          ? Date.now() - readAt >= 0 && Date.now() - readAt <= POND_RUNTIME_FRESHNESS_MS
        : plug.runtime.online === true && plug.runtime.communicationDegraded !== true && plug.runtime.consecutiveFailures === 0;
      return { ...plug, runtime: { ...plug.runtime, frontendReceivedAt: receivedAt, freshWhenReceived } };
    });
    heating = snapshot.heating || null;
    notify();
    return true;
  };
  const refresh = async () => {
    const snapshot = await request('/api/hardware/pond-plugs', { cache: 'no-store' });
    applySnapshot(snapshot);
    return plugs;
  };
  return {
    snapshot: () => plugs,
    heating: () => heating,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pending: role => pending.has(role),
    error: role => errors.get(role) || null,
    revision: () => revision,
    applySnapshot,
    refresh,
    async saveHeatingConfig(config) {
      const result = await request('/api/pond/heating/config', { method: 'PUT', body: JSON.stringify(config) });
      if (result.pond) applySnapshot(result.pond);
      else await refresh();
      return heating;
    },
    async toggle(role) {
      if (pending.has(role)) return { ok: false, reason: 'pending' };
      if (heating?.config?.mode === 'thermostat') {
        const message = 'Passa alla modalità Manuale per comandare la presa.';
        errors.set(role, message); notify();
        return { ok: false, error: message };
      }
      pending.add(role); notify();
      errors.delete(role);
      try {
        let current = pondRoleState(plugs, role);
        if (!current.known) {
          try { await refresh(); }
          catch { throw new Error('Impossibile recuperare lo stato della presa'); }
          current = pondRoleState(plugs, role);
        }
        if (!current.known) throw new Error('Presa non raggiungibile o stato non disponibile');
        const result = await request(`/api/pond/${role}/power`, { method: 'PUT', body: JSON.stringify({ on: !current.on }) });
        if (result.pond) applySnapshot(result.pond);
        else await refresh();
        return { ok: true, state: pondRoleState(plugs, role) };
      }
      catch (error) {
        errors.set(role, error.message || 'Comando Pond non riuscito');
        return { ok: false, error: errors.get(role) };
      }
      finally {
        pending.delete(role);
        notify();
      }
    },
  };
}

const designAsset = name => homeControlPath('/design/' + name);
const heatingConfigFields = ['threshold', 'repetitions', 'onMinutes', 'offMinutes'];

export function createPondHeatingDraft() {
  const values = new Map();
  const dirty = new Set();
  const sync = config => {
    for (const name of heatingConfigFields) {
      if (!dirty.has(name)) values.set(name, config?.[name] ?? '');
    }
  };
  return {
    sync,
    update(name, value) { values.set(name, value); dirty.add(name); },
    value: name => values.get(name) ?? '',
    values: config => {
      sync(config);
      return Object.fromEntries(heatingConfigFields.map(name => [name, values.get(name)]));
    },
    clear() { values.clear(); dirty.clear(); },
  };
}

export function initPondPopup(controls) {
  const dialog = document.createElement('dialog');
  dialog.className = 'boiler-modal pond-modal';
  dialog.innerHTML = '<header class="boiler-modal-toolbar"><strong>POND</strong><button type="button" aria-label="Chiudi">X</button></header><div class="pond-cards"></div><section class="pond-heating-settings"><h2>Controllo termostatico</h2><p class="pond-s5-reading"></p><div class="pond-heating-fields"><label>Soglia °C<input name="threshold" type="number" step="0.1" inputmode="decimal"></label><label>Ripetizioni<input name="repetitions" type="number" min="1" step="1" inputmode="numeric"></label><label>Riscaldatore ON (min)<input name="onMinutes" type="number" min="0.1" step="0.1" inputmode="decimal"></label><label>Pausa OFF (min)<input name="offMinutes" type="number" min="0" step="0.1" inputmode="decimal"></label></div><button class="pond-heating-save" type="button">SALVA CONFIGURAZIONE</button><p class="pond-heating-status" aria-live="polite"></p></section><section class="pond-heating-history"><h2>Storico ultime 24 ore</h2><div class="pond-history-scroll"><table><thead><tr><th>Ciclo</th><th>Inizio</th><th>Fine</th><th>Soglia</th><th>Rep.</th><th>ON/OFF</th><th>T iniziale</th><th>T finale</th><th>ΔT</th><th>Esito</th></tr></thead><tbody></tbody></table></div><p class="pond-history-summary"></p></section>';
  document.body.append(dialog);
  dialog.querySelector('button').onclick = () => dialog.close();
  const cards = dialog.querySelector('.pond-cards');
  const settings = dialog.querySelector('.pond-heating-settings');
  const statusLine = dialog.querySelector('.pond-heating-status');
  const s5Reading = dialog.querySelector('.pond-s5-reading');
  const historyBody = dialog.querySelector('.pond-heating-history tbody');
  const historySummary = dialog.querySelector('.pond-history-summary');
  const input = name => settings.querySelector(`[name="${name}"]`);
  const draft = createPondHeatingDraft();
  const formatTemperature = value => Number.isFinite(value) ? `${value.toLocaleString('it-IT', { maximumFractionDigits: 1 })} °C` : '—';
  const formatDate = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
  const history24h = history => history.filter(record => Date.now() - Date.parse(record.completedAt) <= 24 * 60 * 60 * 1000);
  const roleCards = new Map();
  const createRoleCard = (role, title, onIcon, offIcon, unknownIcon) => {
    const card = document.createElement('article');
    card.className = 'pond-card';
    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'pond-power-icon';
    const image = document.createElement('img');
    image.dataset.pondIcon = '';
    image.src = designAsset(unknownIcon);
    image.alt = '';
    icon.append(image);
    icon.onclick = () => { void controls.toggle(role); };
    const heading = document.createElement('h2'); heading.textContent = title;
    const status = document.createElement('small');
    card.append(icon, heading, status);
    roleCards.set(role, { card, icon, image, onIcon, offIcon, unknownIcon, title, status });
    return card;
  };
  const thermostat = document.createElement('article');
  thermostat.className = 'pond-card';
  const modeImage = document.createElement('img');
  modeImage.className = 'pond-mode-icon'; modeImage.src = designAsset('manual.svg'); modeImage.alt = '';
  thermostat.append(modeImage, Object.assign(document.createElement('h2'), { textContent: 'Termostato' }));
  const manual = document.createElement('label'); manual.className = 'pond-mode'; manual.append(Object.assign(document.createElement('input'), { type: 'radio', name: 'pond-mode', checked: true }), document.createTextNode(' Manuale'));
  const automatic = document.createElement('label'); automatic.className = 'pond-mode'; automatic.append(Object.assign(document.createElement('input'), { type: 'radio', name: 'pond-mode' }), document.createTextNode(' Termostato'));
  thermostat.append(manual, automatic);
  cards.replaceChildren(createRoleCard('pump', 'Pompa Filtro', 'pumpon.svg', 'pumpoff.svg', 'pump.svg'), createRoleCard('heater', 'Riscaldatore', 'heateron.svg', 'heateroff.svg', 'heater.svg'), thermostat);
  const save = async ({ mode = null } = {}) => {
    const current = controls.heating()?.config || {};
    statusLine.textContent = 'Salvataggio in corso…';
    try {
      await controls.saveHeatingConfig({
        ...current,
        mode: mode || (automatic.querySelector('input').checked ? 'thermostat' : 'manual'),
        ...draft.values(current),
      });
      draft.clear();
      render();
      statusLine.textContent = 'Configurazione salvata.';
    } catch (error) { statusLine.textContent = error.message || 'Configurazione non salvata.'; }
  };
  manual.querySelector('input').addEventListener('change', () => { if (manual.querySelector('input').checked) void save({ mode: 'manual' }); });
  automatic.querySelector('input').addEventListener('change', () => { if (automatic.querySelector('input').checked) void save({ mode: 'thermostat' }); });
  settings.querySelector('.pond-heating-save').addEventListener('click', () => { void save(); });
  for (const name of heatingConfigFields) input(name).addEventListener('input', event => { draft.update(name, event.target.value); });
  const render = () => {
    const heating = controls.heating();
    const config = heating?.config;
    const automaticMode = config?.mode === 'thermostat';
    manual.querySelector('input').checked = !automaticMode;
    automatic.querySelector('input').checked = automaticMode;
    draft.sync(config);
    for (const name of heatingConfigFields) {
      const field = input(name);
      if (config && document.activeElement !== field) field.value = draft.value(name);
    }
    const s5 = heating?.latestMeasurement || heating?.activeCycle?.lastMeasurement || null;
    s5Reading.textContent = s5 ? `S5: ${formatTemperature(s5.value)} · ${formatDate(s5.updatedAt)}` : 'S5: in attesa di una misura live valida.';
    const phase = heating?.activeCycle ? `Ciclo ${heating.activeCycle.id}: ${heating.status === 'cycle-running' ? `ON ${heating.activeCycle.repetition}/${heating.activeCycle.config.repetitions}` : 'pausa tra ripetizioni'}` : heating?.deviceVerified ? 'In attesa di una nuova misura S5.' : 'In attesa della verifica dello stato fisico delle prese.';
    if (!statusLine.textContent || statusLine.textContent === 'Configurazione salvata.') statusLine.textContent = phase;
    for (const [role, entry] of roleCards) {
      const current = pondRoleState(controls.snapshot(), role);
      const pending = controls.pending(role);
      const error = controls.error(role);
      const source = designAsset(current.known ? current.on ? entry.onIcon : entry.offIcon : entry.unknownIcon);
      if (entry.image.getAttribute('src') !== source) entry.image.src = source;
      entry.icon.disabled = pending || automaticMode;
      entry.icon.dataset.pending = String(pending);
      entry.icon.dataset.error = String(Boolean(error));
      entry.icon.setAttribute('aria-label', `${entry.title}: ${pending ? 'comando in corso' : error || current.state || 'stato non disponibile'}`);
      entry.status.className = `pond-state pond-state--${current.known ? current.state.toLowerCase() : 'unknown'}`;
      entry.status.textContent = pending ? 'COMANDO IN CORSO' : error ? `ERRORE: ${error}` : `STATO: ${current.state || 'SCONOSCIUTO'}`;
    }
    const history = history24h(heating?.history || []);
    historyBody.replaceChildren(...history.slice().reverse().map(record => {
      const row = document.createElement('tr');
      const cells = [record.id, formatDate(record.startedAt), formatDate(record.completedAt), `${record.config?.threshold ?? '—'} °C`, record.config?.repetitions ?? '—', `${record.config?.onMinutes ?? '—'}/${record.config?.offMinutes ?? '—'} min`, formatTemperature(record.initialMeasurement?.value), formatTemperature(record.finalMeasurement?.value), Number.isFinite(record.deltaTemperature) ? `${record.deltaTemperature >= 0 ? '+' : ''}${record.deltaTemperature.toLocaleString('it-IT', { maximumFractionDigits: 1 })} °C` : '—', record.result || '—'];
      for (const value of cells) { const cell = document.createElement('td'); cell.textContent = String(value); row.append(cell); }
      return row;
    }));
    const completed = history.filter(record => record.result === 'COMPLETATO');
    const totalOn = history.reduce((total, record) => total + (record.config?.onMinutes || 0) * (record.config?.repetitions || 0), 0);
    const deltas = completed.map(record => record.deltaTemperature).filter(Number.isFinite);
    historySummary.textContent = `${completed.length} completati · ${history.length - completed.length} interrotti · ON totale ${totalOn.toLocaleString('it-IT')} min${deltas.length ? ` · ΔT medio ${(deltas.reduce((total, value) => total + value, 0) / deltas.length).toLocaleString('it-IT', { maximumFractionDigits: 1 })} °C` : ''}`;
  };
  controls.subscribe(render);
  render();
  dialog.addEventListener('close', () => { draft.clear(); });
  return async () => {
    try { await controls.refresh(); } catch { /* The dialog renders unavailable controls. */ }
    render();
    if (!dialog.open) dialog.showModal();
  };
}
