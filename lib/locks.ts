import { rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { processAlive } from './process-alive.ts';

export let breakStaleLocks = false;
export function allowStaleLockBreak(value = true) { breakStaleLocks = value; }

export const ownedLocks = new Set();
let lockSignalsBound = false;

function lockOwnerRecord() {
  return { pid: process.pid, host: hostname(), startedAt: new Date().toISOString(),
    command: process.argv.slice(2).join(' ').slice(0, 200) };
}

async function readLockOwner(lock) {
  try { return JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); }
  catch { return undefined; }
}

function lockMessage(lock, owner, stale) {
  if (!owner) {
    return `${lock} exists without an owner record (an older Kitto, or a directory someone created by hand). `
      + 'Verify no Kitto process is running, then delete that directory.';
  }
  const who = `pid ${owner.pid}${owner.startedAt ? ` started ${owner.startedAt}` : ''}${owner.command ? ` (${owner.command})` : ''}`;
  return stale
    ? `${lock} is a stale lock: ${who} is no longer running. Rerun with --break-lock to remove it, or delete that directory.`
    : `Another Kitto operation holds ${lock}: ${who}. Wait for it to finish.`;
}

function bindLockSignals() {
  if (lockSignalsBound) return;
  lockSignalsBound = true;
  for (const [signal, code] of new Map([['SIGINT', 130], ['SIGTERM', 143]])) {
    process.once(signal, () => {
      for (const lock of ownedLocks) { try { rmSync(lock, { recursive: true, force: true }); } catch {} }
      process.exit(code);
    });
  }
}

async function acquireLock(home) {
  await mkdir(home, { recursive: true });
  const lock = join(home, '.lock');
  bindLockSignals();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner.json'), JSON.stringify(lockOwnerRecord(), null, 1) + '\n', { mode: 0o600 });
      ownedLocks.add(lock);
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readLockOwner(lock);
      const stale = owner ? processAlive(owner.pid) === false : false;
      if (stale && breakStaleLocks) {
        await rm(lock, { recursive: true, force: true });
        console.log(`kitto: removed stale lock ${lock} (pid ${owner.pid} is no longer running).`);
        continue;
      }
      throw new Error(lockMessage(lock, owner, stale));
    }
  }
  throw new Error(`Cannot acquire ${join(home, '.lock')}: a stale lock reappeared after it was cleared.`);
}

export async function locked(home, callback) {
  const lock = await acquireLock(home);
  try { return await callback(); } finally {
    ownedLocks.delete(lock);
    await rm(lock, { recursive: true, force: true });
  }
}
