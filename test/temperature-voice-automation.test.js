import test from 'node:test';
import assert from 'node:assert/strict';
import { TemperatureVoiceAutomation, TEMPERATURE_VOICE_ROOMS } from '../src/temperature-voice-automation.js';

const sample = (temperature, available = true) => ({ temperature, online: available, available });
test('AUT-003 usa le cinque associazioni autorevoli e non annuncia mai lo stato iniziale', async () => {
  assert.deepEqual(TEMPERATURE_VOICE_ROOMS, { S1: 'Cucina', S2: 'Camera', S3: 'Salotto', S4: 'Cameretta', S5: 'Laghetto' });
  const events = []; const store = { async read() { return { thresholds: { S1: 20, S2: 20, S3: 20, S4: 20, S5: 20 }, voices: Object.fromEntries(['S1','S2','S3','S4','S5'].map(id => [id, { enabled: true, volume: 37 }])) }; } };
  const automation = new TemperatureVoiceAutomation({ store, publish: event => events.push(event) });
  for (const id of Object.keys(TEMPERATURE_VOICE_ROOMS)) await automation.observe(id, sample(19));
  assert.equal(events.length, 0);
  for (const id of Object.keys(TEMPERATURE_VOICE_ROOMS)) { await automation.observe(id, sample(20.5)); await automation.observe(id, sample(19.9)); }
  assert.deepEqual(events.map(event => event.room), ['Cucina', 'Camera', 'Salotto', 'Cameretta', 'Laghetto']); assert.ok(events.every(event => event.volume === 37));
});
test('AUT-003 deduplica sotto soglia, si riarma a soglia più 0.5 e ignora offline o valori non validi', async () => {
  const events = []; const state = { enabled: true }; const store = { async read() { return { thresholds: { S1: 20 }, voices: { S1: { enabled: state.enabled, volume: 65 } } }; } };
  const automation = new TemperatureVoiceAutomation({ store, publish: event => events.push(event) });
  await automation.observe('S1', sample(21)); await automation.observe('S1', sample(19.9)); await automation.observe('S1', sample(19)); await automation.observe('S1', sample(20.4));
  assert.equal(events.length, 1); await automation.observe('S1', sample(20.5)); await automation.observe('S1', sample(19.9)); assert.equal(events.length, 2);
  await automation.observe('S1', sample(21, false)); await automation.observe('S1', { temperature: NaN, online: true, available: true }); assert.equal(events.length, 2);
  state.enabled = false; automation.invalidate('S1'); await automation.observe('S1', sample(19)); state.enabled = true; await automation.observe('S1', sample(19)); assert.equal(events.length, 2);
});
