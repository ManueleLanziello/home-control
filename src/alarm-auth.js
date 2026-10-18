import crypto from 'node:crypto';

const MAX_FAILURES = 5;
const LOCK_MS = 30_000;
const SESSION_MS = 2 * 60_000;
const text = value => typeof value === 'string' ? value : '';
const equal = (left, right) => {
  const a = Buffer.from(text(left)); const b = Buffer.from(text(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export class AlarmAuthorization {
  constructor({ password = process.env.ALARM_ADMIN_PASSWORD, now = Date.now, randomUUID = crypto.randomUUID } = {}) { this.password = text(password); this.now = now; this.randomUUID = randomUUID; this.failures = new Map(); this.sessions = new Map(); }
  key(request) { return request?.socket?.remoteAddress || 'unknown'; }
  verify(password, request) {
    const key = this.key(request); const attempt = this.failures.get(key);
    if (attempt?.lockedUntil > this.now() || !this.password || !equal(password, this.password)) {
      const count = (attempt?.count || 0) + 1;
      this.failures.set(key, { count: count >= MAX_FAILURES ? 0 : count, lockedUntil: count >= MAX_FAILURES ? this.now() + LOCK_MS : 0 });
      return false;
    }
    this.failures.delete(key); return true;
  }
  createSirenSession(password, request) { if (!this.verify(password, request)) return null; const token = this.randomUUID(); const expiresAt = this.now() + SESSION_MS; this.sessions.set(token, { scope: 'siren-config', expiresAt }); return { token, expiresAt }; }
  consumeSirenSession(token) { const value = text(token); const session = this.sessions.get(value); this.sessions.delete(value); return session?.scope === 'siren-config' && session.expiresAt > this.now(); }
  revokeSirenSession(token) { this.sessions.delete(text(token)); }
}
