import { homeControlPath } from '../base-path.js';

// One download and one audio element per page; independent of device state.
export function createSwitchSound({ fetchImpl = globalThis.fetch, createAudio = () => new Audio(), createObjectURL = blob => URL.createObjectURL(blob) } = {}) {
  let preloadPromise;
  let audio;
  return {
    preload() {
      return preloadPromise ||= (async () => {
        try {
          const response = await fetchImpl(homeControlPath('/sounds/switch.ogg'), { cache: 'no-store' });
          if (!response.ok || response.status === 204) return;
          const blob = await response.blob();
          if (!blob.size) return;
          const player = createAudio();
          player.preload = 'auto';
          player.addEventListener('error', () => { audio = undefined; }, { once: true });
          player.src = createObjectURL(blob);
          audio = player;
          player.load();
        } catch { audio = undefined; }
      })();
    },
    play() {
      if (!audio) return;
      try {
        audio.currentTime = 0;
        audio.play()?.catch(() => {});
      } catch {}
    },
  };
}

export const switchSound = createSwitchSound();
