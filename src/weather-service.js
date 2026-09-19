const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const CONDITIONS = new Map([
  [0, 'Sereno'], [1, 'Prevalentemente sereno'], [2, 'Parzialmente nuvoloso'], [3, 'Coperto'],
  [45, 'Nebbia'], [48, 'Nebbia con brina'], [51, 'Pioviggine debole'], [53, 'Pioviggine'], [55, 'Pioviggine intensa'],
  [56, 'Pioviggine gelata'], [57, 'Pioviggine gelata intensa'], [61, 'Pioggia debole'], [63, 'Pioggia'], [65, 'Pioggia intensa'],
  [66, 'Pioggia gelata'], [67, 'Pioggia gelata intensa'], [71, 'Neve debole'], [73, 'Neve'], [75, 'Neve intensa'], [77, 'Nevischio'],
  [80, 'Rovesci deboli'], [81, 'Rovesci'], [82, 'Rovesci intensi'], [85, 'Rovesci di neve'], [86, 'Rovesci di neve intensi'],
  [95, 'Temporale'], [96, 'Temporale con grandine'], [99, 'Temporale intenso con grandine'],
]);

const WMO_CATEGORIES = new Map([
  [0, 'clear'], [1, 'mostly-clear'], [2, 'partly-cloudy'], [3, 'cloudy'],
  [45, 'fog'], [48, 'fog'], [51, 'drizzle'], [53, 'drizzle'],
  [55, 'extreme-drizzle'], [56, 'extreme-drizzle'], [57, 'extreme-drizzle'],
  [61, 'rain'], [63, 'rain'], [66, 'rain'],
  [65, 'extreme-rain'], [67, 'extreme-rain'], [80, 'extreme-rain'], [81, 'extreme-rain'], [82, 'extreme-rain'],
  [71, 'snow'], [73, 'snow'], [75, 'snow'], [77, 'snow'],
  [85, 'extreme-snow'], [86, 'extreme-snow'],
  [95, 'thunderstorms'], [96, 'thunderstorms-rain'], [99, 'thunderstorms-rain'],
]);

const WEATHER_ICONS = Object.freeze({
  clear: { day: 'clear-day.svg', night: 'clear-night.svg' },
  'mostly-clear': { day: 'mostly-clear-day.svg', night: 'mostly-clear-night.svg' },
  'partly-cloudy': { day: 'partly-cloudy-day.svg', night: 'partly-cloudy-night.svg' },
  cloudy: { day: 'cloudy.svg', night: 'cloudy.svg' },
  fog: { day: 'fog.svg', night: 'fog-night.svg' },
  drizzle: { day: 'drizzle.svg', night: 'drizzle.svg' },
  'extreme-drizzle': { day: 'extreme-drizzle.svg', night: 'extreme-night-drizzle.svg' },
  rain: { day: 'rain.svg', night: 'rain.svg' },
  'extreme-rain': { day: 'extreme-rain.svg', night: 'extreme-night-rain.svg' },
  snow: { day: 'snow.svg', night: 'snow.svg' },
  'extreme-snow': { day: 'extreme-snow.svg', night: 'extreme-night-snow.svg' },
  thunderstorms: { day: 'thunderstorms.svg', night: 'thunderstorms-night.svg' },
  'thunderstorms-rain': { day: 'thunderstorms-rain.svg', night: 'thunderstorms-night-rain.svg' },
});

export function weatherCategory(code) {
  return WMO_CATEGORIES.get(Number(code)) || 'cloudy';
}

export const weatherIcon = (code, isDay = true) => WEATHER_ICONS[weatherCategory(code)][isDay === false ? 'night' : 'day'];
export const weatherCondition = code => CONDITIONS.get(Number(code)) || 'Condizioni non disponibili';

function requiredNumber(value, field) {
  if (!Number.isFinite(value)) throw new Error(`Dato meteo non valido: ${field}`);
  return value;
}

const optionalNumber = value => Number.isFinite(value) ? value : null;
const at = (values, index) => Array.isArray(values) ? values[index] : undefined;
const weatherValue = (code, { isDay = true, ...extra } = {}) => ({
  weatherCode: requiredNumber(code, 'weather_code'),
  category: weatherCategory(code),
  condition: weatherCondition(code),
  icon: weatherIcon(code, isDay),
  isDay: isDay !== false,
  ...extra,
});

export function parseOpenMeteo(payload, config, updatedAt = new Date().toISOString()) {
  if (!payload?.current || !payload?.daily || !Array.isArray(payload.daily.time)) throw new Error('Risposta Open-Meteo incompleta');
  const current = payload.current;
  const daily = payload.daily;
  const currentTime = String(current.time || '');
  const currentDate = currentTime.slice(0, 10);
  const hourly = payload.hourly || {};
  const currentHourlyIndex = Array.isArray(hourly.time) ? hourly.time.findIndex(time => time === currentTime) : -1;
  const currentRainProbability = optionalNumber(at(hourly.precipitation_probability, currentHourlyIndex));
  const dailyForecast = daily.time.slice(0, 5).map((date, index) => weatherValue(at(daily.weather_code, index), {
    date,
    minTemperature: optionalNumber(at(daily.temperature_2m_min, index)),
    maxTemperature: optionalNumber(at(daily.temperature_2m_max, index)),
    rainProbability: optionalNumber(at(daily.precipitation_probability_max, index)), isDay: true,
  }));
  if (!dailyForecast.length) throw new Error('Previsione Open-Meteo insufficiente');
  const remainingHourly = (hourly.time || []).map((time, index) => ({ time, index }))
    .filter(({ time }) => time.slice(0, 10) === currentDate && time > currentTime).slice(0, 6)
    .map(({ time, index }) => weatherValue(at(hourly.weather_code, index), {
      time,
      temperature: optionalNumber(at(hourly.temperature_2m, index)),
      precipitation: optionalNumber(at(hourly.precipitation, index)),
      rainProbability: optionalNumber(at(hourly.precipitation_probability, index)),
      isDay: at(hourly.is_day, index) !== 0,
    }));
  return {
    available: true,
    stale: false,
    location: config.locationName,
    timezone: config.timezone,
    updatedAt,
    current: weatherValue(current.weather_code, {
      temperature: requiredNumber(current.temperature_2m, 'current.temperature_2m'),
      apparentTemperature: optionalNumber(current.apparent_temperature),
      humidity: optionalNumber(current.relative_humidity_2m),
      windSpeed: optionalNumber(current.wind_speed_10m),
      windDirection: optionalNumber(current.wind_direction_10m),
      precipitation: optionalNumber(current.precipitation),
      rainProbability: currentRainProbability,
      isDay: current.is_day !== 0,
    }),
    today: dailyForecast[0],
    hourly: remainingHourly,
    daily: dailyForecast,
  };
}

export class WeatherService {
  constructor({ config, fetchImpl = fetch, now = () => Date.now(), logError = () => {} }) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.logError = logError;
    this.current = { available: false, stale: true, location: config.locationName, timezone: config.timezone, updatedAt: null, current: null, today: null, hourly: [], daily: [] };
    this.refreshPromise = null;
  }

  url() {
    const url = new URL(FORECAST_URL);
    url.searchParams.set('latitude', String(this.config.latitude));
    url.searchParams.set('longitude', String(this.config.longitude));
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m,wind_direction_10m,precipitation');
    url.searchParams.set('hourly', 'temperature_2m,weather_code,is_day,precipitation_probability,precipitation');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
    url.searchParams.set('timezone', this.config.timezone);
    url.searchParams.set('forecast_days', '5');
    return url;
  }

  snapshot() {
    const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
    const expired = !updatedMs || this.now() - updatedMs > this.config.staleAfterMs;
    return structuredClone({ ...this.current, stale: this.current.stale || expired });
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      try {
        const response = await this.fetchImpl(this.url(), { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
        this.current = parseOpenMeteo(await response.json(), this.config, new Date(this.now()).toISOString());
      } catch (error) {
        this.current = { ...this.current, stale: true };
        this.logError(`[METEO] aggiornamento non riuscito: ${error.message}`);
      } finally {
        this.refreshPromise = null;
      }
      return this.snapshot();
    })();
    return this.refreshPromise;
  }

  async getSnapshot() {
    const updatedMs = this.current.updatedAt ? Date.parse(this.current.updatedAt) : 0;
    if (!updatedMs || this.now() - updatedMs >= this.config.refreshIntervalMs) return this.refresh();
    return this.snapshot();
  }
}
