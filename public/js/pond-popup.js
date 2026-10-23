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
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pending: role => pending.has(role),
    error: role => errors.get(role) || null,
    revision: () => revision,
    applySnapshot,
    refresh,
    async toggle(role) {
      if (pending.has(role)) return { ok: false, reason: 'pending' };
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

export function initPondPopup(controls) {
  const dialog = document.createElement('dialog');
  dialog.className = 'boiler-modal pond-modal';
  dialog.innerHTML = '<header class="boiler-modal-toolbar"><strong>POND</strong><button type="button">X</button></header><div class="pond-cards"></div>';
  document.body.append(dialog);
  dialog.querySelector('button').onclick = () => dialog.close();
  const cards = dialog.querySelector('.pond-cards');
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
  const automatic = document.createElement('label'); automatic.className = 'pond-mode'; automatic.append(Object.assign(document.createElement('input'), { type: 'radio', name: 'pond-mode', disabled: true }), document.createTextNode(' Termostato'));
  thermostat.append(manual, automatic);
  cards.replaceChildren(createRoleCard('pump', 'Pompa Filtro', 'pumpon.svg', 'pumpoff.svg', 'pump.svg'), createRoleCard('heater', 'Riscaldatore', 'heateron.svg', 'heateroff.svg', 'heater.svg'), thermostat);
  const render = () => {
    for (const [role, entry] of roleCards) {
      const current = pondRoleState(controls.snapshot(), role);
      const pending = controls.pending(role);
      const error = controls.error(role);
      const source = designAsset(current.known ? current.on ? entry.onIcon : entry.offIcon : entry.unknownIcon);
      if (entry.image.getAttribute('src') !== source) entry.image.src = source;
      entry.icon.disabled = pending;
      entry.icon.dataset.pending = String(pending);
      entry.icon.dataset.error = String(Boolean(error));
      entry.icon.setAttribute('aria-label', `${entry.title}: ${pending ? 'comando in corso' : error || current.state || 'stato non disponibile'}`);
      entry.status.className = `pond-state pond-state--${current.known ? current.state.toLowerCase() : 'unknown'}`;
      entry.status.textContent = pending ? 'COMANDO IN CORSO' : error ? `ERRORE: ${error}` : `STATO: ${current.state || 'SCONOSCIUTO'}`;
    }
  };
  controls.subscribe(render);
  render();
  return async () => {
    try { await controls.refresh(); } catch { /* The dialog renders unavailable controls. */ }
    if (!dialog.open) dialog.showModal();
  };
}
