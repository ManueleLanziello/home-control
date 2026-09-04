import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DeviceRoleStore } from './src/device-roles.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from './src/hardware-registry.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const ENV_FILE = path.join(ROOT, '.env');
if (existsSync(ENV_FILE)) loadEnvFile(ENV_FILE);
const PORT = Number(process.env.HOME_CONTROL_PORT || process.env.PORT || 3001);
const HOST = process.env.HOME_CONTROL_HOST || '0.0.0.0';
const HARDWARE_FILE = path.join(ROOT, 'data', 'config', 'hardware.json');
const ROLE_FILE = path.join(ROOT, 'data', 'config', 'device-roles.json');

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/settings', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.html', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/pwa.js', ['pwa.js', 'text/javascript; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icons/home-control.svg', ['icons/home-control.svg', 'image/svg+xml']],
]);

async function serveStatic(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;

  const [fileName, contentType] = entry;
  try {
    const content = await readFile(path.join(PUBLIC_ROOT, fileName));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Risorsa non trovata');
  }
  return true;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

export function createHomeControlServer({
  hardwareStore = new HardwareRegistryStore({ filePath: HARDWARE_FILE, defaults: defaultHardwareRegistry() }),
  roleStore = new DeviceRoleStore({ filePath: ROLE_FILE }),
} = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/hardware') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const registry = await hardwareStore.read();
      const assignments = await roleStore.read(registry.devices.map((device) => device.id));
      return sendJson(response, 200, {
        version: registry.version,
        devices: registry.devices.map((device) => ({
          ...device,
          role: assignments[device.id] || 'none',
          runtimeActive: false,
          online: false,
          state: null,
          rssi: null,
        })),
        roles: assignments,
      });
    }
    if (url.pathname === '/api/device-roles') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const registry = await hardwareStore.read();
      return sendJson(response, 200, {
        validRoles: [],
        assignments: await roleStore.read(registry.devices.map((device) => device.id)),
      });
    }
    if (await serveStatic(response, url.pathname)) return;

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Pagina non trovata');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createHomeControlServer();
  server.listen(PORT, HOST, () => {
    console.log(`Home Control disponibile su http://${HOST}:${PORT}`);
  });
}
