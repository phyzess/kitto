import { activeRoutingBoundary, routeId, routeKey } from './routing-policy.mjs';
import { estimateGoFraction, fresh, goMeter, goModel, normalizeGoCharge } from './go-allowance.mjs';
import { applyCapabilityEvidence } from './routing-evidence.mjs';

const DATA = ['public', 'personal', 'internal', 'restricted'];
const ROLES = { batch: 0, verify: 0, implement: 1, architect: 1, review: 1 };
const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const HOST_TTL = 5 * 60_000;
const MODELS = new Map(Object.entries({
  'openai-codex/gpt-6.2-sol': ['openai/gpt-6.2-sol', 1, false],
  'openai-codex/gpt-6.2-astra': ['openai/gpt-6.2-astra', 2, true],
  'opencode-go/deepseek-v4.1-flash': ['deepseek/deepseek-v4.1-flash-1017', 0, false],
  'opencode-go/glm-5.3-flash': ['zhipuai/glm-5.3-flash', 0, false],
  'opencode-go/hy3': ['tencent/hy3', 0, false],
  'opencode-go/glm-5.3': ['zhipuai/glm-5.3', 1, false],
  'opencode-go/kimi-k3.1-pro': ['moonshotai/kimi-k3.1-pro', 1, false],
  'opencode-go/grok-4.7': ['xai/grok-4.7', 2, true],
  'opencode-go/deepseek-v4-pro': ['deepseek/deepseek-v4-pro', 2, true],
}));
export const knownGoCanonical = model => MODELS.get(`opencode-go/${model}`)?.[0];

const FAMILIES = new Set(['openai', 'anthropic', 'deepseek', 'zhipuai', 'tencent', 'moonshotai', 'xai', 'google', 'alibaba', 'minimax', 'xiaomi']);
const UPSTREAMS = ['openai-codex', 'opencode-go', 'anthropic', 'openrouter'];
const BLOCKED_PROVIDERS = ['deepseek-official', 'xai', 'opencode', 'opencode-zen'];
const validRoute = value => routeId(value?.provider) && !value.provider.includes('/') && routeId(value.model);
const keyOf = value => validRoute(value) ? routeKey(value) : null;

function identity(canonicalModel) {
  if (!routeId(canonicalModel) || !/^[^/]+\/[^/]+$/.test(canonicalModel)) return null;
  const canonical = canonicalModel.toLowerCase(), family = canonical.split('/')[0];
  return FAMILIES.has(family) ? { canonicalModel: canonical, family } : null;
}

export function auditReview(implementers, reviewer) {
  const actual = identity(reviewer?.canonicalModel);
  if (!actual || !Array.isArray(implementers) || !implementers.length) return { independent: false, reason: 'identity-unverified' };
  const others = implementers.map(item => identity(item?.canonicalModel));
  if (others.some(item => !item)) return { independent: false, reason: 'identity-unverified' };
  if (others.some(item => item.canonicalModel === actual.canonicalModel)) return { independent: false, reason: 'same-model' };
  if (others.some(item => item.family === actual.family)) return { independent: false, reason: 'same-family' };
  return { independent: true, reason: 'different-model-and-family' };
}

export function classifyRoutingFailure(failure, route) {
  const { kind, status } = failure ?? {};
  if (kind === 'go-pool-quota' || route?.upstream === 'opencode-go' && status === 429 && kind !== 'model-rate-limit') return 'go-pool-quota';
  if (['authorization', 'configuration'].includes(kind) || [401, 403].includes(status)) return 'configuration';
  if (['model-unavailable', 'model-rate-limit'].includes(kind) || status === 404) return 'route';
  if (['network', 'timeout', 'upstream-unavailable'].includes(kind) || [408, 502, 503, 504].includes(status)) return 'transient';
  if (kind === 'quality') return 'quality';
  return 'unknown';
}

function verifiedUpstream(route) {
  if (!validRoute(route) || !UPSTREAMS.includes(route.upstream)) return false;
  const provider = route.provider.toLowerCase();
  return !BLOCKED_PROVIDERS.includes(provider) && (!UPSTREAMS.includes(provider) || route.upstream === provider);
}

function routeInfo(route, go, now) {
  if (!verifiedUpstream(route)) return null;
  if (route.upstream === 'opencode-go') {
    const model = goModel(go, route.model, now);
    const builtIn = MODELS.get(`opencode-go/${route.model}`);
    const declared = identity(route.canonicalModel);
    if (!builtIn || !model || declared?.canonicalModel !== builtIn[0]
      || declared.canonicalModel !== identity(model.item.canonical_id)?.canonicalModel) return null;
    return { ...declared, tier: builtIn[1], premium: builtIn[2], goModel: model };
  }
  const builtIn = MODELS.get(`${route.upstream}/${route.model}`);
  const actual = identity(route.canonicalModel);
  if (!actual) return null;
  if (route.upstream === 'openai-codex') {
    if (!builtIn || actual.canonicalModel !== builtIn[0]) return null;
    return { ...actual, tier: builtIn[1], premium: builtIn[2] };
  }
  if (route.upstream === 'anthropic' && actual.family !== 'anthropic') return null;
  // Other upstreams have no built-in capability/cost defaults. Exact operator authorization is mandatory.
  if (![0, 1, 2].includes(route.tier) || typeof route.premium !== 'boolean') return null;
  const externalIdentity = [...MODELS.values()].find(([canonical]) => canonical === actual.canonicalModel);
  const tier = externalIdentity?.[1] ?? route.tier;
  return { ...actual, tier, premium: route.premium || tier === 2 || externalIdentity?.[2] === true };
}

function authorized(task, route, info) {
  return task.authorized.some(entry => keyOf(entry) === keyOf(route) && entry.upstream === route.upstream
    && entry.account === route.account && entry.accountType === route.accountType && entry.billing === route.billing
    && identity(entry.canonicalModel)?.canonicalModel === info.canonicalModel && entry.data === task.data
    && (!info.premium || entry.premium === true));
}

function failureRoute(snapshot, task, routes) {
  if (!verifiedUpstream(snapshot) || !routeId(snapshot.account)) return null;
  const key = keyOf(snapshot);
  const sameBinding = route => route.upstream === snapshot.upstream && route.account === snapshot.account;
  const approvals = task.authorized.filter(entry => keyOf(entry) === key && entry.data === task.data);
  if (approvals.length !== 1 || !sameBinding(approvals[0]) || !identity(approvals[0].canonicalModel)) return null;
  const observed = routes.get(key) ?? [];
  if (!observed.length) return approvals[0];
  return observed.length === 1 && sameBinding(observed[0]) && observed[0].accountVerified === true ? observed[0] : null;
}

const accountKey = route => JSON.stringify([route.upstream, route.account]);

function effortFor(route, requested, surface) {
  if (!Array.isArray(route.reasoningEfforts) || !route.reasoningEfforts.every(effort => EFFORTS.includes(effort) && effort !== 'default')) return undefined;
  const selected = requested.find(effort => effort === 'default' || route.reasoningEfforts.includes(effort));
  return selected === 'default' && surface === 'subagent' ? null : selected;
}

function nextAction(type, role) {
  if (type === 'go-pool-quota') return 'Wait for the limiting Go window and refresh usage, or approve an independent non-Go subscription route.';
  if (type === 'configuration') return 'Repair credentials, account ownership or native allowlist; start a new session and recheck.';
  if (type === 'transient') return 'Check connectivity and service status before starting new work.';
  if (type === 'quality') return 'Review failed evidence and authorize a more capable independent route, or hand off.';
  if (role === 'review') return 'Keep review pending and request an independent external reviewer.';
  return 'Refresh capability and account evidence; request explicit authorization or stop.';
}

export function authorizeGoRead(state, request, now) {
  const { task, go, goRead } = request ?? {};
  const host = applyCapabilityEvidence(request?.host, now);
  if (host?.kind !== 'dsh' || host.installation !== 'full-local' || !['subagent', 'teams'].includes(host.surface)
    || !fresh(host.observedAt, now, HOST_TTL) || !Array.isArray(host.routes)
    || !Array.isArray(task?.authorized) || !DATA.includes(task.data)) return null;
  const policy = activeRoutingBoundary(state, host.profile);
  if (!policy || !routeId(go?.account) || go?.extraUsage !== 'off' || !['go', 'go-plus', 'go-teams'].includes(go?.plan)
    || goRead?.allow !== true || goRead.credentialBindingConfirmed !== true || goRead.account !== go.account
    || !['personal', 'service-account'].includes(goRead.credentialKind)
    || (go.plan === 'go-teams' && goRead.credentialKind !== 'personal')) return null;
  const key = keyOf(goRead);
  const matches = host.routes.filter(route => keyOf(route) === key);
  const route = matches[0];
  if (!key || matches.length !== 1 || !verifiedUpstream(route) || route.upstream !== 'opencode-go' || route.available !== true
    || route.accountVerified !== true || route.account !== go.account || route.billing !== 'go-included'
    || !['company', 'personal'].includes(route.accountType)
    || ((policy.mode === 'company' || ['internal', 'restricted'].includes(task.data)) && (route.accountType !== 'company' || task.data === 'personal'))
    || (policy.mode === 'custom' && !policy.routes.includes(key))) return null;
  const builtIn = MODELS.get(`opencode-go/${route.model}`);
  const canonicalModel = identity(route.canonicalModel)?.canonicalModel;
  if (!builtIn || builtIn[0] !== canonicalModel || !authorized(task, route, { canonicalModel, premium: builtIn[2] })) return null;
  return { account: go.account, plan: go.plan, model: route.model, canonicalModel, profile: host.profile };
}

function resolveGoEvidence(go, profile) {
  if (!go || !Object.hasOwn(go, 'metadata')) return go;
  const { metadata, plan, account, extraUsage, lastRequest } = go;
  if (metadata?.status !== 'collected' || metadata.source !== 'opencode-go-metadata' || metadata.account !== account
    || metadata.plan !== plan || metadata.profile !== profile) return { account, plan, extraUsage };
  return { account, plan, extraUsage, lastRequest, catalogObservedAt: metadata.catalogObservedAt,
    observedAt: metadata.observedAt, catalog: metadata.catalog, usage: metadata.usage };
}

export function adviseRoute({ state, request, operation = 'preflight', now = Date.now() }) {
  const { task, failure } = request ?? {};
  const host = applyCapabilityEvidence(request?.host, now);
  const go = resolveGoEvidence(request?.go, host?.profile);
  const stop = (reason, detail = {}) => ({ advisory: true, status: 'stop', reason, ...detail });
  if (host?.kind !== 'dsh' || host.installation !== 'full-local' || !['subagent', 'teams'].includes(host.surface)) {
    return stop('unsupported-surface');
  }
  const policy = activeRoutingBoundary(state, host.profile);
  if (!policy) return stop('boundary-unconfirmed', { next: 'Confirm the boundary in full local Kitto setup.' });
  if (!Array.isArray(host.routes) || !fresh(host.observedAt, now, HOST_TTL)) return stop('host-capabilities-unverified');
  if (host.surface === 'teams' && (!Array.isArray(host.effectiveFallbacks) || host.effectiveFallbacks.length !== 0)) {
    return stop('native-fallback-unverified-or-enabled', { next: 'Disable member, profile and global fallbacks in native configuration, restart and verify the effective plan.' });
  }
  if (!Object.hasOwn(ROLES, task?.role) || !DATA.includes(task.data) || !Array.isArray(task.authorized)
      || !['read', 'write'].includes(task.effects) || !Array.isArray(task.effort) || !task.effort.length
      || !task.effort.every(effort => EFFORTS.includes(effort))
      || (task.minTier !== undefined && ![0, 1, 2].includes(task.minTier))) return stop('invalid-task-authorization');
  const minimum = Math.max(ROLES[task.role], task.minTier ?? 0);
  if (task.role === 'review' && auditReview(task.implementers, { canonicalModel: 'openai/reference' }).reason === 'identity-unverified') {
    return stop('implementation-identity-unverified', { next: nextAction(null, 'review') });
  }
  const pool = goMeter(go, now);
  const history = request.attempted === undefined ? [] : request.attempted;
  if (!Array.isArray(history)) return stop('invalid-attempt-history');
  const observedRoutes = new Map();
  for (const route of host.routes) {
    const key = keyOf(route);
    if (key) observedRoutes.set(key, [...(observedRoutes.get(key) ?? []), route]);
  }
  const attempted = new Set(), failedAccounts = new Set();
  let goHeld = false;
  const remember = (route, classification) => {
    attempted.add(keyOf(route));
    if (classification === 'configuration') failedAccounts.add(accountKey(route));
    if (classification === 'go-pool-quota') goHeld = true;
  };
  for (const entry of history) {
    const bound = failureRoute(entry, task, observedRoutes);
    const classification = classifyRoutingFailure(entry, bound);
    if (!bound || classification === 'unknown') {
      return stop('attempt-history-unverified', { next: 'Restore the verified upstream, account and failure evidence for each attempt before reselecting.' });
    }
    remember(bound, classification);
  }

  let failureClass, failedTier;
  if (operation === 'reselect') {
    const failedRoute = failureRoute(failure?.route, task, observedRoutes);
    if (!failedRoute) return stop('failed-route-unverified');
    failureClass = classifyRoutingFailure(failure, failedRoute);
    remember(failedRoute, failureClass);
    if (task.effects === 'write' && failure?.checkpointConfirmed !== true) {
      return stop('write-checkpoint-required', { failureClass, next: 'Inspect partial writes and evidence; the operator must authorize a new work item, not replay the failed task.' });
    }
    if (failureClass === 'unknown') return stop('failure-unclassified', { failureClass, next: nextAction(failureClass, task.role) });
    failedTier = routeInfo(failedRoute, go, now)?.tier;
    if (failureClass === 'quality' && failedTier === undefined) return stop('failed-capability-unverified', { failureClass });
  }

  const rejected = [], candidates = [];
  for (const route of host.routes) {
    const key = keyOf(route);
    if (!key) continue;
    const reject = reason => rejected.push({ provider: route.provider, model: route.model, reason });
    if (observedRoutes.get(key)?.length !== 1) { reject('ambiguous-host-route'); continue; }
    if (route.available !== true) { reject('unavailable-or-not-allowed'); continue; }
    if (attempted.has(key)) { reject('already-attempted'); continue; }
    if (policy.mode === 'custom' && !policy.routes.includes(key)) { reject('device-route-not-approved'); continue; }
    const companyBoundary = policy.mode === 'company' || ['internal', 'restricted'].includes(task.data);
    if (!routeId(route.account) || !['company', 'personal'].includes(route.accountType) || route.accountVerified !== true
        || (companyBoundary && (route.accountType !== 'company' || task.data === 'personal'))) {
      reject('account-or-data-boundary'); continue;
    }
    if (route.billing !== (route.upstream === 'opencode-go' ? 'go-included' : 'subscription')) {
      reject('pay-as-you-go-or-unverified-billing'); continue;
    }
    if (failedAccounts.has(accountKey(route))) { reject('failed-upstream-account'); continue; }
    if (route.upstream === 'opencode-go' && goHeld) { reject('go-pool-quota'); continue; }
    const info = routeInfo(route, go, now);
    if (!info) { reject('upstream-or-model-metadata-unverified'); continue; }
    if (!authorized(task, route, info)) { reject(info.premium ? 'premium-not-approved' : 'route-or-data-not-authorized'); continue; }
    if (info.tier < minimum || failureClass === 'quality' && info.tier <= failedTier) { reject('capability-under-floor'); continue; }
    if (task.role === 'review') {
      const audit = auditReview(task.implementers, info);
      if (!audit.independent) { reject(audit.reason); continue; }
    }
    const effort = effortFor(route, task.effort, host.surface);
    if (effort === undefined) { reject('effort-unavailable'); continue; }
    let estimate;
    if (info.goModel) {
      if (go.extraUsage !== 'off' || go.account !== route.account) { reject('go-account-or-overage-unverified'); continue; }
      if (pool.status !== 'available') { reject(`go-meter-${pool.status}`); continue; }
      estimate = estimateGoFraction(info.goModel, task.tokens);
      if (estimate === null) { reject('go-estimate-unavailable'); continue; }
      if (estimate >= pool.remaining) { reject('go-insufficient-headroom'); continue; }
    }
    candidates.push({ key, route, info, effort, estimate });
  }
  const rank = item => item.info.premium ? 1 : 0;
  candidates.sort((a, b) => rank(a) - rank(b) || a.info.tier - b.info.tier
    || (a.estimate ?? 0) - (b.estimate ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const recent = go?.lastRequest;
  const recentModel = recent && goModel(go, recent.model, now);
  const reportedCharge = recentModel && normalizeGoCharge(recent.usage, recentModel, go.plan);
  const detail = { rejected, ...(failureClass && { failureClass }), go: pool,
    ...(reportedCharge && { lastReportedGoCharge: reportedCharge }) };
  if (!candidates.length) return stop(task.role === 'review' ? 'external-review-pending' : 'no-eligible-route', {
    ...detail, next: nextAction(failureClass ?? (goHeld || pool.status === 'exhausted' ? 'go-pool-quota' : null), task.role),
  });
  const { route, info, effort, estimate } = candidates[0];
  return { advisory: true, status: 'recommend', ...detail, reason: 'authorized-supported-lowest-tier-and-allowance',
    route: { provider: route.provider, model: route.model, canonicalModel: info.canonicalModel, family: info.family,
      ...(effort !== null && { reasoning_effort: effort }) },
    ...(estimate !== undefined && { estimatedMonthlyFraction: estimate }),
    next: operation === 'reselect' ? 'Start a new explicitly approved work item from the recorded checkpoint; verify the actual active model.'
      : 'Apply the recommendation through the native tool only after approval; verify the actual active model.',
  };
}
