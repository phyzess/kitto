import type { State } from '../types/kitto.js';

export interface CodexMcpOptions {
  apply?: boolean;
  run?: (args: string[], options?: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string }) => string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: string;
  save?: () => Promise<unknown>;
  log?: (...data: unknown[]) => void;
  warn?: (...data: unknown[]) => void;
  readSource?: (source: string, platform?: string, options?: { includePrivate?: boolean }) => Promise<unknown[]>;
  list?: unknown;
}

export declare function applyCodexMcp(state: State, options?: CodexMcpOptions): Promise<unknown>;
export declare function removeCodexMcp(state: State, options?: CodexMcpOptions): Promise<unknown>;
