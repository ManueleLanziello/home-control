import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { homeControlBasePath, homeControlPath } from '../public/base-path.js';

test('resolves root and prefixed Home Control paths', () => {
  assert.equal(homeControlBasePath('/'), '');
  assert.equal(homeControlBasePath('/settings'), '');
  assert.equal(homeControlBasePath('/home/'), '/home');
  assert.equal(homeControlBasePath('/home/settings'), '/home');
  assert.equal(homeControlPath('/api/thermostat', '/'), '/api/thermostat');
  assert.equal(homeControlPath('/api/thermostat', '/home/'), '/home/api/thermostat');
});

test('declares the prefixed PWA identity', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.deepEqual(
    { id: manifest.id, start_url: manifest.start_url, scope: manifest.scope },
    { id: '/home/', start_url: '/home/', scope: '/home/' },
  );
});
