import type { State } from '../types/kitto.d.ts';

export type StateHomeKey = 'piHome' | 'codexHome' | 'dshHome' | 'agentsHome';

export function stateHome(state: State, key: StateHomeKey): string {
  const value = state[key];
  if (typeof value !== 'string' || !value) throw new Error(`Kitto state has no ${key}; run kitto setup to resolve it.`);
  return value;
}
