import type { SpawnSyncOptions } from 'node:child_process';

export interface RunOptions extends SpawnSyncOptions {
  capture?: boolean;
}

export declare function run(command: string, args: string[], options?: RunOptions): string;
export declare function git(source: string, args: string[]): string;
export declare function available(name: string, env?: NodeJS.ProcessEnv): boolean;
