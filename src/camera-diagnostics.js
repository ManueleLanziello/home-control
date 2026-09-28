// Temporary observation only: never log hardware payloads or error messages/secrets.
export function cameraDiagnostic(role, startedAt, phase, outcome = 'OK') {
  const at = performance.timeOrigin + performance.now();
  try { console.error(`[CAM-DIAG] ${role} ${new Date(at).toISOString()} +${((at - startedAt) / 1000).toFixed(3)}s ${phase} ${outcome}`); } catch {}
}
export function cameraDiagnosticStart() { return performance.timeOrigin + performance.now(); }
