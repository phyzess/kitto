import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export function newerStable(candidate: string, current: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(current)) return false;
  const a = candidate.split('.').map(Number),
    b = current.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return current.includes('-');
}

export async function updateNotice(
  home: string,
  current: string,
  { fetcher = fetch, now = Date.now() }: { fetcher?: typeof fetch; now?: number } = {},
): Promise<string | undefined> {
  try {
    const path = join(home, 'update-check.json');
    let cache: { checkedAt?: number } = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') cache = parsed;
    } catch {}
    const checkedAt = cache.checkedAt;
    if (typeof checkedAt === 'number' && Number.isFinite(checkedAt) && now - checkedAt < 86_400_000 && now >= checkedAt) return;
    await mkdir(home, { recursive: true });
    await writeFile(path, JSON.stringify({ checkedAt: now }), { mode: 0o600 });
    const result = await fetcher('https://registry.npmjs.org/@phyzess%2fkitto/latest', { signal: AbortSignal.timeout(2000) });
    if (!result.ok) return;
    const metadata = await result.json();
    if (newerStable(metadata.version, current)) return `Kitto ${metadata.version} is available. Ask the Kitto skill to review the update.`;
  } catch {}
}
