import { homeControlPath } from './base-path.js';

const statusElement = document.querySelector('#settings-status');
const form = document.querySelector('#sensor-form');
const list = document.querySelector('#sensor-devices');
const cancel = document.querySelector('#sensor-cancel');
const cameraForm = document.querySelector('#camera-form');
const cameraList = document.querySelector('#camera-devices');
const cameraCancel = document.querySelector('#camera-cancel');
const sharedCamera = document.querySelector('#shared-camera');
const roles = Object.freeze({ none: 'Nessun ruolo', temperature_cucina: 'S1 · Cucina', temperature_camera: 'S2 · Camera', temperature_cameretta: 'S4 · Cameretta', temperature_giardino: 'S5 · Giardino' });

async function request(path, options = {}) {
  const response = await fetch(homeControlPath(path), { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}
function message(value = '') { statusElement.textContent = value; }
function button(label, action, id) { const item = document.createElement('button'); item.type = 'button'; item.textContent = label; item.dataset.action = action; item.dataset.id = id; return item; }
function roleSelect(sensor) {
  const select = document.createElement('select'); select.dataset.action = 'role'; select.dataset.id = sensor.id;
  for (const [role, label] of Object.entries(roles)) { const option = new Option(label, role, false, sensor.role === role); select.add(option); }
  const reserved = new Option('S3 · Salotto (WT200)', 'reserved', false, false); reserved.disabled = true; select.add(reserved);
  return select;
}
function render(sensors) {
  list.replaceChildren();
  if (!sensors.length) { list.innerHTML = '<div class="empty-settings"><strong>Nessun sensore configurato</strong></div>'; return; }
  for (const sensor of sensors) {
    const card = document.createElement('article'); card.className = 'sensor-device';
    const title = document.createElement('strong'); title.textContent = sensor.alias;
    const identity = document.createElement('span'); identity.textContent = `Tuya: ${sensor.identity?.tuyaDeviceId || 'non disponibile'}`;
    const state = document.createElement('small'); state.textContent = sensor.verificationStatus === 'verified' ? 'Verificato' : 'Da verificare';
    const actions = document.createElement('div'); actions.className = 'sensor-actions'; actions.append(roleSelect(sensor), button('Verifica', 'verify', sensor.id), button('Modifica', 'edit', sensor.id), button('Rimuovi', 'remove', sensor.id));
    card.append(title, identity, state, actions); list.append(card);
  }
}
async function load() { try { render((await request('/api/hardware/sensors')).sensors); } catch (error) { message(error.message); } }
function renderCameras(cameras, shared) {
  cameraList.replaceChildren();
  if (!cameras.length) cameraList.innerHTML = '<div class="empty-settings"><strong>Nessuna camera locale configurata</strong></div>';
  for (const camera of cameras) {
    const card = document.createElement('article'); card.className = 'sensor-device';
    const title = document.createElement('strong'); title.textContent = camera.alias;
    const identity = document.createElement('span'); identity.textContent = `IP: ${camera.connection?.ip || 'non disponibile'}`;
    const state = document.createElement('small'); state.textContent = camera.verificationStatus === 'verified' ? 'Verificata' : 'Da verificare';
    const actions = document.createElement('div'); actions.className = 'sensor-actions'; actions.append(button('Verifica', 'camera-verify', camera.id), button('Modifica', 'camera-edit', camera.id), button('Rimuovi', 'camera-remove', camera.id));
    card.append(title, identity, state, actions); cameraList.append(card);
  }
  sharedCamera.innerHTML = `<article class="sensor-device"><strong>C2 · Laghetto</strong><span>Condivisa da ${shared?.sourceApp || 'Pond-Control'}</span><small>${shared?.configured ? 'Endpoint Pond configurato' : 'Endpoint Pond non configurato'}</small></article>`;
}
async function loadCameras() { try { const result = await request('/api/hardware/cameras'); renderCameras(result.cameras, result.shared); } catch (error) { message(error.message); } }
form.addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(form));
  try { await request(data.id ? `/api/hardware/sensors/${encodeURIComponent(data.id)}` : '/api/hardware/sensors', { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) }); form.reset(); cancel.hidden = true; message('Sensore salvato. Verificalo prima dell’uso.'); await load(); } catch (error) { message(error.message); }
});
cancel.addEventListener('click', () => { form.reset(); cancel.hidden = true; message(); });
list.addEventListener('click', async event => {
  const target = event.target; const id = target.dataset.id; if (!id || target.dataset.action === 'role') return;
  try {
    if (target.dataset.action === 'verify') { await request(`/api/hardware/sensors/${encodeURIComponent(id)}/verify`, { method: 'POST' }); message('Sensore verificato.'); }
    if (target.dataset.action === 'remove') { await request(`/api/hardware/sensors/${encodeURIComponent(id)}`, { method: 'DELETE' }); message('Sensore rimosso.'); }
    if (target.dataset.action === 'edit') { const sensor = (await request('/api/hardware/sensors')).sensors.find(item => item.id === id); form.elements.id.value = sensor.id; form.elements.alias.value = sensor.alias; form.elements.tuyaDeviceId.value = sensor.identity?.tuyaDeviceId || ''; cancel.hidden = false; form.elements.alias.focus(); return; }
    await load();
  } catch (error) { message(error.message); }
});
list.addEventListener('change', async event => { const target = event.target; if (target.dataset.action !== 'role') return; try { await request('/api/device-roles', { method: 'PUT', body: JSON.stringify({ deviceId: target.dataset.id, role: target.value }) }); message('Ruolo aggiornato.'); await load(); } catch (error) { message(error.message); await load(); } });
void load();
cameraForm.addEventListener('submit', async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(cameraForm));
  try { await request(data.id ? `/api/hardware/cameras/${encodeURIComponent(data.id)}` : '/api/hardware/cameras', { method: data.id ? 'PUT' : 'POST', body: JSON.stringify(data) }); cameraForm.reset(); cameraCancel.hidden = true; message('Camera salvata. Verificala prima dell’uso.'); await loadCameras(); } catch (error) { message(error.message); }
});
cameraCancel.addEventListener('click', () => { cameraForm.reset(); cameraCancel.hidden = true; message(); });
cameraList.addEventListener('click', async event => {
  const target = event.target; const id = target.dataset.id; if (!id) return;
  try {
    if (target.dataset.action === 'camera-verify') { await request(`/api/hardware/cameras/${encodeURIComponent(id)}/verify`, { method: 'POST' }); message('Camera verificata.'); }
    if (target.dataset.action === 'camera-remove') { await request(`/api/hardware/cameras/${encodeURIComponent(id)}`, { method: 'DELETE' }); message('Camera rimossa.'); }
    if (target.dataset.action === 'camera-edit') { const camera = (await request('/api/hardware/cameras')).cameras.find(item => item.id === id); cameraForm.elements.id.value = camera.id; cameraForm.elements.alias.value = camera.alias; cameraForm.elements.ip.value = camera.connection?.ip || ''; cameraForm.elements.mac.value = camera.identity?.mac || ''; cameraForm.elements.role.value = camera.role || 'none'; cameraCancel.hidden = false; cameraForm.elements.alias.focus(); return; }
    await loadCameras();
  } catch (error) { message(error.message); }
});
void loadCameras();
