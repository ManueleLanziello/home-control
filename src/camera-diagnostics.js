import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const logFile = fileURLToPath(new URL('../data/camera-diagnostics.log', import.meta.url));

export function createCameraDiagnosticWriter(filePath = logFile, output = line => console.error(line)) {
  let pending = Promise.resolve();
  return line => {
    try { output(line); } catch {}
    // Serialize appends without awaiting disk I/O in any camera operation.
    pending = pending.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await appendFile(filePath, `${line}\n`, 'utf8');
    }).catch(() => {}); // Logging failures must never escape into camera/server logic.
    return pending;
  };
}

export const writeCameraDiagnostic = createCameraDiagnosticWriter();

// Temporary observation only: never log hardware payloads or error messages/secrets.
export function cameraDiagnostic(role, startedAt, phase, outcome = 'OK') {
  const at = performance.timeOrigin + performance.now();
  writeCameraDiagnostic(`[CAM-DIAG] ${role} ${new Date(at).toISOString()} +${((at - startedAt) / 1000).toFixed(3)}s ${phase} ${outcome}`);
}
export function cameraDiagnosticStart() { return performance.timeOrigin + performance.now(); }
