export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
