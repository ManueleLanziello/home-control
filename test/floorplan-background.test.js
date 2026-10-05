import test from 'node:test';
import assert from 'node:assert/strict';
import { floorplanConfig } from '../public/js/floorplan-config.js';
import { floorplanBackground, floorplanDayPeriod, floorplanWeatherCategory } from '../public/js/floorplan-state.js';

const sunrise = '2026-10-05T07:18:00';
const sunset = '2026-10-05T18:47:00';
const snapshot = (category, temperature = 12) => ({ current: { category, temperature }, today: { sunrise, sunset } });
const at = time => new Date(`2026-10-05T${time}`);

test('riduce le categorie meteo già normalizzate alle cinque varianti della planimetria', () => {
  for (const category of ['clear', 'mostly-clear']) assert.equal(floorplanWeatherCategory({ category, temperature: 12 }), 'sereno');
  for (const category of ['partly-cloudy', 'cloudy', 'fog']) assert.equal(floorplanWeatherCategory({ category, temperature: 12 }), 'coperto');
  for (const category of ['drizzle', 'extreme-drizzle', 'rain', 'extreme-rain', 'thunderstorms', 'thunderstorms-rain']) assert.equal(floorplanWeatherCategory({ category, temperature: 12 }), 'pioggia');
  for (const category of ['snow', 'extreme-snow']) assert.equal(floorplanWeatherCategory({ category, temperature: 12 }), 'neve');
});

test('rispetta la priorità neve, pioggia, ghiacciato, coperto, sereno', () => {
  assert.equal(floorplanWeatherCategory({ category: 'clear', temperature: 1.9 }), 'ghiacciato');
  assert.equal(floorplanWeatherCategory({ category: 'cloudy', temperature: 1.9 }), 'ghiacciato');
  assert.equal(floorplanWeatherCategory({ category: 'rain', temperature: 1.9 }), 'pioggia');
  assert.equal(floorplanWeatherCategory({ category: 'snow', temperature: 1.9 }), 'neve');
  assert.equal(floorplanWeatherCategory({ category: 'clear', temperature: 2.0 }), 'sereno');
  assert.equal(floorplanWeatherCategory({ category: 'cloudy', temperature: 2.0 }), 'coperto');
});

test('usa sunrise e sunset reali con confini inclusivo/esclusivo', () => {
  const weather = snapshot('clear');
  assert.equal(floorplanDayPeriod(weather, at('07:17:59')), 'notte');
  assert.equal(floorplanDayPeriod(weather, at('07:18:00')), 'giorno');
  assert.equal(floorplanDayPeriod(weather, at('18:46:59')), 'giorno');
  assert.equal(floorplanDayPeriod(weather, at('18:47:00')), 'notte');
  assert.equal(floorplanDayPeriod({ current: weather.current, today: {} }, at('12:00:00')), null);
});

test('seleziona esattamente tutti i dieci asset base previsti', () => {
  const expected = {
    'sereno-giorno': 'LAYER-SERENO-GIORNO.svg', 'sereno-notte': 'LAYER-SERENO-NOTTE.svg',
    'coperto-giorno': 'LAYER-COPERTO-GIORNO.svg', 'coperto-notte': 'LAYER-COPERTO-NOTTE.svg',
    'pioggia-giorno': 'LAYER-PIOGGIA-GIORNO.svg', 'pioggia-notte': 'LAYER-PIOGGIA-NOTTE.svg',
    'neve-giorno': 'LAYER-NEVE-GIORNO.svg', 'neve-notte': 'LAYER-NEVE-NOTTE.svg',
    'ghiacciato-giorno': 'LAYER-GHIACCIATO-GIORNO.svg', 'ghiacciato-notte': 'LAYER-GHIACCIATO-NOTTE.svg',
  };
  assert.deepEqual(floorplanConfig.backgrounds, expected);
  for (const [category, background] of [['clear', 'sereno'], ['cloudy', 'coperto'], ['rain', 'pioggia'], ['thunderstorms', 'pioggia'], ['snow', 'neve']]) {
    assert.equal(floorplanBackground(snapshot(category), at('12:00:00')), `${background}-giorno`);
    assert.equal(floorplanBackground(snapshot(category), at('20:00:00')), `${background}-notte`);
  }
  assert.equal(floorplanBackground(snapshot('clear', 1.9), at('12:00:00')), 'ghiacciato-giorno');
  assert.equal(floorplanBackground(snapshot('clear', 2.0), at('12:00:00')), 'sereno-giorno');
});
