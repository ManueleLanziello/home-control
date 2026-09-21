import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { WEATHER_CONFIG } from '../config/weather.js';
import { parseOpenMeteo, weatherCategory, weatherIcon, WeatherService } from '../src/weather-service.js';
import { createHomeControlServer } from '../server.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';

const config = { ...WEATHER_CONFIG, refreshIntervalMs: 900_000, staleAfterMs: 1_800_000 };
const payload = () => ({
  current: { time: '2026-09-15T11:00', temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 58, weather_code: 2, is_day: 1, wind_speed_10m: 12.3, wind_direction_10m: 225, precipitation: 0 },
  hourly: { time: ['2026-09-15T10:00', '2026-09-15T11:00', '2026-09-15T12:00', '2026-09-15T13:00'], temperature_2m: [20, 21.4, 22, 23], weather_code: [1, 2, 61, 3], is_day: [1, 1, 1, 1], precipitation_probability: [0, 10, 60, 20], precipitation: [0, 0, 0.2, 0] },
  daily: { time: ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'], weather_code: [2, 61, 71, 95, 0], temperature_2m_min: [14, 13, 11, 12, 15], temperature_2m_max: [23, 20, 18, 19, 24], precipitation_probability_max: [60, 80, 70, 50, 10] },
});

test('mappa centralizzata WMO verso i tredici stati semantici METEO', () => {
  for (const [code, category] of [[0, 'clear'], [1, 'mostly-clear'], [2, 'partly-cloudy'], [3, 'cloudy'], [45, 'fog'], [48, 'fog'], [51, 'drizzle'], [53, 'drizzle'], [55, 'extreme-drizzle'], [56, 'extreme-drizzle'], [57, 'extreme-drizzle'], [61, 'rain'], [63, 'rain'], [66, 'rain'], [65, 'extreme-rain'], [67, 'extreme-rain'], [80, 'extreme-rain'], [81, 'extreme-rain'], [82, 'extreme-rain'], [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'], [85, 'extreme-snow'], [86, 'extreme-snow'], [95, 'thunderstorms'], [96, 'thunderstorms-rain'], [99, 'thunderstorms-rain']]) {
    assert.equal(weatherCategory(code), category);
  }
  assert.equal(weatherCategory(999), 'cloudy');
});

test('sceglie la variante giorno/notte del nuovo set solo quando prevista', () => {
  for (const [code, day, night] of [[0, 'clear-day.svg', 'clear-night.svg'], [1, 'mostly-clear-day.svg', 'mostly-clear-night.svg'], [2, 'partly-cloudy-day.svg', 'partly-cloudy-night.svg'], [45, 'fog.svg', 'fog-night.svg'], [55, 'extreme-drizzle.svg', 'extreme-night-drizzle.svg'], [65, 'extreme-rain.svg', 'extreme-night-rain.svg'], [85, 'extreme-snow.svg', 'extreme-night-snow.svg'], [95, 'thunderstorms.svg', 'thunderstorms-night.svg'], [96, 'thunderstorms-rain.svg', 'thunderstorms-night-rain.svg']]) {
    assert.equal(weatherIcon(code, true), day); assert.equal(weatherIcon(code, false), night);
  }
  for (const code of [3, 51, 61, 71]) assert.equal(weatherIcon(code, true), weatherIcon(code, false));
});

test('normalizza current, resto della giornata e previsione giornaliera Open-Meteo', () => {
  const weather = parseOpenMeteo(payload(), config, '2026-09-15T09:00:00.000Z');
  assert.equal(weather.current.temperature, 21.4);
  assert.equal(weather.current.apparentTemperature, 20.9);
  assert.equal(weather.current.humidity, 58);
  assert.equal(weather.current.rainProbability, 10);
  assert.equal(weather.today.rainProbability, 60);
  assert.equal(weather.today.maxTemperature, 23);
  assert.equal(weather.hourly.length, 2);
  assert.equal(weather.hourly[0].icon, 'rain.svg');
  assert.equal(weather.daily.length, 5);
  assert.equal(weather.daily[2].icon, 'snow.svg');
});

test('cache 15 minuti e fallback stale mantengono l ultimo dato valido', async () => {
  let now = Date.parse('2026-09-15T09:00:00.000Z'); let calls = 0; let fail = false;
  const service = new WeatherService({ config, now: () => now, logError: () => {}, fetchImpl: async () => {
    calls += 1;
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => payload() };
  } });
  assert.equal((await service.getSnapshot()).current.temperature, 21.4);
  now += 60_000; await service.getSnapshot(); assert.equal(calls, 1);
  fail = true; now += config.refreshIntervalMs; const stale = await service.getSnapshot();
  assert.equal(calls, 2); assert.equal(stale.stale, true); assert.equal(stale.current.temperature, 21.4);
});

test('API METEO restituisce lo snapshot backend senza dipendenze hardware', async () => {
  const expected = { available: true, stale: false, location: 'Test', current: { temperature: 20 }, today: null, hourly: [], daily: [] };
  const server = createHomeControlServer({ weatherService: { async getSnapshot() { return expected; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/weather`);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
  } finally { server.close(); await once(server, 'close'); }
});

test('asset METEO vengono esposti dalla stessa rotta design della planimetria', async () => {
  const server = createHomeControlServer({ weatherService: { async getSnapshot() { return {}; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const name of ['clear-day.svg', 'clear-night.svg', 'mostly-clear-day.svg', 'mostly-clear-night.svg', 'partly-cloudy-day.svg', 'partly-cloudy-night.svg', 'cloudy.svg', 'fog.svg', 'fog-night.svg', 'drizzle.svg', 'extreme-drizzle.svg', 'extreme-night-drizzle.svg', 'rain.svg', 'extreme-rain.svg', 'extreme-night-rain.svg', 'snow.svg', 'extreme-snow.svg', 'extreme-night-snow.svg', 'thunderstorms.svg', 'thunderstorms-night.svg', 'thunderstorms-rain.svg', 'thunderstorms-night-rain.svg']) {
      const response = await fetch(`${base}/design/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    }
  } finally { server.close(); await once(server, 'close'); }
});

test('il rendering METEO usa cloudy come fallback e non referenzia più il set legacy', async () => {
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /cloudy\.svg/);
  assert.doesNotMatch(floorplan, /weather\.svg|cloud\.svg|sun\.svg|storm\.svg/);
});

test('M1/QM1/LM1 sono identificati da label stabili e ne leggono la geometria dal layer', async () => {
  assert.deepEqual(floorplanConfig.weather.marker, { label: 'M1' });
  assert.deepEqual(floorplanConfig.weather.card, { label: 'QM1' });
  assert.deepEqual(floorplanConfig.weather.temperatureLabel, { label: 'LM1' });
  const [floorplan, layer13] = await Promise.all([readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8'), readFile(new URL('../design/LAYER-13-METEO.svg', import.meta.url), 'utf8')]);
  const css = await readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8');
  assert.match(floorplan, /loadMapping\(config\.mappings\.weather/);
  for (const label of ['M1', 'QM1', 'LM1']) assert.match(layer13, new RegExp(`>${label}</text>`));
  const movedLayer = layer13.replace('M453.5 3237', 'M999.5 999').replace('x="356.5" y="3456.5"', 'x="999.5" y="999.5"').replace('x="520.5" y="3826.5"', 'x="777.5" y="777.5"');
  for (const label of ['M1', 'QM1', 'LM1']) assert.match(movedLayer, new RegExp(`>${label}</text>`));
  assert.match(floorplan, /shapeForLabel\(source, label\)/);
  assert.match(floorplan, /const bounds = shape\.getBBox\(\)/);
  assert.match(floorplan, /bindWeatherPopupTrigger\(weatherMarker\)/);
  assert.match(floorplan, /bindWeatherPopupTrigger\(weatherCard\)/);
  assert.doesNotMatch(floorplan, /weatherCard\.append\(headline, range, facts\)/);
  assert.match(floorplan, /\[\['umidity\.svg', weatherPercent/);
  assert.match(floorplan, /\['wind\.svg', `\$\{weatherNumber\(current\?\.windSpeed\)\} km\/h`\]/);
  assert.match(floorplan, /\['rain\.svg', weatherPercent/);
  assert.match(floorplan, /weatherPercent\(snapshot\?\.today\?\.rainProbability\)/);
  assert.match(floorplan, /weatherTemperatureReading\.textContent = Number\.isFinite\(current\?\.temperature\) \? current\.temperature\.toFixed\(1\) \+ ' °C'/);
  assert.match(floorplan, /class: 'floorplan-reading'/);
  assert.match(floorplan, /floorplan-weather-card/);
  assert.match(floorplan, /weather-dialog/);
  assert.match(css, /\.floorplan-mapping-source \{ visibility: hidden; \}/);
  assert.match(css, /\.floorplan-marker-weather > img \{ width: 100%; height: 100%; object-fit: contain; \}/);
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /font-size: 46px; font-weight: 700/);
  assert.match(css, /grid-template-rows: minmax\(0, 2fr\) minmax\(0, 1fr\)/);
  assert.match(css, /width: 82%; height: 100%; object-fit: contain/);
  assert.doesNotMatch(JSON.stringify(floorplanConfig.weather), /\[d|\[x=|\[y=/);
});

test('probabilità giornaliera 0 resta un dato valido e il dato assente resta non disponibile', () => {
  const source = payload();
  source.daily.precipitation_probability_max[0] = 0;
  assert.equal(parseOpenMeteo(source, config).today.rainProbability, 0);
  source.daily.precipitation_probability_max[0] = undefined;
  assert.equal(parseOpenMeteo(source, config).today.rainProbability, null);
});

test('M1 e QM1 usano lo stesso trigger popup senza listener duplicati', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const { bindWeatherPopupTrigger } = await import('../public/js/floorplan.js');
  const createTarget = () => ({ listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); } });
  const m1 = createTarget(); const qm1 = createTarget(); let opened = 0;
  const openSamePopup = () => { opened += 1; };
  bindWeatherPopupTrigger(m1, openSamePopup);
  bindWeatherPopupTrigger(qm1, openSamePopup);
  assert.equal(m1.listeners.get('click').length, 1);
  assert.equal(qm1.listeners.get('click').length, 1);
  m1.listeners.get('click')[0](); qm1.listeners.get('click')[0]();
  assert.equal(opened, 2);
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  assert.match(floorplan, /let dialog = document\.querySelector\('\[data-weather-dialog\]'\)/);
  assert.match(floorplan, /if \(!dialog\) \{/);
});
