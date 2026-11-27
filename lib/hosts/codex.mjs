import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { applyCodexMcp, removeCodexMcp } from '../codex-mcp.mjs';
import { atomicJson, present } from '../fs-atomic.mjs';
import { kittoHome } from '../kitto-home.mjs';
import { sameLocation } from '../paths.mjs';
import { run as defaultRun } from '../process.mjs';
import { hostAction } from './action.mjs';
import { nativeCli } from './native-cli.mjs';

const quiet = { log: () => {}, warn: () => {} };
const marketplaceName = 'phyzess-kitto';
const pluginId = 'kitto@phyzess-kitto';

export function createCodexAdapter({ home = kittoHome(), run = defaultRun, syncMcp = applyCodexMcp, removeMcp = removeCodexMcp, inspect = undefined } = {}) {
  const runtime = join(home, 'runtime');
  const statePath = join(home, 'state.json');
  const cli = nativeCli('codex', {
    scratchHomeVariable: 'CODEX_HOME',
    capabilityArgs: { plugin: ['plugin', 'add', '--help'], mcp: ['mcp', '--help'] },
  });
  const inspectCli = inspect ?? cli.inspect;
  const marketplace = join(home, '.agents/plugins/marketplace.json');
  return {
    ...cli,
    plan: state => [hostAction('codex', 'sync-mcp', 'sync Kitto MCP servers into the Codex config', {
      phase: 'post-skills',
      apply: async () => { await syncMcp(state, { save: () => atomicJson(statePath, state) }); },
    })],
    planConnect: state => [hostAction('codex', 'register-plugin', [
      `write ${marketplace}`,
      `codex plugin marketplace add ${home}`,
      `codex plugin add ${pluginId}`,
    ].join('\n'), {
      phase: 'connect',
      apply: async () => {
        if (!inspectCli().capabilities.plugin) {
          console.warn('kitto: this codex CLI has no plugin subcommand; skipped the Kitto plugin registration. '
            + 'Rules, skills and MCP were still deployed.');
          return;
        }
        await mkdir(state.codexHome, { recursive: true });
        await atomicJson(marketplace, { name: marketplaceName, plugins: [{ name: 'kitto',
          source: { source: 'local', path: './runtime/integration' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
        const env = { ...process.env, CODEX_HOME: state.codexHome };
        run('codex', ['plugin', 'marketplace', 'add', home], { env });
        run('codex', ['plugin', 'add', pluginId], { env });
      },
    })],
    async planDetach(state) {
      if (!await present(state.codexHome)) return [];
      const env = { ...process.env, CODEX_HOME: state.codexHome };
      const markets = JSON.parse(run('codex', ['plugin', 'marketplace', 'list', '--json'], { env, capture: true }));
      const market = markets.marketplaces.find(item => item.name === marketplaceName);
      if (market && !sameLocation(market.root, home)) throw new Error('The phyzess-kitto marketplace now belongs to another location. Preserved.');
      const plugins = JSON.parse(run('codex', ['plugin', 'list', '--json'], { env, capture: true }));
      if (plugins.installed.some(item => item.marketplaceName === marketplaceName && item.pluginId !== pluginId)) {
        throw new Error('The Kitto marketplace contains other installed plugins. Preserved; detach them or move them to their own marketplace first.');
      }
      const plugin = plugins.installed.find(item => item.pluginId === pluginId);
      if (plugin && (plugin.source?.source !== 'local' || !sameLocation(plugin.source.path, join(runtime, 'integration')))) {
        throw new Error('The Codex Kitto plugin now comes from another source. Preserved.');
      }
      const mcp = apply => ({ announce = true } = {}) => removeMcp(state, {
        apply, env, save: () => atomicJson(statePath, state), ...(announce ? {} : quiet),
      });
      const actions = [hostAction('codex', 'detach-mcp', 'remove Kitto-owned MCP servers from the Codex config', {
        phase: 'detach', preview: mcp(false), apply: mcp(true),
      })];
      if (plugin) {
        actions.push(hostAction('codex', 'unregister-plugin', `codex plugin remove ${pluginId}`, {
          phase: 'detach', apply: async () => { run('codex', ['plugin', 'remove', pluginId], { env }); },
        }));
      }
      if (market) {
        actions.push(hostAction('codex', 'unregister-marketplace', `codex plugin marketplace remove ${marketplaceName}`, {
          phase: 'detach', apply: async () => { run('codex', ['plugin', 'marketplace', 'remove', marketplaceName], { env }); },
        }));
      }
      return actions;
    },
  };
}
