import { createHash } from 'node:crypto';
import { routeId } from './routing-policy.mjs';

const SURFACES = {
  dsh: new Set(['teams', 'subagent']),
  pi: new Set(['current', 'subagent']),
  codex: new Set(['current', 'subagent']),
};
const DATA = new Set(['public', 'personal', 'internal', 'restricted']);
const BILLING = new Set(['subscription', 'go-included', 'metered']);
const EFFORTS = new Set(['default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const exact = route => routeId(route?.provider) && !route.provider.includes('/') && routeId(route.model);
const sameRoute = (a, b) => exact(a) && exact(b) && a.provider === b.provider && a.model === b.model;
const nonnegative = n => Number.isFinite(n) && n >= 0;
const digest = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const pair = ({ provider, model }) => ({ provider, model });

function decision(role, host, planId, route, preferred) {
  if (route.available !== true) return ['unavailable', 'host-route-unavailable'];
  if (host.surface !== 'current' && route.dispatchable !== true) return ['unavailable', 'host-cannot-select-route'];
  if (route.fallback !== 'none' && host.surface !== 'current') return ['unavailable', 'effective-fallback-unverified'];
  if (route.dataAllowed === false || (Array.isArray(route.allowedData) && !route.allowedData.includes(role.data))) {
    return ['unavailable', 'project-or-account-data-policy'];
  }
  if (role.failed?.some(previous => sameRoute(previous, route) || (previous.kind === 'authorization' &&
    previous.upstream === route.upstream && previous.account === route.account))) return ['unavailable', 'failed-route-or-account'];
  if (!routeId(route.upstream) || !routeId(route.account) || route.accountVerified !== true || !BILLING.has(route.billing)) {
    return ['decision-required', 'verify-account-and-billing'];
  }
  if (route.dataAllowed !== true) return ['decision-required', 'verify-data-policy'];
  const effort = (sameRoute(preferred, route) ? preferred.effort : undefined) ?? role.effort ?? 'default';
  if (!EFFORTS.has(effort) || (effort !== 'default' && !route.efforts?.includes(effort))) return ['unavailable', 'unsupported-effort'];
  if (role.reviewGate === 'independent') {
    if (!routeId(route.canonicalModel) || !routeId(route.family) || !role.implementers?.length ||
      role.implementers.some(item => !routeId(item?.canonicalModel) || !routeId(item.family))) {
      return ['unavailable', 'independence-unverified'];
    }
    if (role.implementers.some(item => item.canonicalModel === route.canonicalModel || item.family === route.family)) {
      return ['unavailable', 'not-independent'];
    }
  }
  if (route.billing === 'go-included' && route.quotaReady !== true) return ['unavailable', 'go-quota-unverified-or-unavailable'];
  const estimate = route.billing === 'metered' ? route.estimateUsd : null;
  if (route.billing === 'metered' && !nonnegative(estimate)) return ['decision-required', 'metered-estimate-required'];
  const approval = role.authorization;
  const bound = approval && sameRoute(approval, route) && approval.upstream === route.upstream &&
    approval.account === route.account && approval.billing === route.billing && approval.data === role.data &&
    approval.plan === planId && approval.role === role.id && approval.workRevision === role.workRevision;
  if (!bound) return ['decision-required', 'route-authorization-required'];
  if (route.billing === 'metered' && (!nonnegative(approval.maxUsd) || approval.maxUsd === 0 || estimate > approval.maxUsd)) {
    return ['decision-required', 'metered-cost-not-authorized'];
  }
  if (route.nativeSelectionRequired === true) return ['decision-required', 'select-in-native-host'];
  if (host.surface === 'current' && effort !== 'default') {
    if (!EFFORTS.has(route.nativeEffort) || route.nativeEffort === 'default') return ['decision-required', 'native-effort-unverified'];
    if (route.nativeEffort !== effort) return ['decision-required', 'set-effort-in-native-host'];
  }
  const key = digest([planId, host.kind, host.surface, host.session, role.id, role.workRevision, role.effects,
    role.data, role.dependencies, role.reviewGate, role.requireDifferentFamily, role.implementers, route.provider, route.model,
    route.canonicalModel, route.family, route.upstream, route.account, route.billing, effort, route.nativeEffort ?? null, estimate,
    route.billing === 'metered' ? approval.maxUsd : null]);
  return ['ready', 'authorized', { ...pair(route), effort, upstream: route.upstream, billing: route.billing,
    ...(estimate !== null && { estimateUsd: estimate, approvedUsd: approval.maxUsd, estimateOnly: true }), approvalKey: key }];
}

function validRole(role) {
  return routeId(role?.id) && routeId(role.workRevision) && DATA.has(role.data) && ['read', 'write'].includes(role.effects) &&
    Array.isArray(role.dependencies) && new Set(role.dependencies).size === role.dependencies.length &&
    role.dependencies.every(routeId) && (role.choice === undefined || role.choice === 'defer' || exact(role.choice)) &&
    (role.effort === undefined || EFFORTS.has(role.effort)) &&
    (role.failed === undefined || (Array.isArray(role.failed) && role.failed.every(exact))) &&
    (role.implementers === undefined || Array.isArray(role.implementers)) &&
    (role.reviewGate === undefined || role.reviewGate === 'independent');
}

export function planTaskRoutes(input, now = Date.now()) {
  const { id, host, roles, presets = {} } = input ?? {};
  const observed = Date.parse(host?.observedAt);
  if (!routeId(id) || !Object.hasOwn(SURFACES, host?.kind) || !SURFACES[host.kind].has(host.surface) ||
    !routeId(host.session) || !Array.isArray(host.routes) || !host.routes.every(route => exact(route) &&
      (route.efforts === undefined || Array.isArray(route.efforts))) || !Array.isArray(roles) || !roles.length ||
    !roles.every(validRole) || typeof presets !== 'object' || !presets || Array.isArray(presets)) {
    return { status: 'invalid', reason: 'invalid-plan-or-native-surface', rows: [] };
  }
  if (!Number.isFinite(observed) || observed > now || now - observed > 300_000) {
    return { status: 'unavailable', reason: 'native-evidence-stale', rows: [] };
  }
  const byId = new Map(roles.map(role => [role.id, role]));
  const visiting = new Set(), visited = new Set();
  function acyclic(role) {
    if (visiting.has(role.id)) return false;
    if (visited.has(role.id)) return true;
    visiting.add(role.id);
    if (!role.dependencies.every(dep => byId.has(dep) && acyclic(byId.get(dep)))) return false;
    visiting.delete(role.id);
    visited.add(role.id);
    return true;
  }
  if (byId.size !== roles.length || !roles.every(acyclic)) return { status: 'invalid', reason: 'invalid-task-graph', rows: [] };
  const counts = new Map();
  for (const route of host.routes) {
    const key = JSON.stringify([route.provider, route.model]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = roles.map(role => {
    if (role.choice === 'defer') return { id: role.id, status: 'deferred' };
    const expected = role.choice ?? (Object.hasOwn(presets, role.id) ? presets[role.id] : undefined) ?? (host.surface === 'current' ? host.current : undefined);
    const options = host.routes.map(route => {
      const [status, reason, selected] = counts.get(JSON.stringify([route.provider, route.model])) === 1
        ? decision(role, host, id, route, expected) : ['unavailable', 'ambiguous-native-route'];
      return { ...pair(route), ...(BILLING.has(route.billing) && { billing: route.billing }),
        ...(routeId(route.upstream) && { upstream: route.upstream }),
        ...(route.billing === 'metered' && nonnegative(route.estimateUsd) && { estimateUsd: route.estimateUsd, estimateOnly: true }),
        status, reason, ...(selected && { selected }) };
    });
    const matches = exact(expected) ? options.filter(option => sameRoute(option, expected)) : [];
    const ready = options.filter(option => option.status === 'ready');
    const selected = expected ? (matches.length === 1 ? matches[0] : undefined) : ready.length === 1 ? ready[0] : undefined;
    if (selected?.status === 'ready') return { id: role.id, status: 'ready', route: selected.selected };
    const choices = options.map(({ selected: ignored, ...option }) => option);
    const possible = choices.some(option => option.status !== 'unavailable');
    return { id: role.id, status: possible ? 'decision-required' : 'unavailable',
      reason: selected?.reason ?? (expected ? 'chosen-or-preset-route-unavailable' : 'select-route'), options: choices };
  });
  const resultById = new Map(rows.map(row => [row.id, row]));
  const dependencyBlocks = new Map();
  function blocked(role) {
    if (!dependencyBlocks.has(role.id)) {
      dependencyBlocks.set(role.id, role.dependencies.filter(id => resultById.get(id).status !== 'ready' || blocked(byId.get(id)).length > 0));
    }
    return dependencyBlocks.get(role.id);
  }
  for (const row of rows) {
    const dependencies = blocked(byId.get(row.id));
    if (dependencies.length) row.blockedBy = dependencies;
  }
  return { status: rows.every(row => row.status === 'ready') ? 'ready' : 'pending', rows,
    questions: rows.filter(row => row.status === 'decision-required').map(({ id, reason, options }) => ({ id, reason, options })),
    ready: rows.filter(row => row.status === 'ready' && !row.blockedBy).map(row => row.id) };
}

export function checkTaskRouteApproval(input, approval, now = Date.now()) {
  const plan = planTaskRoutes(input, now);
  if (!Array.isArray(approval) || !approval.length || !plan.ready || new Set(approval.map(row => row?.id)).size !== approval.length) {
    return { status: 'stop', reason: 'no-exact-launch-approval', plan };
  }
  const chosen = new Set(approval.map(row => row?.id));
  for (const entry of approval) {
    const row = plan.rows.find(row => row.id === entry?.id), task = input.roles.find(role => role.id === entry?.id);
    if (!row || !plan.ready.includes(row.id) || row.route.approvalKey !== entry.approvalKey ||
      !task.dependencies.every(id => chosen.has(id))) return { status: 'stop', reason: 'approval-changed-or-dependency-pending', plan };
  }
  return { status: 'approved', routes: plan.rows.filter(row => chosen.has(row.id)) };
}
