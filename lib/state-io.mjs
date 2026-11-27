import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadState, saveState } from './state-schema.mjs';

export const stateFile = home => join(home, 'state.json');

export async function loadKittoState(home, { dryRun = false } = {}) {
  const path = stateFile(home);
  const raw = JSON.parse(await readFile(path, 'utf8'));
  const source = raw?.source;
  const piLocalDir = typeof source === 'string' ? join(source, 'config/pi/local') : undefined;
  return (await loadState(path, { dryRun, piLocalDir })).state;
}

export const saveKittoState = (home, state) => saveState(stateFile(home), state);
