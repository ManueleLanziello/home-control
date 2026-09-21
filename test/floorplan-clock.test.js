import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { clockAngles, createFloorplanClock, formatDigitalTime } from '../public/js/floorplan-clock.js';
import { createHomeControlServer } from '../server.js';

class Node {
  constructor(tag) { this.tag = tag; this.attributes = {}; this.children = []; this.textUpdates = 0; this._textContent = ''; }
  set textContent(value) { this._textContent = value; this.textUpdates += 1; }
  get textContent() { return this._textContent; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...children) { this.children.push(...children); }
  remove() { this.removed = true; }
}

function clockFixture() {
  const listeners = new Map();
  const documentRef = {
    visibilityState: 'visible',
    createElementNS(namespace, tag) { return new Node(tag); },
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const overlay = new Node('svg');
  const frames = [];
  let current = new Date(2026, 0, 1, 3, 15, 30, 500);
  return { overlay, documentRef, frames, setNow(value) { current = value; }, create: box => createFloorplanClock({ overlay, box, documentRef, now: () => current, requestFrame: callback => { frames.push(callback); return frames.length; }, cancelFrame() {} }) };
}

test('calcola angoli fluidi di ore, minuti e secondi', () => {
  const angles = clockAngles(new Date(2026, 0, 1, 3, 15, 30, 500));
  assert.equal(angles.seconds, 183);
  assert.equal(angles.minutes, 93.05);
  assert.equal(angles.hours, 97.75416666666666);
});

test('costruisce un quadrante SVG scalato dalla bbox CLK1', () => {
  const fixture = clockFixture();
  const clock = fixture.create({ x: 10, y: 20, width: 120, height: 80 });
  const group = fixture.overlay.children[0];
  assert.equal(group.attributes.transform, 'translate(30 20) scale(0.8)');
  assert.equal(group.children[1].children.length, 12);
  assert.deepEqual(group.children.slice(3, 6).map(node => node.attributes.class), ['floorplan-clock-hand floorplan-clock-hour-hand', 'floorplan-clock-hand floorplan-clock-minute-hand', 'floorplan-clock-hand floorplan-clock-second-hand']);
  assert.match(group.children[3].attributes.transform, /^rotate\(97\.75416666666666 50 50\)$/);
  clock.destroy();
  assert.equal(group.removed, true);
});

test('mostra HH:MM a 24 ore senza numeri sul quadrante', () => {
  assert.equal(formatDigitalTime(new Date(2026, 0, 1, 8, 5, 59)), '08:05');
  assert.equal(formatDigitalTime(new Date(2026, 0, 1, 14, 7, 45)), '14:07');
  assert.equal(formatDigitalTime(new Date(2026, 0, 1, 23, 59, 59)), '23:59');
  const fixture = clockFixture();
  fixture.create({ x: 0, y: 0, width: 100, height: 100 });
  const group = fixture.overlay.children[0];
  const digital = group.children[2];
  assert.equal(group.children.some(node => node.attributes.class === 'floorplan-clock-numbers'), false);
  assert.equal(group.children.flatMap(node => node.children || []).some(node => ['12', '3', '6', '9'].includes(node.textContent)), false);
  assert.equal(digital.attributes.class, 'floorplan-clock-digital');
  assert.equal(digital.textContent, '03:15');
  assert.doesNotMatch(digital.textContent, /:\d{2}:/);
  assert.equal(digital.textUpdates, 1);
  fixture.frames.shift()();
  assert.equal(digital.textUpdates, 1);
  fixture.setNow(new Date(2026, 0, 1, 3, 16, 0));
  fixture.frames.shift()();
  assert.equal(digital.textContent, '03:16');
  assert.equal(digital.textUpdates, 2);
});

test('il modulo clock è servito e il bootstrap lo carica in modo fail-safe', async () => {
  const server = createHomeControlServer({ weatherService: { async getSnapshot() { return {}; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/js/floorplan-clock.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
    assert.match(await response.text(), /export function createFloorplanClock/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
