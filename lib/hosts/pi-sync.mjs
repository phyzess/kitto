import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { breakStaleLocks, processAlive } from '../locks.mjs';
import { kittoHome } from '../kitto-home.mjs';
import { run } from '../process.mjs';

export function breakStaleSyncLock(state) {
  const lock = join(state.source, 'config/pi/local/.sync-lock');
  if (!existsSync(lock)) return;
  let pid = NaN;
  try { pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim()); } catch {}
  if (processAlive(pid) !== false) return;
  rmSync(lock, { recursive: true, force: true });
  console.log(`kitto: removed stale sync lock ${lock} (pid ${pid} is no longer running).`);
}

export function probeTool(name, args = ['--version'], timeout = 8000) {
  const result = spawnSync(name, args, { stdio: 'ignore', timeout });
  if (result.error?.code === 'ENOENT') return 'missing';
  if (result.error?.code === 'ETIMEDOUT') return 'slow';
  if (result.error) return 'failed';
  return result.status === 0 ? 'ok' : 'failed';
}

export function slowPythonNotice() {
  console.warn('kitto: python3 did not answer within 8s; continuing. A version-manager shim (pyenv, asdf, mise) can be slow on its '
    + 'first run, and the sync step reports the real result.');
}

export function checkPiTools() {
  if (probeTool('bash') === 'missing') throw new Error('Pi configuration requires bash on PATH.');
  const present = probeTool('python3');
  if (present === 'missing') throw new Error('Pi configuration requires python3 on PATH.');
  if (present === 'failed') throw new Error('python3 is on PATH but cannot run; the Pi adapter needs Python >=3.10.');
  if (present === 'slow') return slowPythonNotice();
  const supported = probeTool('python3', ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 3)']);
  if (supported === 'slow') return slowPythonNotice();
  if (supported !== 'ok') throw new Error('The Pi adapter needs Python >=3.10; upgrade the python3 on PATH.');
}

export function syncCommand(state, command, apply = false, codeRoot = join(kittoHome(), 'runtime')) {
  if (breakStaleLocks) breakStaleSyncLock(state);
  checkPiTools();
  return run('bash', [join(codeRoot, 'sync.sh'), command, ...(!apply && command !== 'status' ? ['--dry-run'] : [])], {
    env: { ...process.env, KITTO_CONFIG_ROOT: state.source, KITTO_SHARED_SKILLS_MANAGED: '1',
      PI_CODING_AGENT_DIR: state.piHome, PI_AGENTS_DIR: state.agentsHome },
  });
}
