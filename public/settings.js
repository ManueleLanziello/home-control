import { homeControlPath } from './base-path.js';

const statusElement = document.querySelector('#settings-status');
const form = document.querySelector('#sensor-form');
const list = document.querySelector('#sensor-devices');
const cancel = document.querySelector('#sensor-cancel');
const roles = Object.freeze({ none: 'Nessun ruolo', temperature_cucina: 'S1 · Cucina', temperature_camera: 'S2 · Camera', temperature_cameretta: 'S4 · Cameretta' });

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
