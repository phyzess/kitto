import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { present, readJson } from '../fs-atomic.ts';
import { kittoHome } from '../kitto-home.ts';
import { removeDshMcp, syncDshMcp } from '../mcp-sync.ts';
import { sameLocation } from '../paths.ts';
import { available, run as defaultRun } from '../process.ts';
import { hostAction } from './action.ts';
import { nativeCli } from './native-cli.ts';
import type { HostAction, PreviewOptions } from './action.ts';
import type { HostAdapter, HostReport, State } from '../../types/kitto.d.ts';
import type { RunFunction } from '../process.ts';
import { stateHome } from '../state-homes.ts';

export interface DshWebAdapterDeps {
  home?: string;
  run?: RunFunction;
  syncMcp?: typeof syncDshMcp;
  removeMcp?: typeof removeDshMcp;
  hasPnpm?: () => boolean;
  inspect?: () => HostReport;
}

const quiet = { log: () => {}, warn: () => {} };

export function createDshWebAdapter({
  home = kittoHome(),
  run = defaultRun,
  syncMcp = syncDshMcp,
  removeMcp = removeDshMcp,
  hasPnpm = () => available('pnpm'),
  inspect = undefined,
}: DshWebAdapterDeps = {}): HostAdapter {
  const runtime = join(home, 'runtime');
  const cli = nativeCli('dsh', { capabilityArgs: { plugin: ['plugin', '--help'] } });
  const inspectCli = inspect ?? cli.inspect;
  const profileOf = (state: State) => state.dshProfile || 'web';
  return {
    ...cli,
    assertConnectable() {
      if (!hasPnpm())
        throw new Error(
          'DSH native plugin operations require pnpm on PATH. Run setup --install-agents to install the missing prerequisite.',
        );
    },
    plan: (state: State) => [
      hostAction('dsh', 'sync-mcp', 'sync Kitto MCP servers into the DSH home patch', {
        phase: 'sync',
        preview: async () => {
          await syncMcp(state, { dryRun: true });
        },
        apply: async () => {
          await syncMcp(state, { dryRun: false });
        },
      }),
    ],
    planConnect: (state: State) => [
      hostAction('dsh', 'register-bundle', `dsh plugin --profile ${profileOf(state)} add ${runtime}`, {
        phase: 'connect',
        apply: async () => {
          const dsh = inspectCli();
          if (!dsh.capabilities.plugin) {
            console.warn(
              `kitto: this dsh CLI${dsh.actual ? ` (${dsh.actual})` : ''} has no plugin subcommand; ` +
                'skipped the Kitto bundle registration. Rules and skills were still deployed.',
            );
            return;
          }
          await mkdir(stateHome(state, 'dshHome'), { recursive: true });
          run('dsh', ['plugin', '--profile', profileOf(state), 'add', runtime], {
            env: { ...process.env, DSH_HOME: state.dshHome, DSH_AGENTS_HOME: state.agentsHome },
          });
        },
      }),
    ],
    async planDetach(state: State): Promise<HostAction[]> {
      const mcp =
        (dryRun: boolean) =>
        ({ announce = true }: PreviewOptions = {}) =>
          removeMcp(state, { dryRun, ...(announce ? {} : quiet) });
      let registered: boolean | undefined;
      const bundleRegistered = async (): Promise<boolean> => {
        if (registered !== undefined) return registered;
        const manifest = join(stateHome(state, 'dshHome'), 'profiles', profileOf(state), 'package.json');
        if (!(await present(manifest))) return (registered = false);
        const profile = await readJson(manifest),
          dependency = profile.dependencies?.['@phyzess/kitto'];
        if (dependency && (!dependency.startsWith('link:') || !sameLocation(resolve(dirname(manifest), dependency.slice(5)), runtime)))
          throw new Error('DSH Kitto dependency now comes from another source. Preserved.');
        if (!dependency && !profile.dsh?.profile?.bundles?.includes('@phyzess/kitto')) return (registered = false);
        if (!hasPnpm()) throw new Error('DSH native removal requires pnpm on PATH. Restore pnpm before retrying removal.');
        return (registered = true);
      };
      return [
        hostAction('dsh', 'detach-mcp', 'remove Kitto-owned MCP servers from the DSH home patch', {
          phase: 'detach',
          preview: mcp(true),
          apply: mcp(false),
        }),
        hostAction('dsh', 'unregister-bundle', `dsh plugin --profile ${profileOf(state)} remove @phyzess/kitto`, {
          phase: 'detach',
          preview: async () => {
            await bundleRegistered();
          },
          apply: async () => {
            if (!(await bundleRegistered())) return;
            run('dsh', ['plugin', '--profile', profileOf(state), 'remove', '@phyzess/kitto'], {
              env: { ...process.env, DSH_HOME: state.dshHome },
            });
          },
        }),
      ];
    },
  };
}
