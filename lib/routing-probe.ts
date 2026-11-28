import { goMeter, timestamp } from './go-allowance.ts';
import { kittoHome } from './kitto-home.ts';
import { BUILTIN_PRICING_SCHEDULES, evaluatePricingWindow } from './routing-pricing.ts';
import { createPoolHealthStore, writeProbeCache } from './routing-pool-health.ts';
import { isSupportedUpstream, loadLocalRoutingOverrides } from './routing-catalog.ts';
import { routeId } from './routing-policy.ts';
import type { GoMeter } from './go-allowance.ts';
import type { PoolSoftBudget, UpstreamId } from './routing-catalog.ts';
import type { PricingWindowEvaluation } from './routing-pricing.ts';
import type { EffectivePoolHealth, PoolProbeResultInput, PoolHealthStore, QuotaWindowKind } from './routing-pool-health.ts';
import type { GoUsage } from '../types/kitto.d.ts';

export type PoolProbeMode = 'active-api' | 'passive-only' | 'skipped-offline' | 'missing-credential' | 'probe-error';

export interface LocalUsageSummary {
  rolling5hUsd?: number;
  weeklyUsd?: number;
  rolling5hRequests?: number;
  weeklyRequests?: number;
}

export interface PoolProbeEntry {
  pool: string;
  upstream: UpstreamId;
  probeMode: PoolProbeMode;
  health: EffectivePoolHealth;
  goMeter?: GoMeter;
  balanceAvailable?: boolean;
  creditRemainingRatio?: number;
  burnRateTight?: boolean;
  detail?: string;
}

export interface ProbeSnapshot {
  schema: 1;
  observedAt: string;
  networkUsed: boolean;
  pricingWindows: Record<string, PricingWindowEvaluation>;
  pools: Record<string, PoolProbeEntry>;
  warnings: string[];
}

export interface ProbePoolTarget {
  pool: string;
  upstream: UpstreamId;
}

export interface RunProbeOptions {
  kittoHomePath?: string;
  pools?: readonly ProbePoolTarget[];
  allowNetwork?: boolean;
  writeCache?: boolean;
  now?: number;
  timeoutMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  localUsage?: Record<string, LocalUsageSummary>;
  holidayOverrides?: readonly string[];
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

type ReadJson = { ok: true; status: number; value: unknown } | { ok: false; status?: number; reason: string };

interface ProbeOutcome {
  probeMode: PoolProbeMode;
  networkUsed: boolean;
  extra: Partial<PoolProbeEntry>;
  warnings: string[];
}

interface PoolContext {
  pool: string;
  upstream: UpstreamId;
  store: PoolHealthStore;
  now: number;
  fetcher: Fetcher;
  env: Record<string, string | undefined>;
  timeoutMs: number;
}

const DEFAULT_POOLS: readonly ProbePoolTarget[] = [
  { pool: 'opencode-go', upstream: 'opencode-go' },
  { pool: 'openai-codex', upstream: 'openai-codex' },
  { pool: 'deepseek-official', upstream: 'deepseek-official' },
  { pool: 'anthropic', upstream: 'anthropic' },
  { pool: 'openrouter', upstream: 'openrouter' },
];

const PASSIVE_UPSTREAMS: ReadonlySet<UpstreamId> = new Set(['openai-codex', 'anthropic']);
const GO_USAGE_URL = 'https://opencode.ai/inference/go/v1/usage';
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';
const MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const CREDENTIAL = /^[a-zA-Z0-9_.~-]{1,1024}$/;
const BURN_RATE_RATIO = 0.8;
const MIN_CREDIT_RATIO = 0.15;
const GO_WINDOW_THRESHOLDS: readonly (readonly [string, number])[] = [
  ['rolling', 80],
  ['weekly', 85],
  ['monthly', 90],
];
const GO_WINDOW_KINDS: Record<string, QuotaWindowKind> = { rolling: 'rolling', weekly: 'weekly', monthly: 'monthly' };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function consumeBody(response: Response): Promise<string | null> {
  return (async (): Promise<string | null> => {
    if (!response.body) return null;
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return null;
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0,
      text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        return null;
      }
    }
    try {
      return text + decoder.decode();
    } catch {
      return null;
    }
  })();
}

async function projectResponse(response: Response): Promise<ReadJson> {
  if (response.redirected || (response.status >= 300 && response.status < 400))
    return { ok: false, status: response.status, reason: 'probe-redirect' };
  if (response.status === 401 || response.status === 403) return { ok: false, status: response.status, reason: 'probe-http-auth-error' };
  if (response.status !== 200) return { ok: false, status: response.status, reason: 'probe-http-error' };
  const text = await consumeBody(response);
  if (text === null) return { ok: false, reason: 'probe-invalid-json' };
  try {
    return { ok: true, status: 200, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'probe-invalid-json' };
  }
}

async function readJson(fetcher: Fetcher, url: string, headers: Record<string, string>, timeoutMs: number): Promise<ReadJson> {
  const controller = new AbortController();
  const bounded = Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, timeoutMs));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = async (): Promise<ReadJson> => {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
      });
      return await projectResponse(response);
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'probe-timeout' : 'probe-transport-error' };
    }
  };
  try {
    const deadline = new Promise<ReadJson>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: 'probe-timeout' });
      }, bounded);
    });
    return await Promise.race([deadline, request()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function credential(env: Record<string, string | undefined>, upstream: UpstreamId): string | null {
  const raw =
    upstream === 'opencode-go'
      ? (env.KITTO_GO_METADATA_KEY ?? env.OPENCODE_GO_API_KEY)
      : upstream === 'deepseek-official'
        ? env.DEEPSEEK_API_KEY
        : upstream === 'openrouter'
          ? env.OPENROUTER_API_KEY
          : undefined;
  return typeof raw === 'string' && CREDENTIAL.test(raw) ? raw : null;
}

function goWindowPercent(usage: unknown, name: string): number | undefined {
  const percent = at(usage, name, 'percent');
  return typeof percent === 'number' && Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : undefined;
}

function tightWindow(usage: unknown): { window: QuotaWindowKind; ratio: number } | null {
  let best: { window: QuotaWindowKind; ratio: number } | null = null;
  for (const [name, threshold] of GO_WINDOW_THRESHOLDS) {
    const percent = goWindowPercent(usage, name);
    if (percent === undefined || percent < threshold) continue;
    const ratio = percent / threshold;
    if (!best || ratio > best.ratio) best = { window: GO_WINDOW_KINDS[name] ?? 'unknown', ratio };
  }
  return best;
}

function safeEffective(context: PoolContext): EffectivePoolHealth {
  try {
    return context.store.getEffective(context.pool, context.upstream, context.now);
  } catch {
    return {
      pool: context.pool,
      upstream: context.upstream,
      status: 'needs-reprobe',
      available: false,
      tight: false,
      needsReprobe: true,
      reason: 'pool-health-state-invalid',
    };
  }
}

function writeProbe(context: PoolContext, result: Omit<PoolProbeResultInput, 'pool' | 'upstream'>): void {
  context.store.recordProbeResult({ ...result, pool: context.pool, upstream: context.upstream }, context.now);
}

function activeOutcome(context: PoolContext, result: ReadJson): ProbeOutcome {
  if (!result.ok && (result.status === 401 || result.status === 403)) {
    writeProbe(context, { status: 'auth-broken', reason: 'probe-http-auth-error' });
    return { probeMode: 'active-api', networkUsed: true, extra: {}, warnings: [] };
  }
  if (!result.ok) {
    return {
      probeMode: 'probe-error',
      networkUsed: true,
      extra: { detail: result.reason },
      warnings: [`probe-error:${context.pool}:${result.reason}`],
    };
  }
  if (context.upstream === 'opencode-go') return goOutcome(context, result.value);
  if (context.upstream === 'deepseek-official') return deepseekOutcome(context, result.value);
  return openrouterOutcome(context, result.value);
}

function goOutcome(context: PoolContext, value: unknown): ProbeOutcome {
  const usage = at(value, 'usage');
  if (!asRecord(usage)) return invalidPayload(context, 'probe-invalid-usage');
  const meter = goMeter({ usage: usage as GoUsage, observedAt: new Date(context.now).toISOString() }, context.now);
  if (meter.status === 'exhausted') {
    const longest = meter.windows.reduce((a, b) => (timestamp(b.resetsAt) > timestamp(a.resetsAt) ? b : a));
    writeProbe(context, {
      status: 'held-quota',
      window: GO_WINDOW_KINDS[longest.name] ?? 'unknown',
      resetsAt: longest.resetsAt,
      reason: 'quota-limit-reached',
    });
    return { probeMode: 'active-api', networkUsed: true, extra: { goMeter: meter }, warnings: [] };
  }
  if (meter.status === 'available') {
    const tight = tightWindow(usage);
    if (tight) {
      writeProbe(context, { status: 'tight', window: tight.window, resetsAt: meter.resetsAt, reason: 'quota-window-pressure-high' });
      return { probeMode: 'active-api', networkUsed: true, extra: { goMeter: meter }, warnings: [] };
    }
    writeProbe(context, { status: 'healthy', resetsAt: meter.resetsAt, reason: 'probe-usage-within-limits' });
    return { probeMode: 'active-api', networkUsed: true, extra: { goMeter: meter }, warnings: [] };
  }
  return invalidPayload(context, `probe-${meter.status}-usage`);
}

function deepseekOutcome(context: PoolContext, value: unknown): ProbeOutcome {
  const available = at(value, 'is_available');
  if (typeof available !== 'boolean') return invalidPayload(context, 'probe-invalid-balance');
  if (available) {
    writeProbe(context, { status: 'healthy', reason: 'deepseek-balance-available' });
    return { probeMode: 'active-api', networkUsed: true, extra: { balanceAvailable: true }, warnings: [] };
  }
  writeProbe(context, { status: 'held-quota', window: 'balance', reason: 'deepseek-balance-exhausted' });
  return { probeMode: 'active-api', networkUsed: true, extra: { balanceAvailable: false }, warnings: [] };
}

function openrouterOutcome(context: PoolContext, value: unknown): ProbeOutcome {
  const data = asRecord(at(value, 'data'));
  if (!data) return invalidPayload(context, 'probe-invalid-key-usage');
  const limit = data.limit,
    remaining = data.limit_remaining;
  if (finiteNumber(limit) && limit > 0 && finiteNumber(remaining)) {
    const ratio = remaining / limit;
    if (remaining <= 0) {
      writeProbe(context, { status: 'held-quota', window: 'balance', reason: 'openrouter-credit-exhausted' });
      return { probeMode: 'active-api', networkUsed: true, extra: { creditRemainingRatio: 0 }, warnings: [] };
    }
    if (ratio < MIN_CREDIT_RATIO) {
      writeProbe(context, { status: 'tight', window: 'balance', reason: 'openrouter-credit-low' });
      return { probeMode: 'active-api', networkUsed: true, extra: { creditRemainingRatio: ratio }, warnings: [] };
    }
    writeProbe(context, { status: 'healthy', window: 'balance', reason: 'openrouter-credit-available' });
    return { probeMode: 'active-api', networkUsed: true, extra: { creditRemainingRatio: ratio }, warnings: [] };
  }
  writeProbe(context, { status: 'healthy', reason: 'openrouter-credit-unlimited' });
  return { probeMode: 'active-api', networkUsed: true, extra: {}, warnings: [] };
}

function invalidPayload(context: PoolContext, reason: string): ProbeOutcome {
  return { probeMode: 'probe-error', networkUsed: true, extra: { detail: reason }, warnings: [`probe-error:${context.pool}:${reason}`] };
}

async function activeProbe(context: PoolContext): Promise<ProbeOutcome> {
  const key = credential(context.env, context.upstream);
  if (!key) return { probeMode: 'missing-credential', networkUsed: false, extra: {}, warnings: [] };
  const headers = { Accept: 'application/json', Authorization: `Bearer ${key}` };
  const url =
    context.upstream === 'opencode-go'
      ? GO_USAGE_URL
      : context.upstream === 'deepseek-official'
        ? DEEPSEEK_BALANCE_URL
        : OPENROUTER_KEY_URL;
  const result = await readJson(context.fetcher, url, headers, context.timeoutMs);
  return activeOutcome(context, result);
}

function burnRateReached(usage: LocalUsageSummary | undefined, budget: PoolSoftBudget | undefined): boolean {
  if (!usage || !budget) return false;
  const compare = (spent: unknown, allowed: unknown): boolean =>
    finiteNumber(spent) && finiteNumber(allowed) && allowed > 0 && spent >= BURN_RATE_RATIO * allowed;
  return (
    compare(usage.rolling5hUsd, budget.rolling5hUsd) ||
    compare(usage.weeklyUsd, budget.weeklyUsd) ||
    compare(usage.rolling5hRequests, budget.rolling5hRequests) ||
    compare(usage.weeklyRequests, budget.weeklyRequests)
  );
}

async function probePool(
  context: PoolContext,
  allowNetwork: boolean,
): Promise<{ outcome: ProbeOutcome; health: EffectivePoolHealth; entry: Partial<PoolProbeEntry> }> {
  if (!allowNetwork) {
    const probeMode: PoolProbeMode = PASSIVE_UPSTREAMS.has(context.upstream) ? 'passive-only' : 'skipped-offline';
    return { outcome: { probeMode, networkUsed: false, extra: {}, warnings: [] }, health: safeEffective(context), entry: {} };
  }
  if (PASSIVE_UPSTREAMS.has(context.upstream)) {
    return {
      outcome: { probeMode: 'passive-only', networkUsed: false, extra: {}, warnings: [] },
      health: safeEffective(context),
      entry: {},
    };
  }
  let outcome: ProbeOutcome;
  try {
    outcome = await activeProbe(context);
  } catch {
    outcome = {
      probeMode: 'probe-error',
      networkUsed: true,
      extra: {},
      warnings: [`probe-error:${context.pool}:probe-failed`],
    };
  }
  return { outcome, health: safeEffective(context), entry: outcome.extra };
}

function defaultPools(): ProbePoolTarget[] {
  return DEFAULT_POOLS.map((target: ProbePoolTarget) => ({ pool: target.pool, upstream: target.upstream }));
}

function verifiedPools(pools: readonly ProbePoolTarget[], recorded: EffectivePoolHealth[]): ProbePoolTarget[] {
  const targets: ProbePoolTarget[] = [];
  const seen = new Set<string>();
  const add = (target: ProbePoolTarget): void => {
    if (!routeId(target.pool) || !isSupportedUpstream(target.upstream)) throw new Error('Unverified probe pool target.');
    const id = `${target.upstream}\0${target.pool}`;
    if (seen.has(id)) return;
    seen.add(id);
    targets.push({ pool: target.pool, upstream: target.upstream });
  };
  for (const target of pools) add(target);
  for (const health of recorded) add({ pool: health.pool, upstream: health.upstream });
  return targets;
}

function poolKeys(targets: readonly ProbePoolTarget[]): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const target of targets) {
    const key = used.has(target.pool) ? `${target.upstream}:${target.pool}` : target.pool;
    used.add(key);
    keys.set(`${target.upstream}\0${target.pool}`, key);
  }
  return keys;
}

function pricingWindowMap(now: number, holidayOverrides: readonly string[]): Record<string, PricingWindowEvaluation> {
  const windows: Record<string, PricingWindowEvaluation> = {};
  for (const schedule of BUILTIN_PRICING_SCHEDULES) {
    for (const model of schedule.models) windows[model] = evaluatePricingWindow(model, now, { holidayOverrides });
  }
  return windows;
}

export async function runRoutingProbe(options: RunProbeOptions = {}): Promise<ProbeSnapshot> {
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error('Invalid probe clock.');
  const local = options.kittoHomePath ?? kittoHome();
  const allowNetwork = options.allowNetwork === true;
  const warnings: string[] = [];
  const holidayOverrides = new Set<string>(options.holidayOverrides ?? []);
  let poolSoftBudgets: Record<string, PoolSoftBudget> = {};
  const loaded = loadLocalRoutingOverrides(local);
  if (loaded.status === 'invalid') warnings.push(`local-overrides-invalid:${loaded.reason}`);
  else if (loaded.status === 'ok') {
    for (const day of loaded.overrides.holidayOverrides ?? []) holidayOverrides.add(day);
    poolSoftBudgets = loaded.overrides.poolSoftBudgets ?? {};
  }
  const store = createPoolHealthStore(local);
  const targets = verifiedPools(options.pools ?? defaultPools(), store.listAll(now));
  const keys = poolKeys(targets);
  const contextBase = {
    store,
    now,
    fetcher: options.fetcher ?? globalThis.fetch,
    env: options.env ?? process.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const results = await Promise.all(
    targets.map(async (target: ProbePoolTarget) => {
      const context: PoolContext = { ...contextBase, pool: target.pool, upstream: target.upstream };
      const probed = await probePool(context, allowNetwork);
      const entry: PoolProbeEntry = {
        pool: target.pool,
        upstream: target.upstream,
        probeMode: probed.outcome.probeMode,
        health: probed.health,
        ...probed.entry,
      };
      return {
        key: keys.get(`${target.upstream}\0${target.pool}`) ?? target.pool,
        entry,
        warnings: probed.outcome.warnings,
        networkUsed: probed.outcome.networkUsed,
      };
    }),
  );
  const pools: Record<string, PoolProbeEntry> = {};
  let networkUsed = false;
  for (const result of results) {
    networkUsed ||= result.networkUsed;
    warnings.push(...result.warnings);
    const entry = result.entry;
    if (burnRateReached(options.localUsage?.[entry.pool], poolSoftBudgets[entry.pool])) {
      entry.burnRateTight = true;
      if (entry.health.status === 'healthy')
        entry.health = { ...entry.health, status: 'tight', tight: true, reason: 'local-burn-rate-near-soft-budget' };
    }
    pools[result.key] = entry;
  }
  const snapshot: ProbeSnapshot = {
    schema: 1,
    observedAt: new Date(now).toISOString(),
    networkUsed,
    pricingWindows: pricingWindowMap(now, [...holidayOverrides]),
    pools,
    warnings,
  };
  if (options.writeCache !== false) writeProbeCache(local, snapshot);
  return snapshot;
}
