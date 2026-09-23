import { homeControlPath } from '../base-path.js';

function localTime(value) { return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(new Date(Number(value) * 1000)); }
function contentFor(dialog) { return dialog.querySelector('[data-camera-events-content]'); }
function releasePlayer(dialog) { const video = dialog.querySelector('video'); if (video) { video.pause(); video.removeAttribute('src'); video.load(); } }

function renderList(dialog, camera, payload) {
  releasePlayer(dialog); dialog.querySelector('[data-camera-events-title]').textContent = `Storico ${camera.id}`;
  const content = contentFor(dialog); content.replaceChildren();
  if (payload?.loading) { content.textContent = 'Caricamento…'; return; }
  if (payload?.error || payload?.available !== true) { content.textContent = 'Storico non disponibile.'; return; }
  if (!payload.events.length) { content.textContent = 'Nessuna registrazione nelle ultime 12 ore.'; return; }
  for (const event of payload.events) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'camera-events-row';
    const time = document.createElement('time'); time.dateTime = new Date(event.startTime * 1000).toISOString(); time.textContent = localTime(event.startTime);
    const duration = document.createElement('strong'); duration.textContent = `${event.durationSeconds} s`;
    row.append(time, duration); row.addEventListener('click', () => renderVideo(dialog, camera, payload, event)); content.append(row);
  }
}

function renderVideo(dialog, camera, payload, event) {
  const content = contentFor(dialog); content.replaceChildren();
  const back = document.createElement('button'); back.type = 'button'; back.className = 'camera-events-back'; back.textContent = '← Indietro'; back.addEventListener('click', () => renderList(dialog, camera, payload));
  const loading = document.createElement('p'); loading.textContent = 'Caricamento video…';
  const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.playsInline = true;
  video.src = homeControlPath(`/api/cameras/${camera.id}/events/${encodeURIComponent(event.id)}/video`);
  video.addEventListener('loadedmetadata', () => loading.remove(), { once: true });
  video.addEventListener('error', () => { releasePlayer(dialog); content.replaceChildren(back, Object.assign(document.createElement('p'), { textContent: 'Il player non ha ricevuto un MP4 valido. Torna all’elenco e riprova.' })); }, { once: true });
  content.append(back, loading, video);
}

export async function showCameraEventsPopup(camera, load = id => fetch(homeControlPath(`/api/cameras/${id}/events?hours=12`), { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error('events'); return response.json(); })) {
  let dialog = document.querySelector('[data-camera-events-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.className = 'camera-events-dialog'; dialog.dataset.cameraEventsDialog = '';
    dialog.innerHTML = '<header><h2 data-camera-events-title></h2><button type="button" data-camera-events-close aria-label="Chiudi storico">X</button></header><section data-camera-events-content></section>';
    dialog.querySelector('[data-camera-events-close]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => releasePlayer(dialog));
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); }); document.body.append(dialog);
  }
  renderList(dialog, camera, { loading: true }); if (!dialog.open) dialog.showModal();
  try { renderList(dialog, camera, await load(camera.id)); } catch { renderList(dialog, camera, { error: true }); }
}
