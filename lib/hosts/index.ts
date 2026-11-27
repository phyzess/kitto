import { isDesktopProfile } from '../dsh-profile.ts';
import { hosts } from '../host-pins.ts';
import { createCodexAdapter } from './codex.ts';
import { createDshDesktopAdapter } from './dsh-desktop.ts';
import { createDshWebAdapter } from './dsh-web.ts';
import { createPiAdapter } from './pi.ts';

const factories = {
  pi: (state, deps) => createPiAdapter(deps),
  codex: (state, deps) => createCodexAdapter(deps),
  dsh: (state, deps) => (isDesktopProfile(state.dshProfile) ? createDshDesktopAdapter() : createDshWebAdapter(deps)),
};

export function adapterFor(state, name, deps = {}) {
  return factories[name](state, { ...deps.common, ...deps[name] });
}

export const selectedAdapters = (state, deps = {}) => state.agents.map(name => adapterFor(state, name, deps));

const hostOrder = Object.keys(hosts);
const byHostOrder = (left, right) => hostOrder.indexOf(left.host) - hostOrder.indexOf(right.host);

export function planDeploy(state, { deps = undefined } = {}) {
  const actions = selectedAdapters(state, deps).flatMap(adapter => adapter.plan(state));
  return {
    sync: actions.filter(action => action.phase === 'sync').sort(byHostOrder),
    postSkills: actions.filter(action => action.phase === 'post-skills'),
  };
}

export const planConnect = (state, { deps = undefined } = {}) => selectedAdapters(state, deps).flatMap(adapter => adapter.planConnect(state));

export async function connectNative(state, { deps = undefined } = {}) {
  for (const adapter of selectedAdapters(state, deps)) adapter.assertConnectable?.();
  for (const action of planConnect(state, { deps })) await action.apply();
}
