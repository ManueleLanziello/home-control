import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { DeviceRoleStore } from './src/device-roles.js';
import { HardwareRegistryStore, defaultHardwareRegistry } from './src/hardware-registry.js';
import { createHomeWt200Runtime } from './src/wt200-runtime.js';
import { HomeStatusRuntime, HOME_ROLES } from './src/home-status.js';

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
  ['/thermostat', ['thermostat.html', 'text/html; charset=utf-8']],
  ['/thermostat.html', ['thermostat.html', 'text/html; charset=utf-8']],
  ['/settings', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.html', ['settings.html', 'text/html; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/base-path.js', ['base-path.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/floorplan.css', ['floorplan.css', 'text/css; charset=utf-8']],
  ['/js/light-sound.js', ['js/light-sound.js', 'text/javascript; charset=utf-8']],
  ['/sounds/switch.ogg', ['sounds/switch.ogg', 'audio/ogg']],
  ['/js/floorplan.js', ['js/floorplan.js', 'text/javascript; charset=utf-8']],
  ['/js/floorplan-config.js', ['js/floorplan-config.js', 'text/javascript; charset=utf-8']],
  ['/js/floorplan-state.js', ['js/floorplan-state.js', 'text/javascript; charset=utf-8']],
  ['/js/dashboard.js', ['js/dashboard.js', 'text/javascript; charset=utf-8']],
  ['/js/boiler-schedule.js', ['js/boiler-schedule.js', 'text/javascript; charset=utf-8']],
  ['/js/thermostat.js', ['js/thermostat.js', 'text/javascript; charset=utf-8']],
  ['/assets/floorplan/neon-floorplan.svg', ['assets/floorplan/neon-floorplan.svg', 'image/svg+xml']],
  ['/design/LAYER-00.svg', ['../design/LAYER-00.svg', 'image/svg+xml']],
  ['/design/LAYER-01.svg', ['../design/LAYER-01.svg', 'image/svg+xml']],
  ['/pwa.js', ['pwa.js', 'text/javascript; charset=utf-8']],
  ['/service-worker.js', ['service-worker.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/icons/home-control.svg', ['icons/home-control.svg', 'image/svg+xml']],
]);

async function serveStatic(response, pathname) {
  const designName = /^\/design\/([a-zA-Z0-9_-]+\.svg)$/.exec(pathname)?.[1];
  const entry = designName ? [`../design/${designName}`, 'image/svg+xml'] : STATIC_FILES.get(pathname);
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
  } catch (error) {
    if (pathname === '/sounds/switch.ogg' && error.code === 'ENOENT') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return true;
    }
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

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  try { return JSON.parse(body); } catch { return null; }
}

function isSchedulePayload(value) {
  const validPeriod = (period) => Number.isInteger(period?.hour) && Number.isInteger(period?.minute) && Number.isFinite(period?.temperature);
  return value && Array.isArray(value.normalPeriods) && value.normalPeriods.length === 6
    && Array.isArray(value.restDayPeriods) && value.restDayPeriods.length === 2
    && value.normalPeriods.every(validPeriod) && value.restDayPeriods.every(validPeriod);
}

export function createHomeControlServer({
  hardwareStore = new HardwareRegistryStore({ filePath: HARDWARE_FILE, defaults: defaultHardwareRegistry() }),
  roleStore = new DeviceRoleStore({ filePath: ROLE_FILE }),
  thermostatRuntime = null,
  createSensorRuntime,
} = {}) {
  let activeThermostatRuntime = thermostatRuntime;
  const homeStatus = new HomeStatusRuntime({ hardwareStore, roleStore, createSensorRuntime,
    // Retain the existing WT200 configuration path; never use its env ID for Dewin roles.
    readThermostat: () => {
      activeThermostatRuntime ||= createHomeWt200Runtime({
        clientId: process.env.TUYA_CLIENT_ID, clientSecret: process.env.TUYA_CLIENT_SECRET,
        deviceId: process.env.TUYA_DEVICE_ID, lanIp: process.env.WT200_LAN_IP, localKey: process.env.WT200_LOCAL_KEY,
      });
      return activeThermostatRuntime.readSnapshot();
    },
  });

  return http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/api/home/status') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Metodo non consentito' });
      try { return sendJson(response, 200, await homeStatus.readSnapshot()); }
      catch { return sendJson(response, 503, { error: 'Stato casa non disponibile' }); }
    }
    if (url.pathname === '/api/floorplan/assets') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const entries = await readdir(path.join(ROOT, 'design'), { withFileTypes: true }).catch(() => []);
      return sendJson(response, 200, { assets: entries.filter(entry => entry.isFile() && /^[a-zA-Z0-9_-]+\.svg$/.test(entry.name)).map(entry => entry.name) });
    }
    if (url.pathname === '/api/thermostat') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Metodo non consentito' });
      try {
        return sendJson(response, 200, (await homeStatus.readSnapshot()).thermostat);
      } catch {
        return sendJson(response, 503, { error: 'Termostato non disponibile' });
      }
    }
    if (url.pathname === '/api/thermostat/schedule') {
      if (request.method !== 'PUT') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const payload = await readJson(request);
      if (!isSchedulePayload(payload)) return sendJson(response, 400, { error: 'Programmazione non valida' });
      try {
        activeThermostatRuntime ||= createHomeWt200Runtime({
          clientId: process.env.TUYA_CLIENT_ID, clientSecret: process.env.TUYA_CLIENT_SECRET,
          deviceId: process.env.TUYA_DEVICE_ID, lanIp: process.env.WT200_LAN_IP, localKey: process.env.WT200_LOCAL_KEY,
        });
        homeStatus.invalidate();
        return sendJson(response, 200, { schedule: await activeThermostatRuntime.updateSchedule(payload) });
      } catch (error) {
        if (error?.code === 'SCHEDULE_UNAVAILABLE') return sendJson(response, 409, { error: error.message });
        if (error?.code === 'LAN_UNAVAILABLE') return sendJson(response, 503, { error: error.message });
        if (error?.code === 'SCHEDULE_INVALID') return sendJson(response, 400, { error: 'Programmazione non valida' });
        return sendJson(response, 503, { error: 'Programmazione WT200 non disponibile' });
      }
    }
    if (url.pathname === '/api/thermostat/mode') {
      if (request.method !== 'PUT') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const payload = await readJson(request);
      if (!['manual', 'auto'].includes(payload?.mode)) return sendJson(response, 400, { error: 'Modalita non valida' });
      try {
        activeThermostatRuntime ||= createHomeWt200Runtime({ clientId: process.env.TUYA_CLIENT_ID, clientSecret: process.env.TUYA_CLIENT_SECRET, deviceId: process.env.TUYA_DEVICE_ID, lanIp: process.env.WT200_LAN_IP, localKey: process.env.WT200_LOCAL_KEY });
        homeStatus.invalidate();
        return sendJson(response, 200, { mode: await activeThermostatRuntime.setMode(payload.mode) });
      } catch (error) {
        if (error?.code === 'MODE_INVALID') return sendJson(response, 400, { error: error.message });
        if (error?.code === 'LAN_UNAVAILABLE') return sendJson(response, 503, { error: error.message });
        return sendJson(response, 503, { error: 'Modalita WT200 non disponibile' });
      }
    }
    if (url.pathname === '/api/thermostat/setpoint') {
      if (request.method !== 'PUT') return sendJson(response, 405, { error: 'Metodo non consentito' });
      const payload = await readJson(request);
      const raw = Number(payload?.temperature) * 10;
      if (!Number.isFinite(payload?.temperature) || payload.temperature < 0 || payload.temperature > 30 || !Number.isInteger(raw) || raw % 5 !== 0) return sendJson(response, 400, { error: 'Setpoint non valido' });
      try {
        activeThermostatRuntime ||= createHomeWt200Runtime({ clientId: process.env.TUYA_CLIENT_ID, clientSecret: process.env.TUYA_CLIENT_SECRET, deviceId: process.env.TUYA_DEVICE_ID, lanIp: process.env.WT200_LAN_IP, localKey: process.env.WT200_LOCAL_KEY });
        homeStatus.invalidate();
        return sendJson(response, 200, { temperature: await activeThermostatRuntime.setSetpointTemperature(payload.temperature) });
      } catch (error) {
        if (error?.code === 'SETPOINT_INVALID') return sendJson(response, 400, { error: error.message });
        return sendJson(response, 503, { error: 'Setpoint WT200 non disponibile' });
      }
    }
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
        validRoles: Object.values(HOME_ROLES),
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
