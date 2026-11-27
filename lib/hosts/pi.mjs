import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { kittoHome } from '../kitto-home.mjs';
import { sameLocation } from '../paths.mjs';
import { present, readJson } from '../fs-atomic.mjs';
import { run as defaultRun } from '../process.mjs';
import { hostAction } from './action.mjs';
import { nativeCli } from './native-cli.mjs';
import { syncCommand } from './pi-sync.mjs';

export function createPiAdapter({ home = kittoHome(), run = defaultRun, sync = syncCommand } = {}) {
  const runtime = join(home, 'runtime');
  const piEnv = state => ({ ...process.env, PI_CODING_AGENT_DIR: state.piHome });
  return {
    ...nativeCli('pi'),
    status: state => sync(state, 'status'),
    exportConfig: (state, apply) => sync(state, 'push', apply),
    plan: state => [hostAction('pi', 'pi-pull', 'bash sync.sh pull', {
      phase: 'sync',
      preview: async () => { sync(state, 'pull', false); },
      apply: async () => { sync(state, 'pull', true); },
    })],
    planConnect: state => [hostAction('pi', 'register-package', `pi install ${runtime}`, {
      phase: 'connect',
      apply: async () => { run('pi', ['install', runtime], { env: piEnv(state) }); },
    })],
    async planDetach(state) {
      const actions = [];
      const settings = join(state.piHome, 'settings.json');
      const data = await present(settings) ? await readJson(settings) : {};
      const owned = value => typeof value === 'string' && (value.startsWith('.') || value.startsWith('/')) && sameLocation(resolve(state.piHome, value), runtime);
      if ((data.packages || []).some(entry => owned(typeof entry === 'string' ? entry : entry.source))) {
        actions.push(hostAction('pi', 'unregister-package', `pi remove ${runtime}`, {
          phase: 'detach',
          apply: async () => { run('pi', ['remove', runtime], { env: piEnv(state) }); },
        }));
      }
      const cache = join(state.source, 'config/pi/local/packages.txt');
      if (await present(cache)) {
        actions.push(hostAction('pi', 'prune-package-cache', `remove Kitto runtime entries from ${cache}`, {
          phase: 'detach',
          apply: async () => {
            const before = await readFile(cache, 'utf8');
            const after = before.split('\n').filter(line => !owned(line.trim())).join('\n');
            if (after !== before) await writeFile(cache, after);
          },
        }));
      }
      return actions;
    },
  };
}
