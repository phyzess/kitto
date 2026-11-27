import type { State } from '../types/kitto.js';

export interface McpRemoval {
  changed?: boolean;
  path?: string;
  removed?: unknown[];
  [key: string]: unknown;
}

export interface McpSyncOptions {
  dryRun?: boolean;
  yaml?: unknown;
  log?: (...data: unknown[]) => void;
  warn?: (...data: unknown[]) => void;
  includePrivate?: boolean;
}

export declare function syncDshMcp(state: State, options?: McpSyncOptions): Promise<McpRemoval>;
export declare function removeDshMcp(state: State, options?: Omit<McpSyncOptions, 'includePrivate'>): Promise<McpRemoval>;
