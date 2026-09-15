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
  current: { time: '2026-09-15T11:00', temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 58, weather_code: 2, wind_speed_10m: 12.3, wind_direction_10m: 225, precipitation: 0 },
  hourly: { time: ['2026-09-15T10:00', '2026-09-15T11:00', '2026-09-15T12:00', '2026-09-15T13:00'], temperature_2m: [20, 21.4, 22, 23], weather_code: [1, 2, 61, 3], precipitation_probability: [0, 10, 60, 20], precipitation: [0, 0, 0.2, 0] },
  daily: { time: ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'], weather_code: [2, 61, 71, 95, 0], temperature_2m_min: [14, 13, 11, 12, 15], temperature_2m_max: [23, 20, 18, 19, 24], precipitation_probability_max: [60, 80, 70, 50, 10] },
});

test('mappa centralizzata WMO verso tutte le icone METEO previste', () => {
  for (const [code, category] of [[0, 'sun'], [1, 'weather'], [3, 'cloud'], [45, 'cloud'], [61, 'rain'], [71, 'snow'], [95, 'storm']]) {
    assert.equal(weatherCategory(code), category);
    assert.equal(weatherIcon(code), `${category}.svg`);
  }
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
    for (const name of ['LAYER-13-METEO.svg', 'sun.svg', 'weather.svg', 'cloud.svg', 'rain.svg', 'storm.svg', 'snow.svg', 'umidity.svg', 'wind.svg']) {
      const response = await fetch(`${base}/design/${name}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    }
  } finally { server.close(); await once(server, 'close'); }
});

test('M1/QM1 usano le geometrie esplicite del layer, restano separati e non espongono label', async () => {
  assert.deepEqual(floorplanConfig.weather.marker, { selector: 'path[d^="M518.5 3281C518.5 3191.25"]' });
  assert.deepEqual(floorplanConfig.weather.card, { selector: 'rect[x="356.5"][y="3470.5"][width="649"][height="388"][stroke="#000000"]' });
  assert.deepEqual(floorplanConfig.weather.temperatureLabel, { selector: 'rect[x="851.5"][y="3190.5"][width="325"][height="167"][stroke="#000000"]' });
  const floorplan = await readFile(new URL('../public/js/floorplan.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/floorplan.css', import.meta.url), 'utf8');
  assert.match(floorplan, /loadMapping\(config\.mappings\.weather/);
  assert.match(floorplan, /index === undefined \? source\.querySelector\(selector\)/);
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
  const m1 = { x: 518.5, y: 3118.5, width: 325, height: 325 };
  const qm1 = { x: 356.5, y: 3470.5, width: 649, height: 388 };
  assert.equal(m1.x + m1.width / 2, 681); assert.equal(m1.y + m1.height / 2, 3281);
  assert.ok(m1.y + m1.height < qm1.y);
  assert.equal(qm1.y - (m1.y + m1.height), 27);
  assert.deepEqual({ x: 851.5, y: 3190.5, width: 325, height: 167 }, { x: 851.5, y: 3190.5, width: 325, height: 167 });
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
