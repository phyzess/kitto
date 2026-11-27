import { spawnSync } from 'node:child_process';

export function run(command, args, { capture = false, ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 600_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}
export const git = (source, args) => run('git', ['-C', source, ...args], { capture: true, timeout: 30_000 });
export const available = (name, env = process.env) => spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000, env }).status === 0;
