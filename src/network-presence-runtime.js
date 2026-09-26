import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const PRESENCE_CACHE_MS = 30_000;
export const PRESENCE_FAILURE_THRESHOLD = 2;
export const PRESENCE_TIMEOUT_MS = 1_500;

async function probeIcmp({ ip, timeoutMs }) {
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', String(timeoutMs), ip]
    : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1_000))), ip];
  try {
    await execFileAsync('ping', args, { windowsHide: true, timeout: timeoutMs + 500 });
    return true;
  } catch { return false; }
}

export function normalizeMac(value) {
  const compact = String(value || '').trim().replaceAll('-', '').replaceAll(':', '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(compact) ? compact.match(/.{2}/g).join(':') : null;
}

export async function readArpMac(ip) {
  try {
    const { stdout } = await execFileAsync('arp', ['-a', ip], { windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024 });
    const escapedIp = String(ip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = String(stdout).split(/\r?\n/).find(value => new RegExp(`(^|\\s)${escapedIp}(\\s|$)`).test(value));
    return normalizeMac(line?.match(/(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i)?.[0]);
  } catch { return null; }
}

function localInterfaceForIp(ip, networkInterfaces) {
  return Object.values(networkInterfaces()).flat().find(entry => entry?.family === 'IPv4' && entry.address === ip) || null;
}

function probeTcp({ ip, port, timeoutMs }) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    const finish = online => { socket.destroy(); resolve(online); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function probeNetworkPresence(item) {
  const presence = item?.presence;
  const ip = item?.network?.ipv4;
  if (!ip || !presence) return null;
  const timeoutMs = presence.timeoutMs ?? PRESENCE_TIMEOUT_MS;
  if (presence.method === 'icmp') return probeIcmp({ ip, timeoutMs });
  if (presence.method === 'tcp') return probeTcp({ ip, port: presence.port, timeoutMs });
  return null;
}

export class NetworkPresenceRuntime {
  constructor({ now = Date.now, probe = probeNetworkPresence, readNeighbor = readArpMac, networkInterfaces = os.networkInterfaces, cacheMs = PRESENCE_CACHE_MS, failureThreshold = PRESENCE_FAILURE_THRESHOLD } = {}) {
    Object.assign(this, { now, probe, readNeighbor, networkInterfaces, cacheMs, failureThreshold });
    this.cache = new Map();
    this.pending = new Map();
  }

  key(item) {
    return `${item.marker}:${item.network?.ipv4 || ''}:${item.presence?.method || ''}:${item.presence?.port || ''}`;
  }

  async read(item) {
    if (item?.presenceEnabled !== true || !item.presence?.method || !item.network?.ipv4) return null;
    const key = this.key(item);
    const cached = this.cache.get(key);
    if (cached && this.now() < cached.expiresAt) return cached.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const pending = Promise.resolve(this.probe(item)).then(async reachable => {
      const previous = this.cache.get(key)?.value;
      const threshold = item.presence.failureThreshold ?? this.failureThreshold;
      if (reachable === true) {
        const expectedMac = normalizeMac(item.identity?.mac);
        let observedMac = null;
        const localInterface = localInterfaceForIp(item.network.ipv4, this.networkInterfaces);
        if (localInterface) observedMac = normalizeMac(localInterface.mac);
        else {
          try { observedMac = normalizeMac(await this.readNeighbor(item.network.ipv4)); } catch { /* An unreadable ARP entry cannot confirm identity. */ }
        }
        if (expectedMac && observedMac === expectedMac) {
          const value = { online: true, failures: 0, checkedAt: new Date(this.now()).toISOString(), mac: observedMac, identity: localInterface ? 'local' : 'arp' };
          this.cache.set(key, { value, expiresAt: this.now() + this.cacheMs });
          return value;
        }
        // An IP occupied by another device must never inherit the prior green state.
        const value = { online: false, failures: (previous?.failures || 0) + 1, checkedAt: new Date(this.now()).toISOString(), mac: observedMac, identity: observedMac ? 'mismatch' : 'missing' };
        this.cache.set(key, { value, expiresAt: this.now() + this.cacheMs });
        return value;
      }
      const failures = (previous?.failures || 0) + 1;
      const value = {
        online: failures >= threshold ? false : previous?.online === true ? true : null,
        failures,
        checkedAt: new Date(this.now()).toISOString(),
        identity: 'probe_failed',
      };
      this.cache.set(key, { value, expiresAt: this.now() + this.cacheMs });
      return value;
    }, () => {
      const previous = this.cache.get(key)?.value;
      const failures = (previous?.failures || 0) + 1;
      const threshold = item.presence.failureThreshold ?? this.failureThreshold;
      const value = { online: failures >= threshold ? false : previous?.online === true ? true : null, failures, checkedAt: new Date(this.now()).toISOString() };
      this.cache.set(key, { value, expiresAt: this.now() + this.cacheMs });
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, pending);
    return pending;
  }

  async readInventory(inventory = []) {
    const entries = await Promise.all(inventory.map(async item => [item.marker, await this.read(item)]));
    return Object.fromEntries(entries.filter(([, value]) => value));
  }
}
