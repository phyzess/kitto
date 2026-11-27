import { spawnSync, type SpawnSyncOptions, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

export interface RunOptions extends Omit<SpawnSyncOptions, 'encoding'> {
  capture?: boolean;
}

export type RunFunction = (command: string, args: string[], options?: RunOptions) => string;

export function run(command: string, args: string[], { capture = false, ...options }: RunOptions = {}): string {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 600_000, ...options } as SpawnSyncOptionsWithStringEncoding);
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout?.trim() || '';
}
export const git = (source: string, args: string[]): string => run('git', ['-C', source, ...args], { capture: true, timeout: 30_000 });
export const available = (name: string, env: NodeJS.ProcessEnv = process.env): boolean => spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 8000, env }).status === 0;
