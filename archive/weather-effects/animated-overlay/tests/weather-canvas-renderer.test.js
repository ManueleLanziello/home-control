import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherCanvasRenderer, createWeatherPrng, WEATHER_CANVAS_LIMITS } from '../public/js/weather-canvas-renderer.js';

function fixture() {
  const calls = { rects: [], clips: [], clears: 0, observerCreates: 0, observes: 0, disconnects: 0 };
  const context = {
    setTransform() {},
    clearRect() { calls.clears += 1; },
    save() {}, restore() {}, beginPath() {},
    rect(x, y, width, height) { calls.rects.push({ x, y, width, height }); },
    clip(rule) { calls.clips.push(rule); },
    fillRect() {}, moveTo() {}, bezierCurveTo() {}, closePath() {}, fill() {}, ellipse() {}, stroke() {},
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
  const canvas = { width: 0, height: 0, getContext: () => context, getBoundingClientRect: () => ({ width: 932, height: 584 }) };
  const scheduled = new Map(); let nextFrameId = 0;
  const requestFrame = callback => { const id = ++nextFrameId; scheduled.set(id, callback); return id; };
  const cancelFrame = id => scheduled.delete(id);
  const observer = { observe() { calls.observes += 1; }, disconnect() { calls.disconnects += 1; } };
  const renderer = createWeatherCanvasRenderer({
    canvas,
    observedElement: {},
    viewBox: { x: 0, y: 0, width: 4932, height: 3091 },
    allowed: { x: 3.5, y: 3.5, width: 4932, height: 3091 },
    excluded: [
      { x: 1480.5, y: 62.5, width: 889, height: 575 },
      { x: 1236.5, y: 801.5, width: 2289, height: 2293 },
    ],
    requestFrame,
    cancelFrame,
    random: createWeatherPrng(12345),
    now: () => 0,
    pixelRatio: () => 3,
    createResizeObserver: () => { calls.observerCreates += 1; return observer; },
  });
  return { renderer, canvas, calls, scheduled };
}

const runFrame = (renderer, scheduled, time) => {
  const id = renderer.state().frameId;
  const callback = scheduled.get(id);
  assert.ok(callback);
  scheduled.delete(id);
  callback(time);
};

test('rain e storm condividono un solo RAF e cambiano frequenza senza resettare gli impatti', () => {
  const { renderer, scheduled } = fixture();
  renderer.setMode('rain');
  assert.equal(renderer.state().currentRate, 6);
  assert.equal(renderer.state().running, true);
  assert.equal(scheduled.size, 1);
  runFrame(renderer, scheduled, 0);
  assert.equal(renderer.state().emittedEvents, 1);
  const rainFrame = renderer.state().frameId;
  renderer.setMode('storm');
  assert.equal(renderer.state().currentRate, 11);
  assert.equal(renderer.state().emittedEvents, 1);
  assert.equal(renderer.state().frameId, rainFrame);
  assert.equal(scheduled.size, 1);
  renderer.setMode('rain');
  renderer.setMode('storm');
  assert.equal(scheduled.size, 1);
  renderer.destroy();
});

test('snow fog e OFF arrestano e puliscono il canvas, poi rain riparte con un solo RAF', () => {
  for (const inactiveMode of ['snow', 'fog', 'none']) {
    const { renderer, calls, scheduled } = fixture();
    renderer.setMode('rain');
    const clearsBeforeStop = calls.clears;
    renderer.setMode(inactiveMode);
    assert.equal(renderer.state().running, false);
    assert.equal(renderer.state().activeImpacts, 0);
    assert.equal(renderer.state().activeFragments, 0);
    assert.equal(scheduled.size, 0);
    assert.ok(calls.clears > clearsBeforeStop);
    renderer.setMode('rain');
    assert.equal(scheduled.size, 1);
    assert.equal(renderer.state().requestedFrames, 2);
    renderer.destroy();
  }
});

test('scheduler genera impatti locali ai rate rain e storm con dispersione a microgocce', () => {
  const simulate = mode => {
    const setup = fixture();
    setup.renderer.setMode(mode);
    let maxObjects = 0;
    for (let time = 0; time <= 30_000; time += 50) {
      runFrame(setup.renderer, setup.scheduled, time);
      const state = setup.renderer.state();
      maxObjects = Math.max(maxObjects, state.activeImpacts + state.activeFragments);
    }
    const state = setup.renderer.state();
    setup.renderer.destroy();
    return { ...state, maxObjects };
  };
  const rain = simulate('rain');
  const storm = simulate('storm');
  assert.ok(rain.emittedEvents >= WEATHER_CANVAS_LIMITS.rainRate[0] * 24);
  assert.ok(rain.emittedEvents <= WEATHER_CANVAS_LIMITS.rainRate[1] * 36);
  assert.ok(storm.emittedEvents >= WEATHER_CANVAS_LIMITS.stormRate[0] * 24);
  assert.ok(storm.emittedEvents <= WEATHER_CANVAS_LIMITS.stormRate[1] * 36);
  assert.ok(storm.emittedEvents > rain.emittedEvents);
  assert.ok(rain.emittedFragments > 0);
  assert.ok(storm.emittedFragments > rain.emittedFragments);
  assert.ok(storm.emittedBursts > 0);
  assert.ok(storm.emittedFlashes > 0);
  for (const variant of ['small', 'normal', 'strong']) {
    assert.ok(rain.variantCounts[variant] > 0);
    assert.ok(storm.variantCounts[variant] > 0);
  }
  assert.ok(rain.emittedFragments / rain.emittedEvents > 1);
  assert.ok(rain.emittedFragments / rain.emittedEvents < 3);
  assert.ok(storm.emittedFragments / storm.emittedEvents > rain.emittedFragments / rain.emittedEvents);
  assert.ok(rain.maxObjects <= WEATHER_CANVAS_LIMITS.impacts + WEATHER_CANVAS_LIMITS.fragments);
  assert.ok(storm.maxObjects <= WEATHER_CANVAS_LIMITS.impacts + WEATHER_CANVAS_LIMITS.fragments);
});

test('un frame usa la mask numerica SI meno entrambe le aree NO', () => {
  const { renderer, calls, scheduled } = fixture();
  renderer.setMode('rain');
  const callback = scheduled.get(renderer.state().frameId);
  scheduled.delete(renderer.state().frameId);
  callback(16);
  assert.deepEqual(calls.rects.slice(-3), [
    { x: 3.5, y: 3.5, width: 4932, height: 3091 },
    { x: 1480.5, y: 62.5, width: 889, height: 575 },
    { x: 1236.5, y: 801.5, width: 2289, height: 2293 },
  ]);
  assert.equal(calls.clips.at(-1), 'evenodd');
  assert.equal(scheduled.size, 1);
  renderer.destroy();
});

test('resize limita DPR a 2 e non accumula observer o listener', () => {
  const { renderer, canvas, calls } = fixture();
  assert.equal(canvas.width, 1864);
  assert.equal(canvas.height, 1168);
  assert.equal(renderer.state().dpr, 2);
  assert.equal(calls.observerCreates, 1);
  assert.equal(calls.observes, 1);
  for (const mode of ['rain', 'storm', 'snow', 'rain', 'fog', 'storm', 'none']) renderer.setMode(mode);
  assert.equal(calls.observerCreates, 1);
  assert.equal(calls.observes, 1);
  renderer.destroy();
  assert.equal(calls.disconnects, 1);
});
