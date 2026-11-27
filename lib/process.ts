import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export interface RunOptions extends Omit<SpawnSyncOptions, 'encoding'> {
  capture?: boolean;
}

export type RunFunction = (command: string, args: string[], options?: RunOptions) => string;

export function run(command: string, args: string[], { capture = false, ...options }: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    timeout: 600_000,
    ...options,
  } as SpawnSyncOptionsWithStringEncoding);
  if (result.error || result.status !== 0) {
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(
      `${command} failed: ${detail}${timedOut ? ` (gave up after ${options.timeout ?? 600_000}ms; rerun once the network is responsive)` : ''}`,
    );
  }
  return result.stdout?.trim() || '';
}
const NETWORK_GIT = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push']);
export const GIT_TIMEOUT_MS = 30_000;
export const GIT_NETWORK_TIMEOUT_MS = 300_000;
export const gitTimeoutMs = (args: string[]): number => (NETWORK_GIT.has(args[0] ?? '') ? GIT_NETWORK_TIMEOUT_MS : GIT_TIMEOUT_MS);
export const git = (source: string, args: string[]): string =>
  run('git', ['-C', source, ...args], { capture: true, timeout: gitTimeoutMs(args) });
export const available = (name: string, env: NodeJS.ProcessEnv = process.env): boolean =>
  spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000, env }).status === 0;
