import test from 'node:test';
import assert from 'node:assert/strict';
import { bindSensorPopupTrigger, sensorReadingLines, sensorPopupRows, showSensorPopup, updateSensorPopup } from '../public/js/sensor-popup.js';

class Element extends EventTarget {
  constructor(tag) { super(); this.tagName = tag; this.dataset = {}; this.children = []; this.attributes = {}; this.classList = { add() {} }; this.open = false; }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  set innerHTML(value) {
    this.parts = Object.fromEntries([...value.matchAll(/data-sensor-(name|model|close|details)/g)]
      .map(match => [`[data-sensor-${match[1]}]`, new Element(match[1] === 'close' ? 'button' : 'div')]));
  }
  querySelector(selector) { return this.parts[selector]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const sensor = { name: 'SmartHomeS1', temperature: 27.8, humidity: 49.9, battery: 100, linkQuality: 192,
  online: true, updatedAt: '2026-09-16T12:00:00Z', model: 'SONOFF SNZB-02P', protocol: 'Zigbee' };

test('LS SONOFF mostra soltanto temperatura e umidita su due righe', () => {
  assert.deepEqual(sensorReadingLines(sensor), ['27,8 °C', '49,9 %']);
  assert.deepEqual(sensorReadingLines({}), ['— °C', '— %']);
  const rows = sensorPopupRows(sensor);
  assert.equal(rows.length, 7); assert.ok(rows.some(([key, value]) => key === 'Segnale Zigbee (LQI)' && value === '192'));
  assert.ok(rows.some(([key, value]) => key === 'Stato' && value === 'Online'));
  assert.ok(rows.some(([key, value]) => key === 'Protocollo' && value === 'Zigbee'));
  assert.ok(rows.some(([key, value]) => key === 'Ultimo aggiornamento' && value !== '—'));
  assert.ok(!rows.some(([key]) => /calibration|OTA|IEEE|update/i.test(key)));
});

test('icona e label aprono lo stesso popup, dati aggiornati e chiusura normale', t => {
  const previousDocument = globalThis.document;
  const body = new Element('body');
  globalThis.document = { body, createElement: tag => new Element(tag), querySelector: () => body.children[0] };
  t.after(() => { globalThis.document = previousDocument; });
  const icon = new Element('button'); const label = new Element('text');
  const opener = () => showSensorPopup('S1', sensor);
  bindSensorPopupTrigger(icon, opener); bindSensorPopupTrigger(label, opener);
  icon.dispatchEvent(new Event('click'));
  const dialog = body.children[0]; assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('[data-sensor-name]').textContent, 'SmartHomeS1');
  assert.equal(dialog.querySelector('[data-sensor-model]').textContent, 'SONOFF SNZB-02P');
  assert.equal(dialog.querySelector('[data-sensor-details]').children[0].children[1].textContent, '27,8 °C');
  dialog.querySelector('[data-sensor-close]').dispatchEvent(new Event('click')); assert.equal(dialog.open, false);
  label.dispatchEvent(new Event('click')); assert.equal(dialog.open, true); assert.equal(body.children.length, 1);
  updateSensorPopup({ S1: { ...sensor, temperature: 28.2, online: false } });
  const values = dialog.querySelector('[data-sensor-details]').children.map(row => row.children[1].textContent);
  assert.ok(values.includes('28,2 °C')); assert.ok(values.includes('Offline'));
  dialog.close();
  const keyboard = new Event('keydown', { cancelable: true }); Object.defineProperty(keyboard, 'key', { value: 'Enter' });
  label.dispatchEvent(keyboard); assert.equal(dialog.open, true); assert.equal(keyboard.defaultPrevented, true);
  assert.equal(label.attributes.tabindex, '0'); assert.equal(label.attributes.role, 'button');
  dialog.dispatchEvent(new Event('click')); assert.equal(dialog.open, false);
});
