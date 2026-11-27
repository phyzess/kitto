import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { present, readJson } from '../fs-atomic.mjs';
import { kittoHome } from '../kitto-home.mjs';
import { removeDshMcp, syncDshMcp } from '../mcp-sync.mjs';
import { sameLocation } from '../paths.mjs';
import { available, run as defaultRun } from '../process.mjs';
import { hostAction } from './action.mjs';
import { nativeCli } from './native-cli.mjs';

const quiet = { log: () => {}, warn: () => {} };

export function createDshWebAdapter({
  home = kittoHome(), run = defaultRun, syncMcp = syncDshMcp, removeMcp = removeDshMcp, hasPnpm = () => available('pnpm'), inspect,
} = {}) {
  const runtime = join(home, 'runtime');
  const cli = nativeCli('dsh', { capabilityArgs: { plugin: ['plugin', '--help'] } });
  const inspectCli = inspect ?? cli.inspect;
  const profileOf = state => state.dshProfile || 'web';
  return {
    ...cli,
    assertConnectable() {
      if (!hasPnpm()) throw new Error('DSH native plugin operations require pnpm on PATH. Run setup --install-agents to install the missing prerequisite.');
    },
    plan: state => [hostAction('dsh', 'sync-mcp', 'sync Kitto MCP servers into the DSH home patch', {
      phase: 'sync',
      preview: async () => { await syncMcp(state, { dryRun: true }); },
      apply: async () => { await syncMcp(state, { dryRun: false }); },
    })],
    planConnect: state => [hostAction('dsh', 'register-bundle', `dsh plugin --profile ${profileOf(state)} add ${runtime}`, {
      phase: 'connect',
      apply: async () => {
        const dsh = inspectCli();
        if (!dsh.capabilities.plugin) {
          console.warn(`kitto: this dsh CLI${dsh.actual ? ` (${dsh.actual})` : ''} has no plugin subcommand; `
            + 'skipped the Kitto bundle registration. Rules and skills were still deployed.');
          return;
        }
        await mkdir(state.dshHome, { recursive: true });
        run('dsh', ['plugin', '--profile', profileOf(state), 'add', runtime], {
          env: { ...process.env, DSH_HOME: state.dshHome, DSH_AGENTS_HOME: state.agentsHome },
        });
      },
    })],
    async planDetach(state) {
      const mcp = dryRun => ({ announce = true } = {}) => removeMcp(state, { dryRun, ...(announce ? {} : quiet) });
      let registered;
      const bundleRegistered = async () => {
        if (registered !== undefined) return registered;
        const manifest = join(state.dshHome, 'profiles', profileOf(state), 'package.json');
        if (!await present(manifest)) return registered = false;
        const profile = await readJson(manifest), dependency = profile.dependencies?.['@phyzess/kitto'];
        if (dependency && (!dependency.startsWith('link:') || !sameLocation(resolve(dirname(manifest), dependency.slice(5)), runtime))) throw new Error('DSH Kitto dependency now comes from another source. Preserved.');
        if (!dependency && !profile.dsh?.profile?.bundles?.includes('@phyzess/kitto')) return registered = false;
        if (!hasPnpm()) throw new Error('DSH native removal requires pnpm on PATH. Restore pnpm before retrying removal.');
        return registered = true;
      };
      return [
        hostAction('dsh', 'detach-mcp', 'remove Kitto-owned MCP servers from the DSH home patch', {
          phase: 'detach', preview: mcp(true), apply: mcp(false),
        }),
        hostAction('dsh', 'unregister-bundle', `dsh plugin --profile ${profileOf(state)} remove @phyzess/kitto`, {
          phase: 'detach',
          preview: async () => { await bundleRegistered(); },
          apply: async () => {
            if (!await bundleRegistered()) return;
            run('dsh', ['plugin', '--profile', profileOf(state), 'remove', '@phyzess/kitto'], { env: { ...process.env, DSH_HOME: state.dshHome } });
          },
        }),
      ];
    },
  };
}
