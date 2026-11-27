import { activeRoutingBoundary, routeId, routeKey } from './routing-policy.ts';
import { estimateGoFraction, fresh, goMeter, goModel, normalizeGoCharge } from './go-allowance.ts';
import { applyCapabilityEvidence } from './routing-evidence.ts';
import type { Json, State } from '../types/kitto.d.ts';
import type { GoBinding } from './go-metadata.ts';
import type { GoMeter } from './go-allowance.ts';

interface RouteInfo {
  canonicalModel: string;
  family?: string;
  tier: number;
  premium: boolean;
  goModel?: { item: Json; cap: number };
}

interface Candidate {
  key: string;
  route: Json;
  info: RouteInfo;
  effort: string | null;
  estimate: number | null | undefined;
}

const DATA = ['public', 'personal', 'internal', 'restricted'];
const ROLES: Record<string, number> = { batch: 0, verify: 0, implement: 1, architect: 1, review: 1 };
const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const HOST_TTL = 5 * 60_000;
const MODELS = new Map<string, [string, number, boolean]>(
  Object.entries<[string, number, boolean]>({
    'openai-codex/gpt-6.2-sol': ['openai/gpt-6.2-sol', 1, false],
    'openai-codex/gpt-6.2-astra': ['openai/gpt-6.2-astra', 2, true],
    'opencode-go/deepseek-v4.1-flash': ['deepseek/deepseek-v4.1-flash-1017', 0, false],
    'opencode-go/glm-5.3-flash': ['zhipuai/glm-5.3-flash', 0, false],
    'opencode-go/hy3': ['tencent/hy3', 0, false],
    'opencode-go/glm-5.3': ['zhipuai/glm-5.3', 1, false],
    'opencode-go/kimi-k3.1-pro': ['moonshotai/kimi-k3.1-pro', 1, false],
    'opencode-go/grok-4.7': ['xai/grok-4.7', 2, true],
    'opencode-go/deepseek-v4-pro': ['deepseek/deepseek-v4-pro', 2, true],
  }),
);
export const knownGoCanonical = (model: string) => MODELS.get(`opencode-go/${model}`)?.[0];

const FAMILIES = new Set([
  'openai',
  'anthropic',
  'deepseek',
  'zhipuai',
  'tencent',
  'moonshotai',
  'xai',
  'google',
  'alibaba',
  'minimax',
  'xiaomi',
]);
const UPSTREAMS = ['openai-codex', 'opencode-go', 'anthropic', 'openrouter'];
const BLOCKED_PROVIDERS = ['deepseek-official', 'xai', 'opencode', 'opencode-zen'];
const validRoute = (value: Json | null | undefined): value is Json =>
  value !== null && value !== undefined && routeId(value.provider) && !value.provider.includes('/') && routeId(value.model);
const keyOf = (value: Json | null | undefined): string | null => (validRoute(value) ? routeKey(value) : null);

function identity(canonicalModel: unknown): { canonicalModel: string; family: string } | null {
  if (!routeId(canonicalModel) || !/^[^/]+\/[^/]+$/.test(canonicalModel)) return null;
  const canonical = canonicalModel.toLowerCase(),
    family = canonical.split('/')[0];
  return FAMILIES.has(family) ? { canonicalModel: canonical, family } : null;
}

function auditReview(implementers: unknown, reviewer: Json | null | undefined): { independent: boolean; reason: string } {
  const actual = identity(reviewer?.canonicalModel);
  if (!actual || !Array.isArray(implementers) || !implementers.length) return { independent: false, reason: 'identity-unverified' };
  const others = (implementers as Json[]).map((item) => identity(item?.canonicalModel));
  if (others.some((item) => !item)) return { independent: false, reason: 'identity-unverified' };
  if (others.some((item) => item!.canonicalModel === actual.canonicalModel)) return { independent: false, reason: 'same-model' };
  if (others.some((item) => item!.family === actual.family)) return { independent: false, reason: 'same-family' };
  return { independent: true, reason: 'different-model-and-family' };
}

function verifiedUpstream(route: Json | null | undefined): boolean {
  if (!validRoute(route) || !UPSTREAMS.includes(route.upstream)) return false;
  const provider = route.provider.toLowerCase();
  return !BLOCKED_PROVIDERS.includes(provider) && (!UPSTREAMS.includes(provider) || route.upstream === provider);
}

function routeInfo(route: Json, go: Json | null | undefined, now: number): RouteInfo | null {
  if (!verifiedUpstream(route)) return null;
  if (route.upstream === 'opencode-go') {
    const model = goModel(go, route.model, now);
    const builtIn = MODELS.get(`opencode-go/${route.model}`);
    const declared = identity(route.canonicalModel);
    if (
      !builtIn ||
      !model ||
      declared?.canonicalModel !== builtIn[0] ||
      declared.canonicalModel !== identity(model.item.canonical_id)?.canonicalModel
    )
      return null;
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
  if (![0, 1, 2].includes(route.tier) || typeof route.premium !== 'boolean') return null;
  const externalIdentity = [...MODELS.values()].find(([canonical]) => canonical === actual.canonicalModel);
  const tier = externalIdentity?.[1] ?? route.tier;
  return { ...actual, tier, premium: route.premium || tier === 2 || externalIdentity?.[2] === true };
}

function authorized(task: Json, route: Json, info: Pick<RouteInfo, 'canonicalModel' | 'premium'>, pool?: string): boolean {
  return task.authorized.some(
    (entry: Json) =>
      keyOf(entry) === keyOf(route) &&
      entry.upstream === route.upstream &&
      entry.account === route.account &&
      entry.accountType === route.accountType &&
      entry.billing === route.billing &&
      identity(entry.canonicalModel)?.canonicalModel === info.canonicalModel &&
      entry.data === task.data &&
      (!info.premium || entry.premium === true) &&
      (pool === undefined || entry.pool === pool),
  );
}

function effortFor(route: Json, requested: string[], surface: string): string | null | undefined {
  if (
    !Array.isArray(route.reasoningEfforts) ||
    !route.reasoningEfforts.every((effort: string) => EFFORTS.includes(effort) && effort !== 'default')
  )
    return undefined;
  const selected = requested.find((effort) => effort === 'default' || route.reasoningEfforts.includes(effort));
  return selected === 'default' && surface === 'subagent' ? null : selected;
}

function nextAction(type: string | null, role: string): string {
  if (type === 'go-pool-quota')
    return 'Wait for the limiting Go window and refresh usage, or approve an independent non-Go subscription route.';
  if (role === 'review') return 'Keep review pending and request an independent external reviewer.';
  return 'Refresh capability and account evidence; request explicit authorization or stop.';
}

export function authorizeGoRead(state: State, request: Json | null | undefined, now: number): (GoBinding & { profile: string }) | null {
  const { task, go, goRead } = request ?? {};
  const host = applyCapabilityEvidence(request?.host, now);
  if (
    host?.kind !== 'dsh' ||
    host.installation !== 'full-local' ||
    !['subagent', 'teams'].includes(host.surface) ||
    !fresh(host.observedAt, now, HOST_TTL) ||
    !Array.isArray(host.routes) ||
    !Array.isArray(task?.authorized) ||
    !DATA.includes(task.data)
  )
    return null;
  const policy = activeRoutingBoundary(state, host.profile);
  if (
    !policy ||
    !routeId(go?.account) ||
    go?.extraUsage !== 'off' ||
    !['go', 'go-plus', 'go-teams'].includes(go?.plan) ||
    goRead?.allow !== true ||
    goRead.credentialBindingConfirmed !== true ||
    goRead.account !== go.account ||
    !['personal', 'service-account'].includes(goRead.credentialKind) ||
    (go.plan === 'go-teams' && goRead.credentialKind !== 'personal')
  )
    return null;
  const key = keyOf(goRead);
  const matches = host.routes.filter((route: Json) => keyOf(route) === key);
  const route = matches[0];
  if (
    !key ||
    matches.length !== 1 ||
    !verifiedUpstream(route) ||
    route.upstream !== 'opencode-go' ||
    route.available !== true ||
    route.accountVerified !== true ||
    route.account !== go.account ||
    route.billing !== 'go-included' ||
    !['company', 'personal'].includes(route.accountType) ||
    ((policy.mode === 'company' || ['internal', 'restricted'].includes(task.data)) &&
      (route.accountType !== 'company' || task.data === 'personal')) ||
    (policy.mode === 'custom' && !policy.routes?.includes(key))
  )
    return null;
  const builtIn = MODELS.get(`opencode-go/${route.model}`);
  const canonicalModel = identity(route.canonicalModel)?.canonicalModel;
  if (!builtIn || builtIn[0] !== canonicalModel || !authorized(task, route, { canonicalModel, premium: builtIn[2] })) return null;
  return { account: go.account, plan: go.plan, model: route.model, canonicalModel, profile: host.profile };
}

function resolveGoEvidence(go: Json | null | undefined, profile: string | undefined): Json | null | undefined {
  if (!go || !Object.hasOwn(go, 'metadata')) return go;
  const { metadata, plan, account, extraUsage, lastRequest } = go;
  if (
    metadata?.status !== 'collected' ||
    metadata.source !== 'opencode-go-metadata' ||
    metadata.account !== account ||
    metadata.plan !== plan ||
    metadata.profile !== profile
  )
    return { account, plan, extraUsage };
  return {
    account,
    plan,
    extraUsage,
    lastRequest,
    catalogObservedAt: metadata.catalogObservedAt,
    observedAt: metadata.observedAt,
    catalog: metadata.catalog,
    usage: metadata.usage,
  };
}

export function adviseRoute({
  state,
  request,
  now = Date.now(),
  poolStatus,
  controlled = false,
}: {
  state: State;
  request: Json;
  now?: number;
  poolStatus?: (pool: string, observedAt?: string) => string;
  controlled?: boolean;
}): Json {
  const { task } = request ?? {};
  const host = applyCapabilityEvidence(request?.host, now);
  const go = resolveGoEvidence(request?.go, host?.profile);
  const stop = (reason: string, detail: Json = {}) => ({ advisory: true, status: 'stop', reason, ...detail });
  if (host?.kind !== 'dsh' || host.installation !== 'full-local' || !['subagent', 'teams'].includes(host.surface)) {
    return stop('unsupported-surface');
  }
  const policy = activeRoutingBoundary(state, host.profile);
  if (!policy) return stop('boundary-unconfirmed', { next: 'Confirm the boundary in full local Kitto setup.' });
  if (!Array.isArray(host.routes) || !fresh(host.observedAt, now, HOST_TTL)) return stop('host-capabilities-unverified');
  if (host.surface === 'teams' && (!Array.isArray(host.effectiveFallbacks) || host.effectiveFallbacks.length !== 0)) {
    return stop('native-fallback-unverified-or-enabled', {
      next: 'Disable member, profile and global fallbacks in native configuration, restart and verify the effective plan.',
    });
  }
  if (
    !Object.hasOwn(ROLES, task?.role) ||
    !DATA.includes(task.data) ||
    !Array.isArray(task.authorized) ||
    !['read', 'write'].includes(task.effects) ||
    !Array.isArray(task.effort) ||
    !task.effort.length ||
    !task.effort.every((effort: string) => EFFORTS.includes(effort)) ||
    (task.minTier !== undefined && ![0, 1, 2].includes(task.minTier))
  )
    return stop('invalid-task-authorization');
  const budget = task.budget;
  const checkBudget = controlled || budget !== undefined;
  if (
    checkBudget &&
    (!Number.isFinite(budget?.maxAdditionalCashUsd) ||
      budget.maxAdditionalCashUsd < 0 ||
      !Number.isFinite(budget.maxMonthlyGoFraction) ||
      budget.maxMonthlyGoFraction < 0 ||
      budget.maxMonthlyGoFraction > 1)
  ) {
    return stop('invalid-task-budget');
  }
  const minimum = Math.max(ROLES[task.role], task.minTier ?? 0);
  if (task.role === 'review' && auditReview(task.implementers, { canonicalModel: 'openai/reference' }).reason === 'identity-unverified') {
    return stop('implementation-identity-unverified', { next: nextAction(null, 'review') });
  }
  const pool: GoMeter = goMeter(go, now);
  const observedRoutes = new Map<string, Json[]>();
  for (const route of host.routes) {
    const key = keyOf(route);
    if (key) observedRoutes.set(key, [...(observedRoutes.get(key) ?? []), route]);
  }
  const sharedPools = controlled || poolStatus !== undefined;

  const rejected: Json[] = [],
    candidates: Candidate[] = [];
  for (const route of host.routes) {
    const key = keyOf(route);
    if (!key) continue;
    const reject = (reason: string) => rejected.push({ provider: route.provider, model: route.model, reason });
    if (observedRoutes.get(key)?.length !== 1) {
      reject('ambiguous-host-route');
      continue;
    }
    if (route.available !== true) {
      reject('unavailable-or-not-allowed');
      continue;
    }
    if (policy.mode === 'custom' && !policy.routes?.includes(key)) {
      reject('device-route-not-approved');
      continue;
    }
    const companyBoundary = policy.mode === 'company' || ['internal', 'restricted'].includes(task.data);
    if (
      !routeId(route.account) ||
      !['company', 'personal'].includes(route.accountType) ||
      route.accountVerified !== true ||
      (companyBoundary && (route.accountType !== 'company' || task.data === 'personal'))
    ) {
      reject('account-or-data-boundary');
      continue;
    }
    if (route.billing !== (route.upstream === 'opencode-go' ? 'go-included' : 'subscription')) {
      reject('pay-as-you-go-or-unverified-billing');
      continue;
    }
    const needsPool = route.upstream === 'opencode-go' && (sharedPools || route.pool !== undefined || request.go?.pool !== undefined);
    if (needsPool) {
      const pool: string = route.pool;
      if (!routeId(pool) || pool !== request.go?.pool) {
        reject('go-pool-unverified');
        continue;
      }
      const shared = poolStatus?.(pool, go?.observedAt);
      if (shared !== 'clear') {
        reject(shared === 'held' ? 'go-pool-quota' : shared === 'stale' ? 'go-meter-before-reset' : 'go-pool-state-invalid');
        continue;
      }
    }
    const info = routeInfo(route, go, now);
    if (!info) {
      reject('upstream-or-model-metadata-unverified');
      continue;
    }
    if (!authorized(task, route, info, needsPool ? route.pool : undefined)) {
      reject(info.premium ? 'premium-not-approved' : 'route-or-data-not-authorized');
      continue;
    }
    if (info.tier < minimum) {
      reject('capability-under-floor');
      continue;
    }
    if (task.role === 'review') {
      const audit = auditReview(task.implementers, info);
      if (!audit.independent) {
        reject(audit.reason);
        continue;
      }
    }
    const effort = effortFor(route, task.effort, host.surface);
    if (effort === undefined) {
      reject('effort-unavailable');
      continue;
    }
    let estimate: number | null | undefined;
    if (info.goModel) {
      if (go?.extraUsage !== 'off' || go.account !== route.account) {
        reject('go-account-or-overage-unverified');
        continue;
      }
      if (pool.status !== 'available') {
        reject(`go-meter-${pool.status}`);
        continue;
      }
      estimate = estimateGoFraction(info.goModel, task.tokens);
      if (estimate === null) {
        reject('go-estimate-unavailable');
        continue;
      }
      if (estimate >= pool.remaining) {
        reject('go-insufficient-headroom');
        continue;
      }
      if (checkBudget && estimate > budget.maxMonthlyGoFraction) {
        reject('go-exceeds-approved-budget');
        continue;
      }
    }
    candidates.push({ key, route, info, effort, estimate });
  }
  const rank = (item: Candidate) => (item.info.premium ? 1 : 0);
  candidates.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.info.tier - b.info.tier ||
      (a.estimate ?? 0) - (b.estimate ?? 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const recent = go?.lastRequest;
  const recentModel = recent && goModel(go, recent.model, now);
  const reportedCharge = recentModel && normalizeGoCharge(recent.usage, recentModel, go.plan);
  const detail = { rejected, go: pool, ...(reportedCharge && { lastReportedGoCharge: reportedCharge }) };
  if (!candidates.length)
    return stop(task.role === 'review' ? 'external-review-pending' : 'no-eligible-route', {
      ...detail,
      next: nextAction(pool.status === 'exhausted' ? 'go-pool-quota' : null, task.role),
    });
  const { route, info, effort, estimate } = candidates[0];
  return {
    advisory: true,
    status: 'recommend',
    ...detail,
    reason: 'authorized-supported-lowest-tier-and-allowance',
    route: {
      provider: route.provider,
      model: route.model,
      canonicalModel: info.canonicalModel,
      family: info.family,
      ...(effort !== null && { reasoning_effort: effort }),
    },
    ...(estimate !== undefined && { estimatedMonthlyFraction: estimate }),
    next: 'Apply the recommendation through the native tool only after approval; verify the actual active model.',
  };
}
