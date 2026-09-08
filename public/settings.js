import { homeControlPath } from './base-path.js';

const statusElement = document.querySelector('#settings-status');

async function loadHardware() {
  try {
    const response = await fetch(homeControlPath('/api/hardware'), { cache: 'no-store' });
    const hardware = await response.json();
    if (!response.ok) throw new Error(hardware.error || `HTTP ${response.status}`);

    if (!hardware.devices.length) {
      statusElement.replaceChildren();
      const title = document.createElement('strong');
      title.textContent = 'Nessun dispositivo configurato';
      const note = document.createElement('span');
      note.textContent = 'La gestione dei dispositivi verrà aggiunta in un passaggio successivo.';
      statusElement.append(title, note);
      return;
    }

    statusElement.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = `${hardware.devices.length} dispositivi configurati`;
    const note = document.createElement('span');
    note.textContent = 'La visualizzazione dei dispositivi sarà disponibile in un passaggio successivo.';
    statusElement.append(title, note);
  } catch {
    statusElement.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = 'Configurazione non disponibile';
    const note = document.createElement('span');
    note.textContent = 'Riprova ad aggiornare la pagina.';
    statusElement.append(title, note);
  }
}

void loadHardware();
