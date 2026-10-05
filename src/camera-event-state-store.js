import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CAMERA_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const ROLES = ['C1', 'C2'];
const seconds = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number > 1e12 ? number / 1000 : number) : null;
};

export function cameraEventIdentity(clip) {
  const startTime = seconds(clip?.startTime);
  const endTime = seconds(clip?.endTime);
  if (startTime === null || endTime === null || endTime < startTime) return null;
  return `${startTime}-${endTime}-${String(clip?.vedio_type ?? '')}`;
}

const emptyCamera = () => ({ initialized: false, known: {}, unread: {}, revision: 0 });
const emptyState = () => ({ version: 1, cameras: Object.fromEntries(ROLES.map(role => [role, emptyCamera()])) });

function normalizeCamera(value) {
  const known = Object.fromEntries(Object.entries(value?.known || {}).filter(([, seenAt]) => Number.isFinite(seenAt)));
  const unread = Object.fromEntries(Object.entries(value?.unread || {}).filter(([id, seenAt]) => Object.hasOwn(known, id) && Number.isFinite(seenAt)));
  return {
    initialized: value?.initialized === true,
    known,
    unread,
    revision: Number.isInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
  };
}

function normalizeState(value) {
  return { version: 1, cameras: Object.fromEntries(ROLES.map(role => [role, normalizeCamera(value?.cameras?.[role])])) };
}

export function cameraEventSummary(camera) {
  const unreadIds = Object.keys(camera?.unread || {}).sort();
  const unreadCount = unreadIds.length;
  return { unreadCount, active: unreadCount > 0, version: unreadCount ? `${camera?.revision || 0}:${unreadIds.join('|')}` : null };
}

export class CameraEventStateStore {
  constructor({ filePath, now = Date.now, retentionMs = CAMERA_EVENT_RETENTION_MS, readState, writeState }) {
    Object.assign(this, { filePath, now, retentionMs, readState, writeState });
    this.state = null;
    this.queue = Promise.resolve();
  }

  async read() {
    if (!this.state) {
      try { this.state = normalizeState(JSON.parse(this.readState ? await this.readState() : await readFile(this.filePath, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.state = emptyState(); }
    }
    return structuredClone(this.state);
  }

  async observe(role, clips = []) {
    return this.update(role, camera => {
      const identifiers = new Set((Array.isArray(clips) ? clips : []).map(cameraEventIdentity).filter(Boolean));
      const now = this.now();
      if (!camera.initialized) {
        camera.initialized = true;
        for (const id of identifiers) camera.known[id] = now;
        camera.revision += 1;
        return;
      }
      let changed = false;
      for (const id of identifiers) {
        if (!Object.hasOwn(camera.known, id)) { camera.known[id] = now; camera.unread[id] = now; changed = true; }
        else camera.known[id] = now;
      }
      for (const [id, seenAt] of Object.entries(camera.known)) {
        if (!Object.hasOwn(camera.unread, id) && now - seenAt > this.retentionMs) { delete camera.known[id]; changed = true; }
      }
      if (changed) camera.revision += 1;
    });
  }

  async acknowledge(role) {
    return this.update(role, camera => {
      if (Object.keys(camera.unread).length) { camera.unread = {}; camera.revision += 1; }
    });
  }

  async update(role, mutate) {
    if (!ROLES.includes(role)) throw new Error('Camera non valida');
    const operation = this.queue.then(async () => {
      await this.read();
      const next = structuredClone(this.state);
      mutate(next.cameras[role]);
      this.state = normalizeState(next);
      await this.persist(this.state);
      return cameraEventSummary(this.state.cameras[role]);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async summaries() {
    const state = await this.read();
    return Object.fromEntries(ROLES.map(role => [role, cameraEventSummary(state.cameras[role]) ]));
  }

  async persist(state) {
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    if (this.writeState) return this.writeState(serialized);
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
