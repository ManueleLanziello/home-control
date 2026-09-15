const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

// Single Home-Control weather location. Defaults reuse the existing local setting,
// while deployment may override it without duplicating coordinates in application code.
export const WEATHER_CONFIG = Object.freeze({
  latitude: number(process.env.HOME_WEATHER_LATITUDE, 45.335967),
  longitude: number(process.env.HOME_WEATHER_LONGITUDE, 7.715512),
  locationName: process.env.HOME_WEATHER_LOCATION || 'Rivarolo Canavese',
  timezone: process.env.HOME_WEATHER_TIMEZONE || 'Europe/Rome',
  refreshIntervalMs: 15 * 60 * 1000,
  staleAfterMs: 30 * 60 * 1000,
});
