import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { breakStaleLocks, ownedLocks } from '../locks.ts';
import { list, record, release } from '../ownership.ts';
import { packageHash, packageKey } from '../package-key.ts';
import { piAdapter } from '../pi-adapter.ts';
import { processAlive } from '../process-alive.ts';
import type { State } from '../../types/kitto.d.ts';
import type { PiPackageSpec } from '../package-key.ts';
import type { PiCommand } from '../pi-adapter.ts';

export function breakStaleSyncLock(state: State): void {
  const lock = join(state.source, 'config/pi/local/.sync-lock');
  if (!existsSync(lock)) return;
  let pid = NaN;
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
  } catch {}
  if (processAlive(pid) !== false) return;
  rmSync(lock, { recursive: true, force: true });
  console.log(`kitto: removed stale sync lock ${lock} (pid ${pid} is no longer running).`);
}

const ownedPiPackages = (state: State) => list(state, 'pi-package', 'pi', 'owned').map((entry) => entry.spec);

export function recordPiPackages(state: State, specs: PiPackageSpec[]): void {
  const keys = new Map(specs.map((spec) => [packageKey(spec), spec]));
  for (const { name } of list(state, 'pi-package', 'pi')) if (!keys.has(name)) release(state, 'pi-package', 'pi', name);
  for (const [name, spec] of keys) if (name && name !== '__proto__') record(state, 'pi-package', 'pi', name, packageHash(spec), { spec });
}

export function syncCommand(state: State, command: PiCommand, apply = false): void {
  if (breakStaleLocks) breakStaleSyncLock(state);
  piAdapter(command, {
    source: state.source,
    piHome: state.piHome,
    agentsHome: state.agentsHome,
    dryRun: !apply && command !== 'status',
    ownedPackages: ownedPiPackages(state),
    onPackages: (specs: PiPackageSpec[]) => recordPiPackages(state, specs),
    onLock: (lock: string) => ownedLocks.add(lock),
    onUnlock: (lock: string) => ownedLocks.delete(lock),
  });
}
