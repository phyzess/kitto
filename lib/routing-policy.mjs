import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { isDesktopProfile } from './dsh-profile.mjs';

const POLICY_MODES = ['personal', 'company', 'custom', 'skip'];
export const routeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9_.:/-]{0,159}$/i.test(value);
export const routeKey = ({ provider, model }) => `${provider}/${model}`;

function localIdentity() {
  let machine = hostname();
  try { machine += `:${readFileSync('/etc/machine-id', 'utf8').trim()}`; } catch { /* Non-Linux hosts may only have a hostname. */ }
  const { uid, username } = userInfo();
  return createHash('sha256').update(JSON.stringify([machine, uid, username])).digest('hex');
}

function customRouteKeys(value) {
  return Array.isArray(value) && value.length > 0 && value.every(key => routeId(key) && /^[^/]+\/.+$/.test(key))
    && new Set(value).size === value.length;
}

export function parseRoutingBoundary(mode, routes) {
  if (!POLICY_MODES.includes(mode)) throw new Error('Use --routing-boundary personal, company, custom or skip.');
  const keys = typeof routes === 'string' ? routes.split(',').map(value => value.trim()) : undefined;
  if (mode === 'custom' ? !customRouteKeys(keys) : routes !== undefined) {
    throw new Error('Only a custom routing boundary requires --routing-routes PROVIDER/MODEL[,PROVIDER/MODEL].');
  }
  return { mode, ...(keys && { routes: keys }) };
}

export function setRoutingBoundary(state, mode, routes) {
  const policy = parseRoutingBoundary(mode, routes);
  if (policy.mode !== 'skip' && (!state.agents.includes('dsh') || isDesktopProfile(state.dshProfile))) {
    throw new Error('Confirm routing only in full local DSH setup (not Desktop, scoped-only or service setup).');
  }
  state.routingBoundary = { schema: 1, ...policy, identity: localIdentity(), profile: state.dshProfile };
}

export function activeRoutingBoundary(state, profile) {
  const policy = state?.routingBoundary;
  if (state?.schema !== 1 || state.routingInstallKind !== 'local' || state.ready !== true
      || state.detached || state.removing || !Array.isArray(state.agents)
      || !state.agents.includes('dsh') || !routeId(profile) || isDesktopProfile(profile) || state.dshProfile !== profile
      || policy?.schema !== 1 || policy.profile !== profile || !POLICY_MODES.includes(policy.mode)
      || policy.identity !== localIdentity() || policy.mode === 'skip'
      || (policy.mode === 'custom' ? !customRouteKeys(policy.routes) : Object.hasOwn(policy, 'routes'))) return null;
  return policy;
}
