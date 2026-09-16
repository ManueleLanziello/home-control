// Static assets are optional; the original SVG bases remain authoritative.
export const STATIC_WEATHER_FILES = Object.freeze({
  sereno: 'LAYER-METEO-SERENO.svg',
  nuvoloso: 'LAYER-METEO-NUVOLOSO.svg',
  pioggia: 'LAYER-METEO-PIOGGIA.svg',
  temporale: 'LAYER-METEO-TEMPORALE.svg',
  neve: 'LAYER-METEO-NEVE.svg',
  none: null,
});
export function staticWeatherCondition(code) {
  if (code == null || code === '') return 'none';
  const value = Number(code);
  if (value === 0) return 'sereno';
  if ([1, 2, 3, 45, 48].includes(value)) return 'nuvoloso';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'pioggia';
  if ([95, 96, 99].includes(value)) return 'temporale';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'neve';
  return 'none';
}
export function createStaticWeatherRenderer({ stage, assets, assetUrl, before }) {
  let image = null;
  let active = 'none';
  const clear = () => { image?.remove(); image = null; };
  return {
    render(condition) {
      const state = Object.hasOwn(STATIC_WEATHER_FILES, condition) ? condition : 'none';
      if (state === active) return;
      active = state;
      clear();
      const file = STATIC_WEATHER_FILES[state];
      if (!file || !assets.has(file)) return;
      const next = document.createElement('img');
      next.className = 'floorplan-stack-layer floorplan-static-weather';
      next.alt = '';
      next.setAttribute('aria-hidden', 'true');
      next.style.pointerEvents = 'none';
      next.dataset.weatherState = state;
      next.addEventListener('error', () => { if (image === next) clear(); }, { once: true });
      image = next;
      stage.insertBefore(next, before);
      next.src = assetUrl(file);
    },
    destroy: clear,
  };
}
