import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { State } from '../types/kitto.d.ts';
import { loadState, saveState } from './state-schema.ts';

export const stateFile = (home: string) => join(home, 'state.json');

export async function loadKittoState(home: string, { dryRun = false }: { dryRun?: boolean } = {}): Promise<State> {
  const path = stateFile(home);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const source = raw?.source;
  const piLocalDir = typeof source === 'string' ? join(source, 'config/pi/local') : undefined;
  return (await loadState(path, { dryRun, piLocalDir }))!.state;
}

export const saveKittoState = (home: string, state: State) => saveState(stateFile(home), state);
