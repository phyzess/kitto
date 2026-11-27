import { isDesktopProfile } from '../dsh-profile.ts';
import { hosts } from '../host-pins.ts';
import { createCodexAdapter } from './codex.ts';
import { createDshDesktopAdapter } from './dsh-desktop.ts';
import { createDshWebAdapter } from './dsh-web.ts';
import { createPiAdapter } from './pi.ts';
import type { DeployPlan, HostAdapter, HostAdapterDeps, HostName, PiAdapter, State } from '../../types/kitto.d.ts';
import type { HostAction } from './action.ts';
import type { CodexAdapterDeps } from './codex.ts';
import type { DshWebAdapterDeps } from './dsh-web.ts';
import type { PiAdapterDeps } from './pi.ts';

interface Factories {
  pi: (state: State, deps: PiAdapterDeps) => PiAdapter;
  codex: (state: State, deps: CodexAdapterDeps) => HostAdapter;
  dsh: (state: State, deps: DshWebAdapterDeps) => HostAdapter;
}

const factories: Factories = {
  pi: (state, deps) => createPiAdapter(deps),
  codex: (state, deps) => createCodexAdapter(deps),
  dsh: (state, deps) => (isDesktopProfile(state.dshProfile) ? createDshDesktopAdapter() : createDshWebAdapter(deps)),
};

export function adapterFor(state: State, name: 'pi', deps?: HostAdapterDeps): PiAdapter;
export function adapterFor(state: State, name: HostName, deps?: HostAdapterDeps): HostAdapter;
export function adapterFor(state: State, name: HostName, deps: HostAdapterDeps = {}): HostAdapter {
  return factories[name](state, { ...deps.common, ...deps[name] } as PiAdapterDeps & CodexAdapterDeps & DshWebAdapterDeps);
}

export const selectedAdapters = (state: State, deps: HostAdapterDeps = {}): HostAdapter[] =>
  state.agents.map((name) => adapterFor(state, name, deps));

const hostOrder = Object.keys(hosts);
const byHostOrder = (left: HostAction, right: HostAction) => hostOrder.indexOf(left.host) - hostOrder.indexOf(right.host);

export function planDeploy(state: State, { deps = undefined }: { deps?: HostAdapterDeps } = {}): DeployPlan {
  const actions = selectedAdapters(state, deps).flatMap((adapter) => adapter.plan(state));
  return {
    sync: actions.filter((action) => action.phase === 'sync').sort(byHostOrder),
    postSkills: actions.filter((action) => action.phase === 'post-skills'),
  };
}

export const planConnect = (state: State, { deps = undefined }: { deps?: HostAdapterDeps } = {}): HostAction[] =>
  selectedAdapters(state, deps).flatMap((adapter) => adapter.planConnect(state));

export async function connectNative(state: State, { deps = undefined }: { deps?: HostAdapterDeps } = {}): Promise<void> {
  for (const adapter of selectedAdapters(state, deps)) adapter.assertConnectable?.();
  for (const action of planConnect(state, { deps })) await action.apply();
}
