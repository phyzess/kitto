import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function newerStable(candidate, current) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(current)) return false;
  const a = candidate.split('.').map(Number), b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return current.includes('-');
}

// One bounded registry request per day, only for Kitto itself. No host/plugin scan.
// Errors (including unpublished packages, offline or unwritable cache) are silent.
export async function updateNotice(home, current, { fetcher = fetch, now = Date.now() } = {}) {
  try {
    const path = join(home, 'update-check.json');
    let cache = {};
    try { cache = JSON.parse(await readFile(path, 'utf8')); } catch {}
    if (Number.isFinite(cache.checkedAt) && now - cache.checkedAt < 86_400_000 && now >= cache.checkedAt) return;
    await mkdir(home, { recursive: true });
    await writeFile(path, JSON.stringify({ checkedAt: now }), { mode: 0o600 });
    const result = await fetcher('https://registry.npmjs.org/@phyzess%2fkitto/latest', { signal: AbortSignal.timeout(2000) });
    if (!result.ok) return;
    const metadata = await result.json();
    if (newerStable(metadata.version, current)) return `Kitto ${metadata.version} is available. Ask the Kitto skill to review the update.`;
  } catch { /* Maintenance must never prevent an agent session from starting. */ }
}
