import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { STATIC_WEATHER_FILES } from '../public/js/weather-static-renderer.js';

test('asset pioggia HD è statico, allineato e passivo', async () => {
  assert.equal(STATIC_WEATHER_FILES.pioggia, 'LAYER-METEO-PIOGGIA.svg');
  const url=new URL('../design/LAYER-METEO-PIOGGIA.svg',import.meta.url);
  const svg=await readFile(url,'utf8');
  assert.match(svg,/^<svg[^>]*width="4932" height="3091" viewBox="0 0 4932 3091"/);
  assert.match(svg,/pointer-events="none"/);
  assert.match(svg,/image\/png;base64/);
  assert.doesNotMatch(svg,/<(?:script|animate|animateTransform|set)\b|requestAnimationFrame|canvas|setInterval|setTimeout/i);
  assert.ok((await stat(url)).size < 8*1024*1024);
});
