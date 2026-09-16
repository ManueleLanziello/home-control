import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STATIC_WEATHER_FILES, staticWeatherCondition, createStaticWeatherRenderer } from '../public/js/weather-static-renderer.js';
import { floorplanConfig } from '../public/js/floorplan-config.js';
globalThis.window = { addEventListener() {} };
const { updateFloorplanWeather, setWeatherOverlayOverride } = await import('../public/js/floorplan.js');

test('WMO statico: tutti i codici supportati e dati assenti', () => {
  for (const [state, codes] of Object.entries({ sereno: [0], nuvoloso: [1,2,3,45,48], pioggia: [51,53,55,56,57,61,63,65,66,67,80,81,82], temporale: [95,96,99], neve: [71,73,75,77,85,86], none: [null,undefined,'',100] })) {
    for (const code of codes) assert.equal(staticWeatherCondition(code), state);
  }
});

test('switching singolo, OFF, assenza asset, errori e indipendenza giorno/notte', () => {
  const original = globalThis.document;
  const stage = { children: ['base','functional'], insertBefore(node, before) { this.children.splice(this.children.indexOf(before),0,node); } };
  globalThis.document = { createElement(tag) { assert.equal(tag,'img'); return { style:{}, dataset:{}, listeners:{}, setAttribute(){}, addEventListener(name,fn){ this.listeners[name]=fn; }, remove(){ stage.children.splice(stage.children.indexOf(this),1); } }; } };
  try {
    const renderer=createStaticWeatherRenderer({stage, assets:new Set(Object.values(STATIC_WEATHER_FILES)), assetUrl:x=>x, before:'functional'});
    for (const period of ['day','night']) {
      stage.period=period;
      for (const state of ['sereno','nuvoloso','pioggia','temporale','neve','none']) {
        renderer.render(state);
        assert.equal(stage.children.length,state==='none'?2:3);
        assert.equal(stage.children[0],'base');
        assert.equal(stage.children.at(-1),'functional');
        if (state!=='none') { assert.equal(stage.children[1].src,STATIC_WEATHER_FILES[state]); assert.equal(stage.children[1].style.pointerEvents,'none'); }
      }
    }
    renderer.render('pioggia'); stage.children[1].listeners.error(); assert.equal(stage.children.length,2);
    renderer.destroy();
    const missing=createStaticWeatherRenderer({stage, assets:new Set(), assetUrl:x=>x,before:'functional'});
    missing.render('sereno'); assert.equal(stage.children.length,2);
  } finally { globalThis.document=original; }
});

test('simulatore preserva snapshot e REALE usa subito ultimo WMO', () => {
  const snapshot=Object.freeze({current:Object.freeze({weatherCode:61,temperature:20,overlayCondition:'rain'})});
  updateFloorplanWeather(snapshot);
  for (const state of ['sereno','nuvoloso','pioggia','temporale','neve','none','real']) setWeatherOverlayOverride(state);
  assert.deepEqual(snapshot,{current:{weatherCode:61,temperature:20,overlayCondition:'rain'}});
  const source=readFileSync(new URL('../public/js/floorplan.js',import.meta.url),'utf8');
  assert.match(source,/weatherOverlayOverride === 'real' \? condition : weatherOverlayOverride/);
  assert.match(source,/renderWeatherOverlay\(staticWeatherCondition\(weatherSnapshot\?\.current\?\.weatherCode\)\)/);
});

test('modalità statica senza animazioni e bounding box strutturale invariato', () => {
  const source=readFileSync(new URL('../public/js/floorplan.js',import.meta.url),'utf8');
  const init=source.slice(source.indexOf('export async function initFloorplan'));
  assert.doesNotMatch(init,/createWeatherOverlay\(|loadMapping\(config.mappings.weatherOverlay/);
  const renderer=readFileSync(new URL('../public/js/weather-static-renderer.js',import.meta.url),'utf8');
  assert.doesNotMatch(renderer,/requestAnimationFrame|setInterval|setTimeout|canvas|animation|transition/);
  const css=readFileSync(new URL('../public/floorplan.css',import.meta.url),'utf8');
  assert.match(css,/floorplan-stack-layer[^\n]*position: absolute; inset: 0; width: 100%; height: 100%/);
  assert.match(css,/weather-overlay-simulator \{ position: fixed;[^\n]*flex-wrap: nowrap/);
  for (const name of Object.values(floorplanConfig.backgrounds)) {
    const header=readFileSync(new URL('../design/'+name,import.meta.url),'utf8').match(/<svg[^>]*>/)[0];
    assert.match(header,/width="4932" height="3091"/);
  }
  assert.ok(init.indexOf('createStaticWeatherRenderer')<init.indexOf('const lightMapping'));
});
