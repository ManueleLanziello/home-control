import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlPath = new URL('../public/thermostat.html', import.meta.url);
const scriptPath = new URL('../public/js/thermostat.js', import.meta.url);

test('popup CALDAIA espone soltanto i tre week pattern consentiti', async () => {
  const html = await readFile(htmlPath, 'utf8');
  const values = [...html.matchAll(/data-week-pattern="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(values, ['5+2', '6+1', '7']);
  assert.doesNotMatch(html, /data-week-pattern="(?:0|Chiuso)"/);
});

test('frontend cambia modalita con endpoint specifico, blocca concorrenza e riallinea lo schedule confermato', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /if \(!draft \|\| saving \|\| weekPattern === draft\.weekPattern\) return/);
  assert.match(script, /\/api\/thermostat\/week-pattern/);
  assert.match(script, /draft = cloneSchedule\(result\.schedule\)/);
  assert.match(script, /button\.disabled = saving \|\| !draft/);
});

test('frontend nasconde il gruppo inattivo in 7 e invia payload schedule specifico', async () => {
  const script = await readFile(scriptPath, 'utf8');
  assert.match(script, /weekPattern === '7'.*rest: null/);
  assert.match(script, /draft\.weekPattern === '7' \? \{\} : \{ restDayPeriods: draft\.restDayPeriods \}/);
});
