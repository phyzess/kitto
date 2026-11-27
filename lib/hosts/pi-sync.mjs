import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { breakStaleLocks, ownedLocks } from '../locks.mjs';
import { piAdapter } from '../pi-adapter.mjs';
import { processAlive } from '../process-alive.mjs';

export function breakStaleSyncLock(state) {
  const lock = join(state.source, 'config/pi/local/.sync-lock');
  if (!existsSync(lock)) return;
  let pid = NaN;
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim()); } catch {}
  if (processAlive(pid) !== false) return;
  rmSync(lock, { recursive: true, force: true });
  console.log(`kitto: removed stale sync lock ${lock} (pid ${pid} is no longer running).`);
}

export function syncCommand(state, command, apply = false) {
  if (breakStaleLocks) breakStaleSyncLock(state);
  piAdapter(command, {
    source: state.source, piHome: state.piHome, agentsHome: state.agentsHome,
    dryRun: !apply && command !== 'status',
    onLock: lock => ownedLocks.add(lock), onUnlock: lock => ownedLocks.delete(lock),
  });
}
