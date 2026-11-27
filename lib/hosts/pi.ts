import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { kittoHome } from '../kitto-home.ts';
import { sameLocation } from '../paths.ts';
import { present, readJson } from '../fs-atomic.ts';
import { run as defaultRun } from '../process.ts';
import { hostAction } from './action.ts';
import { nativeCli } from './native-cli.ts';
import { syncCommand } from './pi-sync.ts';
import type { HostAction } from './action.ts';
import type { PiAdapter, State } from '../../types/kitto.d.ts';
import type { RunFunction } from '../process.ts';

export interface PiAdapterDeps {
  home?: string;
  run?: RunFunction;
  sync?: typeof syncCommand;
}

export function createPiAdapter({ home = kittoHome(), run = defaultRun, sync = syncCommand }: PiAdapterDeps = {}): PiAdapter {
  const runtime = join(home, 'runtime');
  const piEnv = (state: State) => ({ ...process.env, PI_CODING_AGENT_DIR: state.piHome });
  return {
    ...nativeCli('pi'),
    status: (state: State) => sync(state, 'status'),
    exportConfig: (state: State, apply: boolean) => sync(state, 'push', apply),
    plan: (state: State) => [
      hostAction('pi', 'pi-pull', 'bash sync.sh pull', {
        phase: 'sync',
        preview: async () => {
          sync(state, 'pull', false);
        },
        apply: async () => {
          sync(state, 'pull', true);
        },
      }),
    ],
    planConnect: (state: State) => [
      hostAction('pi', 'register-package', `pi install ${runtime}`, {
        phase: 'connect',
        apply: async () => {
          run('pi', ['install', runtime], { env: piEnv(state) });
        },
      }),
    ],
    async planDetach(state: State) {
      const actions: HostAction[] = [];
      const settings = join(state.piHome, 'settings.json');
      const data = (await present(settings)) ? await readJson(settings) : {};
      const owned = (value: string) =>
        typeof value === 'string' &&
        (value.startsWith('.') || value.startsWith('/')) &&
        sameLocation(resolve(state.piHome, value), runtime);
      if ((data.packages || []).some((entry: string | { source: string }) => owned(typeof entry === 'string' ? entry : entry.source))) {
        actions.push(
          hostAction('pi', 'unregister-package', `pi remove ${runtime}`, {
            phase: 'detach',
            apply: async () => {
              run('pi', ['remove', runtime], { env: piEnv(state) });
            },
          }),
        );
      }
      const cache = join(state.source, 'config/pi/local/packages.txt');
      if (await present(cache)) {
        actions.push(
          hostAction('pi', 'prune-package-cache', `remove Kitto runtime entries from ${cache}`, {
            phase: 'detach',
            apply: async () => {
              const before = await readFile(cache, 'utf8');
              const after = before
                .split('\n')
                .filter((line) => !owned(line.trim()))
                .join('\n');
              if (after !== before) await writeFile(cache, after);
            },
          }),
        );
      }
      return actions;
    },
  };
}
