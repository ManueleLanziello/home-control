export function pondPlugOwnership(value = process.env.POND_PLUG_OWNER) {
  return String(value || '').trim().toLowerCase() === 'home' ? 'home' : 'disabled';
}
export function requirePondPlugOwner(value) {
  if (pondPlugOwnership(value) !== 'home') { const error = new Error('Home-Control non è owner delle prese Pond (POND_PLUG_OWNER=home richiesto).'); error.code = 'POND_PLUG_OWNERSHIP_DISABLED'; throw error; }
}
