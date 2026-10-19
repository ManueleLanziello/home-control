import { homeControlPath } from './base-path.js';

async function request(path, options = {}) {
  const response = await fetch(homeControlPath(path), {
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function button(label, action, id) {
  const item = document.createElement('button');
  item.type = 'button';
  item.textContent = label;
  item.dataset.action = action;
  item.dataset.id = id;
  return item;
}

export function initSettings(root = document) {
  const content = root.matches?.('[data-settings-content]') ? root : root.querySelector?.('[data-settings-content]');
  if (!content || content.dataset.settingsInitialized === 'true') return;
  content.dataset.settingsInitialized = 'true';

  const statusElement = content.querySelector('#settings-status');
  const cameraForm = content.querySelector('#camera-form');
  const cameraList = content.querySelector('#camera-devices');
  const cameraCancel = content.querySelector('#camera-cancel');
  const plugForm = content.querySelector('#pond-plug-form');
  const plugList = content.querySelector('#pond-plug-devices');
  const plugCancel = content.querySelector('#pond-plug-cancel');
  const message = (value = '') => { statusElement.textContent = value; };

  function renderCameras(cameras) {
    cameraList.replaceChildren();
    if (!cameras.length) {
      cameraList.innerHTML = '<div class="empty-settings"><strong>Nessuna camera locale configurata</strong></div>';
      return;
    }
    for (const camera of cameras) {
      const card = document.createElement('article');
      card.className = 'sensor-device';
      const title = document.createElement('strong');
      title.textContent = camera.alias;
      const identity = document.createElement('span');
      identity.textContent = `IP: ${camera.connection?.ip || 'non disponibile'}`;
      const state = document.createElement('small');
      state.textContent = camera.verificationStatus === 'verified' ? 'Verificata' : 'Da verificare';
      const actions = document.createElement('div');
      actions.className = 'sensor-actions';
      actions.append(button('Verifica', 'camera-verify', camera.id), button('Modifica', 'camera-edit', camera.id), button('Rimuovi', 'camera-remove', camera.id));
      card.append(title, identity, state, actions);
      cameraList.append(card);
    }
  }

  async function loadCameras() {
    try { renderCameras((await request('/api/hardware/cameras')).cameras); } catch (error) { message(error.message); }
  }

  cameraForm.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(cameraForm));
    try {
      await request(data.id ? `/api/hardware/cameras/${encodeURIComponent(data.id)}` : '/api/hardware/cameras', { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) });
      cameraForm.reset();
      cameraCancel.hidden = true;
      message('Camera salvata. Verificala prima dell’uso.');
      await loadCameras();
    } catch (error) { message(error.message); }
  });
  cameraCancel.addEventListener('click', () => { cameraForm.reset(); cameraCancel.hidden = true; message(); });
  cameraList.addEventListener('click', async event => {
    const target = event.target;
    const id = target.dataset.id;
    if (!id) return;
    try {
      if (target.dataset.action === 'camera-verify') { await request(`/api/hardware/cameras/${encodeURIComponent(id)}/verify`, { method: 'POST' }); message('Camera verificata.'); }
      if (target.dataset.action === 'camera-remove') { await request(`/api/hardware/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' }); message('Camera rimossa.'); }
      if (target.dataset.action === 'camera-edit') {
        const camera = (await request('/api/hardware/cameras')).cameras.find(item => item.id === id);
        cameraForm.elements.id.value = camera.id;
        cameraForm.elements.alias.value = camera.alias;
        cameraForm.elements.ip.value = camera.connection?.ip || '';
        cameraForm.elements.mac.value = camera.identity?.mac || '';
        cameraForm.elements.role.value = camera.role || 'none';
        cameraCancel.hidden = false;
        cameraForm.elements.alias.focus();
        return;
      }
      await loadCameras();
    } catch (error) { message(error.message); }
  });

  function plugRoleSelect(plug) {
    const select = document.createElement('select');
    select.dataset.action = 'plug-role';
    select.dataset.id = plug.id;
    for (const [value, label] of [['none', 'Nessun ruolo'], ['pump', 'Pompa'], ['heater', 'Riscaldatore']]) select.add(new Option(label, value, false, plug.role === value));
    return select;
  }

  function renderPlugs(plugs) {
    plugList.replaceChildren();
    if (!plugs.length) {
      plugList.innerHTML = '<div class="empty-settings"><strong>Nessuna presa configurata</strong></div>';
      return;
    }
    for (const plug of plugs) {
      const card = document.createElement('article');
      card.className = 'sensor-device';
      const title = document.createElement('strong');
      title.textContent = plug.alias;
      const info = document.createElement('span');
      info.textContent = `${plug.model} · ${plug.connection?.ip || 'IP non disponibile'} · ${plug.protocol}`;
      const state = document.createElement('small');
      state.textContent = plug.verificationStatus === 'verified' ? 'Verificata' : 'Da verificare';
      const actions = document.createElement('div');
      actions.className = 'sensor-actions';
      actions.append(plugRoleSelect(plug), button('Verifica', 'plug-verify', plug.id), button('Modifica', 'plug-edit', plug.id), button('Rimuovi', 'plug-remove', plug.id));
      card.append(title, info, state, actions);
      plugList.append(card);
    }
  }

  async function loadPlugs() {
    try {
      const result = await request('/api/hardware/pond-plugs');
      renderPlugs(result.plugs);
      if (result.ownership !== 'home') message('Prese Pond predisposte offline: Home-Control non è owner. Verifica e comandi hardware sono bloccati.');
    } catch (error) { message(error.message); }
  }

  plugForm.addEventListener('submit', async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(plugForm));
    try {
      await request(data.id ? `/api/hardware/pond-plugs/${encodeURIComponent(data.id)}` : '/api/hardware/pond-plugs', { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) });
      plugForm.reset();
      plugCancel.hidden = true;
      message('Presa salvata. Verificala prima dell’uso.');
      await loadPlugs();
    } catch (error) { message(error.message); }
  });
  plugCancel.addEventListener('click', () => { plugForm.reset(); plugCancel.hidden = true; message(); });
  plugList.addEventListener('click', async event => {
    const target = event.target;
    const id = target.dataset.id;
    if (!id) return;
    try {
      if (target.dataset.action === 'plug-verify') { await request(`/api/hardware/pond-plugs/${encodeURIComponent(id)}/verify`, { method: 'POST' }); message('Presa verificata.'); }
      if (target.dataset.action === 'plug-remove') { await request(`/api/hardware/pond-plugs/${encodeURIComponent(id)}`, { method: 'DELETE' }); message('Presa rimossa.'); }
      if (target.dataset.action === 'plug-edit') {
        const plug = (await request('/api/hardware/pond-plugs')).plugs.find(item => item.id === id);
        plugForm.elements.id.value = plug.id;
        plugForm.elements.alias.value = plug.alias;
        plugForm.elements.ip.value = plug.connection?.ip || '';
        plugForm.elements.mac.value = plug.identity?.mac || '';
        plugCancel.hidden = false;
        plugForm.elements.alias.focus();
        return;
      }
      await loadPlugs();
    } catch (error) { message(error.message); }
  });
  plugList.addEventListener('change', async event => {
    const target = event.target;
    if (target.dataset.action !== 'plug-role') return;
    try { await request('/api/pond/roles', { method: 'PUT', body: JSON.stringify({ deviceId: target.dataset.id, role: target.value }) }); message('Ruolo presa aggiornato.'); } catch (error) { message(error.message); }
    await loadPlugs();
  });

  void loadCameras();
  void loadPlugs();
}

const standaloneContent = document.querySelector('[data-settings-content]');
if (standaloneContent) initSettings(standaloneContent);
