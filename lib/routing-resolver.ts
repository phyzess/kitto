import { createHash } from 'node:crypto';
import { estimateRouteCostUsd, evaluatePricingWindow } from './routing-pricing.ts';
import { lookupBuiltinRoute, lookupCanonicalModel, parseCanonicalIdentity } from './routing-catalog.ts';
import { routeId, routeKey } from './routing-policy.ts';
import type { LocalRoutingOverrides, ModelPricing, ModelTier } from './routing-catalog.ts';
import type { PricingLabel, PricingWindowEvaluation } from './routing-pricing.ts';
import type { ProbeSnapshot, PoolProbeEntry } from './routing-probe.ts';
import type { PlanChoice, PlanInput, PlanQuestion, PlanRole } from './task-route-plan.ts';
import type { HostRoute, RouteRef, RouteSelection } from '../types/kitto.d.ts';

export type RoutingPolicyMode = 'balanced' | 'cost-first' | 'quality-first';
export type RoleKind = 'batch' | 'verify' | 'implement' | 'architect' | 'review';

export interface RoleTokenBudget {
  input: number;
  output: number;
  cacheHitRatio?: number;
  promptTokens?: number;
}

export interface ResolveRole extends PlanRole {
  roleKind?: RoleKind;
  minTier?: ModelTier;
  expectedTokens?: RoleTokenBudget;
  expectedDurationMinutes?: number;
  sessionStickyRoute?: RouteRef;
  allowAutoFailover?: boolean;
  allowMetered?: boolean;
  allowPremium?: boolean;
  maxUsd?: number;
  maxMonthlyGoFraction?: number;
}

export interface ResolvePlanInput extends Omit<PlanInput, 'roles'> {
  roles?: ResolveRole[];
  policy?: RoutingPolicyMode;
  autoFailover?: boolean;
  mode?: 'plan' | 'resolve';
  probe?: ProbeSnapshot;
}

export interface ResolvedFallbackOption {
  provider: string;
  model: string;
  canonicalModel?: string;
  family?: string;
  upstream?: string;
  billing?: string;
  pool?: string;
  effort: string;
  pricingLabel: PricingLabel;
  effectiveMultiplier: number;
  estimatedUsd?: number;
  longContextApplied?: boolean;
  requiresConfirmation: boolean;
  confirmationReason?: string;
  score: number;
  notes: string[];
}

export interface ResolvedSelectedRoute {
  provider: string;
  model: string;
  canonicalModel?: string;
  family?: string;
  upstream?: string;
  billing?: string;
  pool?: string;
  effort: string;
  pricingLabel: PricingLabel;
  effectiveMultiplier: number;
  estimatedUsd?: number;
  approvedUsd?: number;
  estimateOnly?: boolean;
  longContextApplied?: boolean;
  approvalKey: string;
}

export interface ResolvedPlanRow {
  id: string;
  status: 'ready' | 'auto-rerouted' | 'decision-required' | 'unavailable' | 'deferred';
  reason?: string;
  route?: ResolvedSelectedRoute;
  autoReroutedFrom?: RouteRef;
  rerouteReason?: string;
  fallbackChain: ResolvedFallbackOption[];
  rejected: Array<{ provider: string; model: string; reason: string }>;
  trace: string[];
  blockedBy?: string[];
}

export interface ResolvedTaskPlan {
  status: 'ready' | 'pending' | 'unavailable' | 'invalid';
  reason?: string;
  policy: RoutingPolicyMode;
  observedAt: string;
  pricingWindows: Record<string, PricingWindowEvaluation>;
  rows: ResolvedPlanRow[];
  ready: string[];
  questions: PlanQuestion[];
}

const SURFACES: Record<string, Set<string>> = {
  dsh: new Set(['teams', 'subagent']),
  pi: new Set(['current', 'subagent']),
  codex: new Set(['current', 'subagent']),
};
const DATA = new Set(['public', 'personal', 'internal', 'restricted']);
const BILLING = new Set(['subscription', 'go-included', 'metered']);
const EFFORTS = new Set(['default', 'none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const POLICIES: readonly RoutingPolicyMode[] = ['balanced', 'cost-first', 'quality-first'];
const ROLE_KINDS: readonly RoleKind[] = ['batch', 'verify', 'implement', 'architect', 'review'];
const ROLE_MIN_TIER: Record<RoleKind, ModelTier> = { batch: 0, verify: 0, implement: 1, architect: 1, review: 1 };
const ROLE_PRIORITY: Record<RoleKind, number> = { batch: 1, verify: 2, implement: 3, architect: 4, review: 5 };
const DEFAULT_ROLE_TOKENS: Record<RoleKind, RoleTokenBudget> = {
  batch: { input: 80_000, output: 4_000, cacheHitRatio: 0.85 },
  verify: { input: 80_000, output: 4_000, cacheHitRatio: 0.85 },
  implement: { input: 120_000, output: 12_000, cacheHitRatio: 0.85 },
  architect: { input: 120_000, output: 12_000, cacheHitRatio: 0.85 },
  review: { input: 40_000, output: 4_000, cacheHitRatio: 0.5 },
};
const STICKY_BONUS = -500;
const GO_MONTHLY_USD = 200;
const OBSERVED_TTL_MS = 300_000;

const exact = (route: unknown): route is RouteRef => {
  if (typeof route !== 'object' || route === null) return false;
  const { provider, model } = route as { provider?: unknown; model?: unknown };
  return routeId(provider) && !provider.includes('/') && routeId(model);
};
const sameRoute = (a: unknown, b: unknown) => exact(a) && exact(b) && a.provider === b.provider && a.model === b.model;
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const digest = (fields: unknown[]) => createHash('sha256').update(JSON.stringify(fields)).digest('hex');

function inferRoleKind(id: string): RoleKind {
  const value = id.toLowerCase();
  if (value.includes('review')) return 'review';
  if (value.includes('verify') || value.includes('test')) return 'verify';
  if (value.includes('batch') || value.includes('scan')) return 'batch';
  if (value.includes('architect') || value.includes('plan') || value.includes('spec')) return 'architect';
  return 'implement';
}

function validIdentity(value: unknown): boolean {
  if (value === undefined) return true;
  const item = asRecord(value);
  if (!item) return false;
  return (item.canonicalModel === undefined || routeId(item.canonicalModel)) && (item.family === undefined || routeId(item.family));
}

function validTokens(value: unknown): boolean {
  if (value === undefined) return true;
  const item = asRecord(value);
  if (!item) return false;
  return (
    nonnegative(item.input) &&
    nonnegative(item.output) &&
    (item.cacheHitRatio === undefined || (nonnegative(item.cacheHitRatio) && item.cacheHitRatio <= 1)) &&
    (item.promptTokens === undefined || nonnegative(item.promptTokens))
  );
}

function validRole(role: ResolveRole): boolean {
  return (
    routeId(role?.id) &&
    routeId(role.workRevision) &&
    DATA.has(role.data) &&
    ['read', 'write'].includes(role.effects) &&
    Array.isArray(role.dependencies) &&
    new Set(role.dependencies).size === role.dependencies.length &&
    role.dependencies.every(routeId) &&
    (role.choice === undefined || role.choice === 'defer' || exact(role.choice)) &&
    (role.effort === undefined || EFFORTS.has(role.effort)) &&
    (role.failed === undefined || (Array.isArray(role.failed) && role.failed.every(exact))) &&
    (role.implementers === undefined || (Array.isArray(role.implementers) && role.implementers.every(validIdentity))) &&
    (role.reviewGate === undefined || role.reviewGate === 'independent') &&
    (role.roleKind === undefined || (ROLE_KINDS as readonly string[]).includes(role.roleKind)) &&
    (role.minTier === undefined || (Number.isInteger(role.minTier) && role.minTier >= 0 && role.minTier <= 2)) &&
    validTokens(role.expectedTokens) &&
    (role.expectedDurationMinutes === undefined || nonnegative(role.expectedDurationMinutes)) &&
    (role.sessionStickyRoute === undefined || exact(role.sessionStickyRoute)) &&
    (role.allowAutoFailover === undefined || typeof role.allowAutoFailover === 'boolean') &&
    (role.allowMetered === undefined || typeof role.allowMetered === 'boolean') &&
    (role.allowPremium === undefined || typeof role.allowPremium === 'boolean') &&
    (role.maxUsd === undefined || nonnegative(role.maxUsd)) &&
    (role.maxMonthlyGoFraction === undefined || (nonnegative(role.maxMonthlyGoFraction) && role.maxMonthlyGoFraction <= 1))
  );
}

function invalidPlan(policy: RoutingPolicyMode, observedAt: string): ResolvedTaskPlan {
  return {
    status: 'invalid',
    reason: 'invalid-plan-or-native-surface',
    policy,
    observedAt,
    pricingWindows: {},
    rows: [],
    ready: [],
    questions: [],
  };
}

function poolEntry(route: HostRoute, probe: ProbeSnapshot | null): { key: string; entry: PoolProbeEntry } | null {
  const pools = probe?.pools;
  if (!pools) return null;
  const candidates = [route.pool ?? '', `${route.upstream}:${route.pool}`, route.upstream ?? '', route.provider];
  for (const key of candidates) {
    if (!key || !Object.hasOwn(pools, key)) continue;
    const entry = pools[key];
    if (entry) return { key, entry };
  }
  return null;
}

const poolKeyOf = (route: HostRoute): string => route.pool ?? route.upstream ?? route.provider;

interface CanonicalInfo {
  canonicalModel?: string;
  family?: string;
  tier?: ModelTier;
  premium: boolean;
  pricing: ModelPricing | null;
}

function canonicalInfo(route: HostRoute): CanonicalInfo {
  const declared = parseCanonicalIdentity(route.canonicalModel);
  const entry = lookupCanonicalModel(route.canonicalModel) ?? lookupBuiltinRoute(route.upstream ?? route.provider, route.model);
  const declaredTier = route.tier === 0 || route.tier === 1 || route.tier === 2 ? route.tier : undefined;
  const canonicalModel = entry?.canonicalId ?? declared?.canonicalModel;
  const declaredFamily = routeId(route.family) ? route.family.toLowerCase() : undefined;
  const family = entry?.family ?? declared?.family ?? declaredFamily;
  const tier = entry?.tier ?? declaredTier;
  return {
    ...(canonicalModel && { canonicalModel }),
    ...(family && { family }),
    ...(tier !== undefined && { tier }),
    premium: entry?.premium ?? route.premium === true,
    pricing: entry?.pricing ?? null,
  };
}

interface Candidate {
  route: HostRoute;
  effort: string;
  canonicalModel?: string;
  family?: string;
  tier?: ModelTier;
  premium: boolean;
  pricingLabel: PricingLabel;
  effectiveMultiplier: number;
  estimatedUsd?: number;
  longContextApplied: boolean;
  requiresConfirmation: boolean;
  confirmationReason?: string;
  score: number;
  notes: string[];
  peakPenalized: boolean;
  poolTight: boolean;
  poolKey: string;
  probeKey?: string;
  option: ResolvedFallbackOption;
}

interface WorkingRow {
  role: ResolveRole;
  roleKind: RoleKind;
  expected?: RouteRef;
  candidates: Candidate[];
  rejected: Array<{ provider: string; model: string; reason: string }>;
  best: Candidate | null;
  previousBest: Candidate | null;
  rerouteReason?: string;
  trace: string[];
}

function authorizedUsd(role: ResolveRole, bound: boolean): number | undefined {
  if (bound && nonnegative(role.authorization?.maxUsd)) return role.authorization?.maxUsd;
  return nonnegative(role.maxUsd) ? role.maxUsd : undefined;
}

function authBound(role: ResolveRole, route: HostRoute): boolean {
  const authorization: RouteSelection | undefined = role.authorization;
  return (
    exact(authorization) &&
    sameRoute(authorization, route) &&
    authorization.upstream === route.upstream &&
    authorization.account === route.account &&
    authorization.billing === route.billing &&
    authorization.data === role.data
  );
}

function reviewedIndependently(role: ResolveRole, info: CanonicalInfo): boolean {
  if (!routeId(info.canonicalModel) || !routeId(info.family)) return false;
  if (!role.implementers?.length) return false;
  return !role.implementers.some((item) => {
    const canonical = typeof item?.canonicalModel === 'string' ? item.canonicalModel.toLowerCase() : null;
    const family = typeof item?.family === 'string' ? item.family.toLowerCase() : null;
    if (!canonical || !family) return true;
    return canonical === info.canonicalModel || family === info.family;
  });
}

function roleEffort(role: ResolveRole, route: HostRoute): string {
  const choice = role.choice;
  if (
    choice !== undefined &&
    choice !== 'defer' &&
    sameRoute(choice, route) &&
    typeof choice.effort === 'string' &&
    EFFORTS.has(choice.effort)
  )
    return choice.effort;
  return role.effort ?? 'default';
}

function candidateScore(
  role: ResolveRole,
  roleKind: RoleKind,
  policy: RoutingPolicyMode,
  route: HostRoute,
  info: CanonicalInfo,
  estimatedUsd: number | undefined,
  pricingEval: PricingWindowEvaluation,
  health: PoolProbeEntry | null,
  longContextApplied: boolean,
  expected: RouteRef | undefined,
): { score: number; notes: string[]; peakPenalized: boolean; poolTight: boolean } {
  const peakPenalized = pricingEval.effectiveMultiplier > 1;
  const poolTight = health?.health.tight === true;
  const notes: string[] = [];
  let score = estimatedUsd ?? (info.tier === 0 ? 0.05 : info.tier === 1 ? 0.5 : 1.5);
  if (peakPenalized) {
    if (roleKind === 'batch' || roleKind === 'verify') score += 100;
    else if (roleKind === 'review') score += 2;
    else score += policy === 'quality-first' ? 5 : 20;
  }
  if (exact(role.sessionStickyRoute) && sameRoute(role.sessionStickyRoute, route)) {
    score += STICKY_BONUS;
    notes.push('sticky-session-preserved');
  }
  if (poolTight) {
    if (roleKind === 'batch' || roleKind === 'verify') score += 10;
    else if (roleKind === 'review') score += 1;
    else score += 3;
    notes.push('pool-pressure-tight');
  }
  if (longContextApplied) {
    score += 15;
    notes.push('long-context-doubled');
  }
  const tier = info.tier ?? 0;
  if (policy === 'cost-first') score += tier * 1.5;
  else if (policy === 'quality-first') score -= tier * 2;
  else {
    if (info.premium) score += 5;
    if (route.billing === 'go-included' && tier >= 1) score += 0.1;
  }
  if (expected && sameRoute(expected, route) && !peakPenalized && !poolTight) score -= 0.5;
  return { score, notes, peakPenalized, poolTight };
}

function tokenBudget(role: ResolveRole, roleKind: RoleKind): RoleTokenBudget {
  return role.expectedTokens ?? DEFAULT_ROLE_TOKENS[roleKind];
}

export function resolveTaskRoutes(
  input: ResolvePlanInput | null | undefined,
  options: { probe?: ProbeSnapshot | null; overrides?: LocalRoutingOverrides | null; now?: number } = {},
): ResolvedTaskPlan {
  const now = options.now ?? Date.now();
  const policy = input?.policy ?? 'balanced';
  const observedAt = Number.isFinite(now) ? new Date(now).toISOString() : new Date(0).toISOString();
  const host = input?.host,
    roles = input?.roles,
    presets = input?.presets ?? {};
  const observed = Date.parse(host?.observedAt ?? '');
  if (
    !Number.isFinite(now) ||
    !(POLICIES as readonly string[]).includes(policy) ||
    !routeId(input?.id) ||
    !host?.kind ||
    !Object.hasOwn(SURFACES, host.kind) ||
    !host.surface ||
    !SURFACES[host.kind].has(host.surface) ||
    !routeId(host.session) ||
    !Array.isArray(host.routes) ||
    !host.routes.every((route) => exact(route) && (route.efforts === undefined || Array.isArray(route.efforts))) ||
    !Array.isArray(roles) ||
    !roles.length ||
    !roles.every(validRole) ||
    !asRecord(presets) ||
    Array.isArray(presets) ||
    (input?.mode !== undefined && !['plan', 'resolve'].includes(input.mode)) ||
    (input?.autoFailover !== undefined && typeof input.autoFailover !== 'boolean') ||
    (input?.probe !== undefined && asRecord(input.probe) === null)
  )
    return invalidPlan(policy, observedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > OBSERVED_TTL_MS) {
    return {
      status: 'unavailable',
      reason: 'native-evidence-stale',
      policy,
      observedAt,
      pricingWindows: {},
      rows: [],
      ready: [],
      questions: [],
    };
  }
  const byId = new Map<string, ResolveRole>(roles.map((role): [string, ResolveRole] => [role.id, role]));
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function acyclic(role: ResolveRole): boolean {
    if (visiting.has(role.id)) return false;
    if (visited.has(role.id)) return true;
    visiting.add(role.id);
    if (!role.dependencies.every((dep: string) => byId.has(dep) && acyclic(byId.get(dep)!))) return false;
    visiting.delete(role.id);
    visited.add(role.id);
    return true;
  }
  if (byId.size !== roles.length || !roles.every(acyclic)) return { ...invalidPlan(policy, observedAt), reason: 'invalid-task-graph' };

  const probe = options.probe ?? input?.probe ?? null;
  const holidayOverrides = options.overrides?.holidayOverrides ?? [];
  const globalAutoFailover = input?.autoFailover !== false;
  const counts = new Map<string, number>();
  for (const route of host.routes) counts.set(routeKey(route), (counts.get(routeKey(route)) ?? 0) + 1);
  const pricingWindows: Record<string, PricingWindowEvaluation> = { ...(probe?.pricingWindows ?? {}) };
  const working: WorkingRow[] = [];

  for (const role of roles) {
    const roleKind = role.roleKind ?? inferRoleKind(role.id);
    const expected: RouteRef | undefined =
      role.choice === 'defer'
        ? undefined
        : (role.choice ??
          (Object.hasOwn(presets, role.id) ? presets[role.id] : undefined) ??
          (host.surface === 'current' && exact(host.current) ? host.current : undefined));
    const row: WorkingRow = {
      role,
      roleKind,
      ...(expected && { expected }),
      candidates: [],
      rejected: [],
      best: null,
      previousBest: null,
      trace: [],
    };
    working.push(row);
    if (role.choice === 'defer') continue;
    const minTier = Math.max(ROLE_MIN_TIER[roleKind], role.minTier ?? 0);
    const tokens = tokenBudget(role, roleKind);
    const candidates: Candidate[] = [];
    for (const route of host.routes) {
      const reject = (reason: string) => row.rejected.push({ provider: route.provider, model: route.model, reason });
      if (counts.get(routeKey(route)) !== 1) {
        reject('ambiguous-native-route');
        continue;
      }
      if (route.available !== true) {
        reject('host-route-unavailable');
        continue;
      }
      if (host.surface !== 'current' && route.dispatchable !== true) {
        reject('host-cannot-select-route');
        continue;
      }
      if (host.surface !== 'current' && route.fallback !== 'none') {
        reject('effective-fallback-unverified');
        continue;
      }
      if (route.dataAllowed === false || (Array.isArray(route.allowedData) && !route.allowedData.includes(role.data))) {
        reject('project-or-account-data-policy');
        continue;
      }
      if (
        role.failed?.some(
          (previous: RouteSelection) =>
            sameRoute(previous, route) ||
            (previous.kind === 'authorization' && previous.upstream === route.upstream && previous.account === route.account),
        )
      ) {
        reject('failed-route-or-account');
        continue;
      }
      const info = canonicalInfo(route);
      if (info.tier !== undefined && info.tier < minTier) {
        reject('capability-under-floor');
        continue;
      }
      if (role.reviewGate === 'independent' && !reviewedIndependently(role, info)) {
        const identitiesKnown =
          routeId(info.canonicalModel) &&
          routeId(info.family) &&
          (role.implementers ?? []).every((item) => routeId(item?.canonicalModel) && routeId(item?.family));
        reject(identitiesKnown ? 'not-independent' : 'independence-unverified');
        continue;
      }
      const effort = roleEffort(role, route);
      if (!EFFORTS.has(effort) || (effort !== 'default' && !route.efforts?.includes(effort))) {
        reject('unsupported-effort');
        continue;
      }
      const matched = poolEntry(route, probe);
      const entry = matched?.entry ?? null;
      const health = entry?.health ?? null;
      if (health && health.available === false) {
        if (health.status === 'auth-broken') reject('pool-auth-broken');
        else if (health.status === 'held-outage') reject('pool-held-outage');
        else if (health.status === 'held-quota') reject(`pool-held-quota:${health.window ?? 'unknown'}`);
        else reject('pool-unavailable');
        continue;
      }
      if (route.billing === 'go-included') {
        const meterReady = health?.available === true && (entry?.goMeter?.status === 'available' || entry?.probeMode === 'active-api');
        if (route.quotaReady === false || (route.quotaReady !== true && !meterReady)) {
          reject('go-quota-unverified-or-unavailable');
          continue;
        }
      }
      const pricingEval =
        info.canonicalModel && probe?.pricingWindows[info.canonicalModel] && role.expectedDurationMinutes === undefined
          ? probe.pricingWindows[info.canonicalModel]
          : evaluatePricingWindow(info.canonicalModel ?? '', now, {
              ...(role.expectedDurationMinutes !== undefined && { expectedDurationMinutes: role.expectedDurationMinutes }),
              holidayOverrides,
            });
      if (info.canonicalModel && !Object.hasOwn(pricingWindows, info.canonicalModel)) pricingWindows[info.canonicalModel] = pricingEval;
      const estimate = info.pricing ? estimateRouteCostUsd(info.pricing, tokens, pricingEval.effectiveMultiplier) : null;
      const estimatedUsd = nonnegative(route.estimateUsd) ? route.estimateUsd : estimate?.usd;
      const longContextApplied = estimate?.longContextApplied === true;
      const verified =
        routeId(route.upstream) &&
        routeId(route.account) &&
        route.accountVerified === true &&
        typeof route.billing === 'string' &&
        BILLING.has(route.billing);
      const bound = authBound(role, route);
      let requiresConfirmation = false;
      let confirmationReason: string | undefined;
      const confirm = (reason: string) => {
        if (requiresConfirmation) return;
        requiresConfirmation = true;
        confirmationReason = reason;
      };
      if (!verified) confirm('verify-account-and-billing');
      if (route.dataAllowed !== true) confirm('verify-data-policy');
      if (route.billing === 'metered') {
        const approvedUsd = authorizedUsd(role, bound);
        const allowed =
          role.allowMetered === true ||
          (approvedUsd !== undefined && approvedUsd > 0 && estimatedUsd !== undefined && estimatedUsd <= approvedUsd);
        if (!allowed) confirm('metered-cost-not-authorized');
      }
      if (info.premium) {
        const allowed = role.allowPremium === true || (bound && role.authorization?.premium === true);
        if (!allowed) confirm('premium-not-approved');
      }
      if (route.nativeSelectionRequired === true) confirm('select-in-native-host');
      if (host.surface === 'current' && effort !== 'default' && route.nativeEffort !== effort) confirm('set-effort-in-native-host');
      if (!requiresConfirmation && route.billing !== 'metered') {
        const boundary = route.billing === 'subscription' || route.billing === 'go-included';
        const auto = globalAutoFailover && role.allowAutoFailover !== false;
        if (!(boundary && (bound || auto))) confirm('route-authorization-required');
      }
      const scored = candidateScore(role, roleKind, policy, route, info, estimatedUsd, pricingEval, entry, longContextApplied, expected);
      const option: ResolvedFallbackOption = {
        provider: route.provider,
        model: route.model,
        ...(info.canonicalModel && { canonicalModel: info.canonicalModel }),
        ...(info.family && { family: info.family }),
        ...(route.upstream && { upstream: route.upstream }),
        ...(route.billing && { billing: route.billing }),
        ...(route.pool && { pool: route.pool }),
        effort,
        pricingLabel: pricingEval.label,
        effectiveMultiplier: pricingEval.effectiveMultiplier,
        ...(estimatedUsd !== undefined && { estimatedUsd }),
        ...(longContextApplied && { longContextApplied }),
        requiresConfirmation,
        ...(confirmationReason && { confirmationReason }),
        score: scored.score,
        notes: scored.notes,
      };
      candidates.push({
        route,
        effort,
        ...(info.canonicalModel && { canonicalModel: info.canonicalModel }),
        ...(info.family && { family: info.family }),
        ...(info.tier !== undefined && { tier: info.tier }),
        premium: info.premium,
        pricingLabel: pricingEval.label,
        effectiveMultiplier: pricingEval.effectiveMultiplier,
        ...(estimatedUsd !== undefined && { estimatedUsd }),
        longContextApplied,
        requiresConfirmation,
        ...(confirmationReason && { confirmationReason }),
        score: scored.score,
        notes: scored.notes,
        peakPenalized: scored.peakPenalized,
        poolTight: scored.poolTight,
        poolKey: poolKeyOf(route),
        ...(matched && { probeKey: matched.key }),
        option,
      });
    }
    candidates.sort(
      (a, b) =>
        Number(a.requiresConfirmation) - Number(b.requiresConfirmation) ||
        a.score - b.score ||
        a.route.provider.localeCompare(b.route.provider) ||
        a.route.model.localeCompare(b.route.model),
    );
    row.candidates = candidates;
    row.best = candidates[0] ?? null;
  }

  const assigned = (key: string) =>
    working.filter((row) => {
      const best = row.best;
      const identity = best?.probeKey ?? best?.poolKey;
      return best !== null && !best.requiresConfirmation && row.role.choice !== 'defer' && identity === key;
    });
  const contribution = (row: WorkingRow): number => {
    if (row.role.maxMonthlyGoFraction !== undefined) return row.role.maxMonthlyGoFraction;
    return row.best?.estimatedUsd !== undefined ? row.best.estimatedUsd / GO_MONTHLY_USD : 0;
  };
  for (const [key, entry] of Object.entries(probe?.pools ?? {})) {
    const meter = entry.goMeter;
    const tighten = entry.health.tight === true;
    const overHeadroom = (): boolean => {
      const rows = assigned(key);
      if (!rows.length) return false;
      if (meter?.status === 'available') return rows.reduce((sum, row) => sum + contribution(row), 0) > meter.remaining;
      return tighten && rows.length > 1;
    };
    if (!overHeadroom()) continue;
    const order = [...working].sort((a, b) => ROLE_PRIORITY[a.roleKind] - ROLE_PRIORITY[b.roleKind] || a.role.id.localeCompare(b.role.id));
    for (const row of order) {
      if (!overHeadroom()) break;
      if (!assigned(key).includes(row) || !row.best) continue;
      const alternative = row.candidates.find(
        (candidate) =>
          candidate !== row.best &&
          !candidate.requiresConfirmation &&
          candidate.poolKey !== key &&
          candidate.probeKey !== key &&
          probe?.pools[candidate.probeKey ?? candidate.poolKey]?.health.tight !== true &&
          probe?.pools[candidate.probeKey ?? candidate.poolKey]?.health.available !== false,
      );
      if (!alternative) continue;
      row.previousBest = row.best;
      row.best = alternative;
      row.rerouteReason = 'pool-headroom-reallocated';
      row.trace.push('pool-headroom-reallocated');
    }
  }

  const rows: ResolvedPlanRow[] = working.map((row): ResolvedPlanRow => {
    if (row.role.choice === 'defer') return { id: row.role.id, status: 'deferred', fallbackChain: [], rejected: [], trace: [] };
    const best = row.best;
    const fallbackChain =
      best && !best.requiresConfirmation
        ? row.candidates.filter((candidate) => candidate !== best).map((candidate) => candidate.option)
        : row.candidates.map((candidate) => candidate.option);
    if (!best)
      return {
        id: row.role.id,
        status: 'unavailable',
        reason: row.role.reviewGate === 'independent' ? 'external-review-pending' : 'no-eligible-route',
        fallbackChain,
        rejected: row.rejected,
        trace: row.trace,
      };
    const trace = [...new Set([...row.trace, ...best.notes])];
    if (best.peakPenalized && !row.candidates.some((candidate) => !candidate.peakPenalized)) trace.push('peak-fallback-only');
    const expected = row.expected;
    const bypassed = expected !== undefined && !sameRoute(expected, best.route);
    const route = selectedRoute(row.role, host, input?.id ?? '', best);
    if (!best.requiresConfirmation) {
      if (row.rerouteReason) {
        return {
          id: row.role.id,
          status: 'auto-rerouted',
          route,
          ...(row.previousBest && { autoReroutedFrom: { provider: row.previousBest.route.provider, model: row.previousBest.route.model } }),
          rerouteReason: row.rerouteReason,
          fallbackChain,
          rejected: row.rejected,
          trace,
        };
      }
      if (bypassed && expected) {
        const rejectedExpected = row.rejected.find((item) => sameRoute(item, expected));
        const expectedCandidate = row.candidates.find((candidate) => sameRoute(candidate.route, expected));
        const rerouteReason = rejectedExpected
          ? rejectedExpected.reason
          : !expectedCandidate
            ? 'expected-route-not-offered'
            : expectedCandidate.peakPenalized
              ? 'deepseek-peak-avoided'
              : expectedCandidate.poolTight
                ? 'pool-pressure-tight'
                : 'higher-priority-policy-route';
        return {
          id: row.role.id,
          status: 'auto-rerouted',
          route,
          autoReroutedFrom: { provider: expected.provider, model: expected.model },
          rerouteReason,
          fallbackChain,
          rejected: row.rejected,
          trace,
        };
      }
      return { id: row.role.id, status: 'ready', route, fallbackChain, rejected: row.rejected, trace };
    }
    return {
      id: row.role.id,
      status: 'decision-required',
      reason: best.confirmationReason ?? 'route-confirmation-required',
      fallbackChain,
      rejected: row.rejected,
      trace,
    };
  });

  const runnable = (row: ResolvedPlanRow): boolean => row.status === 'ready' || row.status === 'auto-rerouted';
  const resultById = new Map<string, ResolvedPlanRow>(rows.map((row): [string, ResolvedPlanRow] => [row.id, row]));
  const dependencyBlocks = new Map<string, string[]>();
  function blocked(role: ResolveRole): string[] {
    if (!dependencyBlocks.has(role.id)) {
      dependencyBlocks.set(
        role.id,
        role.dependencies.filter((id: string) => {
          const dependency = resultById.get(id)!;
          return !runnable(dependency) || blocked(byId.get(id)!).length > 0;
        }),
      );
    }
    return dependencyBlocks.get(role.id)!;
  }
  for (const row of rows) {
    const dependencies = blocked(byId.get(row.id)!);
    if (dependencies.length) row.blockedBy = dependencies;
  }
  const questions: PlanQuestion[] = rows
    .filter((row) => row.status === 'decision-required')
    .map((row) => {
      const workingRow = working.find((item) => item.role.id === row.id)!;
      const options: PlanChoice[] = workingRow.candidates.map((candidate) => ({
        provider: candidate.route.provider,
        model: candidate.route.model,
        ...(candidate.option.billing && { billing: candidate.option.billing }),
        ...(candidate.option.upstream && { upstream: candidate.option.upstream }),
        ...(candidate.option.estimatedUsd !== undefined && { estimateUsd: candidate.option.estimatedUsd, estimateOnly: true }),
        status: candidate.requiresConfirmation ? 'decision-required' : 'ready',
        reason: candidate.confirmationReason ?? 'authorized',
      }));
      return { id: row.id, ...(row.reason && { reason: row.reason }), options };
    });
  const status: ResolvedTaskPlan['status'] =
    rows.length && rows.every(runnable)
      ? 'ready'
      : rows.length && rows.every((row) => row.status === 'unavailable')
        ? 'unavailable'
        : 'pending';
  return {
    status,
    policy,
    observedAt,
    pricingWindows,
    rows,
    ready: rows.filter((row) => runnable(row) && !row.blockedBy).map((row) => row.id),
    questions,
  };
}

function selectedRoute(role: ResolveRole, host: PlanInput['host'], planId: string, candidate: Candidate): ResolvedSelectedRoute {
  const route = candidate.route;
  const approvalKey = digest([
    planId,
    host?.kind ?? null,
    host?.surface ?? null,
    host?.session ?? null,
    role.id,
    role.workRevision,
    role.effects,
    role.data,
    role.dependencies,
    role.reviewGate ?? null,
    role.implementers ?? null,
    route.provider,
    route.model,
    route.canonicalModel ?? null,
    route.family ?? null,
    route.upstream ?? null,
    route.account ?? null,
    route.billing ?? null,
    candidate.effort,
    route.nativeEffort ?? null,
    candidate.estimatedUsd ?? null,
    route.billing === 'metered' ? (role.authorization?.maxUsd ?? null) : null,
  ]);
  const approvedUsd = route.billing === 'metered' ? authorizedUsd(role, authBound(role, route)) : undefined;
  return {
    provider: route.provider,
    model: route.model,
    ...(candidate.canonicalModel && { canonicalModel: candidate.canonicalModel }),
    ...(candidate.family && { family: candidate.family }),
    ...(route.upstream && { upstream: route.upstream }),
    ...(route.billing && { billing: route.billing }),
    ...(route.pool && { pool: route.pool }),
    effort: candidate.effort,
    pricingLabel: candidate.pricingLabel,
    effectiveMultiplier: candidate.effectiveMultiplier,
    ...(candidate.estimatedUsd !== undefined && { estimatedUsd: candidate.estimatedUsd }),
    ...(approvedUsd !== undefined && { approvedUsd, estimateOnly: true }),
    ...(candidate.longContextApplied && { longContextApplied: true }),
    approvalKey,
  };
}
