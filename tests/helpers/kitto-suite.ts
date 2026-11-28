import assert from 'node:assert/strict';
import { callsOf } from './kitto-fixture.ts';
import type { Fixture } from './kitto-fixture.ts';

export interface ComponentRow {
  owner: string;
  tested?: boolean;
  upstream?: unknown;
  kind?: string;
  contentSha256?: string;
  profile?: string;
  name?: string;
}

export interface HostCall {
  command: string;
  args: string[];
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  assert.ok(value, `${name} must be set`);
  return value;
}

export const hostCallsOf = (f: Fixture) => callsOf(f) as HostCall[];
