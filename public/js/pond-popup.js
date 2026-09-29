import { homeControlPath } from '../base-path.js';

const request = async (path, options = {}) => {
  const response = await fetch(homeControlPath(path), { ...options, headers: { 'Content-Type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
};

// Keep the UI conservative with the shared P105 runtime's 5-second freshness window.
const POND_RUNTIME_FRESHNESS_MS = 5_000;

export function pondRoleState(plugs, role) {
  const runtime = plugs.find(plug => plug.role === role)?.runtime;
  const state = runtime?.state;
  const readAt = Date.parse(runtime?.lastReadAt);
  const fresh = Number.isFinite(readAt) && Date.now() - readAt <= POND_RUNTIME_FRESHNESS_MS;
  const reliable = runtime?.online === true && runtime?.communicationDegraded !== true && runtime?.consecutiveFailures === 0 && fresh && (state === 'ON' || state === 'OFF');
  return { known: reliable, on: reliable && state === 'ON', state: reliable ? state : null };
}

export function createPondControls() {
  let plugs = [];
  const listeners = new Set();
  const pending = new Set();
  const notify = () => { for (const listener of listeners) listener(plugs); };
  const refresh = async () => {
    try { plugs = (await request('/api/hardware/pond-plugs')).plugs; }
    catch (error) { plugs = []; throw error; }
    finally { notify(); }
    return plugs;
  };
  return {
    snapshot: () => plugs,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    pending: role => pending.has(role),
    refresh,
    async toggle(role) {
      const current = pondRoleState(plugs, role);
      if (!current.known || pending.has(role)) return;
      pending.add(role); notify();
      try { await request(`/api/pond/${role}/power`, { method: 'PUT', body: JSON.stringify({ on: !current.on }) }); }
      catch { /* The refresh below is authoritative after a rejected command. */ }
      finally {
        pending.delete(role);
        try { await refresh(); } catch { /* A failed read is unknown, never OFF. */ }
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
  const visualAssets = { pump: 'pumpoff.svg', heater: 'heateroff.svg' };
  const roleCards = new Map();
  const createRoleCard = (role, title, onIcon, offIcon) => {
    const card = document.createElement('article');
    card.className = 'pond-card';
    const icon = document.createElement('button');
    icon.type = 'button';
    icon.className = 'pond-power-icon';
    const image = document.createElement('img');
    image.dataset.pondIcon = '';
    image.src = designAsset(visualAssets[role]);
    image.alt = '';
    icon.append(image);
    icon.onclick = () => { void controls.toggle(role); };
    const heading = document.createElement('h2'); heading.textContent = title;
    const status = document.createElement('small');
    card.append(icon, heading, status);
    roleCards.set(role, { card, icon, image, onIcon, offIcon, title, status });
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
  cards.replaceChildren(createRoleCard('pump', 'Pompa Filtro', 'pumpon.svg', 'pumpoff.svg'), createRoleCard('heater', 'Riscaldatore', 'heateron.svg', 'heateroff.svg'), thermostat);
  const render = () => {
    for (const [role, entry] of roleCards) {
      const current = pondRoleState(controls.snapshot(), role);
      if (current.known) visualAssets[role] = current.on ? entry.onIcon : entry.offIcon;
      const source = designAsset(visualAssets[role]);
      if (entry.image.getAttribute('src') !== source) entry.image.src = source;
      entry.icon.disabled = !current.known || controls.pending(role);
      entry.icon.setAttribute('aria-label', `${entry.title}: ${current.state || 'stato non disponibile'}`);
      entry.status.className = `pond-state pond-state--${current.known ? current.state.toLowerCase() : 'unknown'}`;
      entry.status.textContent = `STATO: ${current.state || '--'}`;
    }
  };
  controls.subscribe(render);
  render();
  return async () => {
    try { await controls.refresh(); } catch { /* The dialog renders unavailable controls. */ }
    if (!dialog.open) dialog.showModal();
  };
}
