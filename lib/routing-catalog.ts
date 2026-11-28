import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeId } from './routing-policy.ts';

export type UpstreamId = 'openai-codex' | 'opencode-go' | 'deepseek-official' | 'anthropic' | 'openrouter';
export type ModelTier = 0 | 1 | 2;
export type PriceTriple = readonly [number, number, number];

export interface ModelPricing {
  longContextThreshold: number;
  base: PriceTriple;
  long: PriceTriple;
  pricingScheduleId?: string;
}

export interface CanonicalModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  vision: boolean;
}

export interface CanonicalModelEntry {
  canonicalId: string;
  family: string;
  tier: ModelTier;
  premium: boolean;
  contextWindow: number;
  capabilities: CanonicalModelCapabilities;
  pricing: ModelPricing;
}

export interface PoolSoftBudget {
  rolling5hUsd?: number;
  weeklyUsd?: number;
  rolling5hRequests?: number;
  weeklyRequests?: number;
}

export interface LocalRoutingOverrides {
  schema: 1;
  models?: Record<string, Partial<CanonicalModelEntry>>;
  holidayOverrides?: string[];
  poolSoftBudgets?: Record<string, PoolSoftBudget>;
}

export const SUPPORTED_UPSTREAMS: readonly UpstreamId[] = ['openai-codex', 'opencode-go', 'deepseek-official', 'anthropic', 'openrouter'];

const FAMILY_NAMES = [
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
] as const;

export const KNOWN_FAMILIES: ReadonlySet<string> = new Set(FAMILY_NAMES);

const CANONICAL_ENTRIES: readonly CanonicalModelEntry[] = [
  {
    canonicalId: 'openai/gpt-6.2-sol',
    family: 'openai',
    tier: 1,
    premium: false,
    contextWindow: 400_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: { longContextThreshold: 272_000, base: [2, 0.1, 10], long: [4, 0.2, 15] },
  },
  {
    canonicalId: 'openai/gpt-6.2-astra',
    family: 'openai',
    tier: 2,
    premium: true,
    contextWindow: 400_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: { longContextThreshold: 272_000, base: [2.4, 0.12, 12], long: [4.8, 0.24, 24] },
  },
  {
    canonicalId: 'deepseek/deepseek-v4.1-flash-1017',
    family: 'deepseek',
    tier: 0,
    premium: false,
    contextWindow: 1_000_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: {
      longContextThreshold: Number.POSITIVE_INFINITY,
      base: [0.15, 0.003, 0.6],
      long: [0.15, 0.003, 0.6],
      pricingScheduleId: 'deepseek-peak-utc',
    },
  },
  {
    canonicalId: 'deepseek/deepseek-v4-pro',
    family: 'deepseek',
    tier: 2,
    premium: true,
    contextWindow: 1_000_000,
    capabilities: { tools: true, reasoning: true, vision: false },
    pricing: {
      longContextThreshold: Number.POSITIVE_INFINITY,
      base: [1.74, 0.174, 3.48],
      long: [1.74, 0.174, 3.48],
      pricingScheduleId: 'deepseek-peak-utc',
    },
  },
  {
    canonicalId: 'zhipuai/glm-5.3-flash',
    family: 'zhipuai',
    tier: 0,
    premium: false,
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, vision: false },
    pricing: { longContextThreshold: Number.POSITIVE_INFINITY, base: [0.15, 0.015, 0.5], long: [0.15, 0.015, 0.5] },
  },
  {
    canonicalId: 'tencent/hy3',
    family: 'tencent',
    tier: 0,
    premium: false,
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, vision: false },
    pricing: { longContextThreshold: Number.POSITIVE_INFINITY, base: [0.15, 0.015, 0.5], long: [0.15, 0.015, 0.5] },
  },
  {
    canonicalId: 'zhipuai/glm-5.3',
    family: 'zhipuai',
    tier: 1,
    premium: false,
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, vision: false },
    pricing: { longContextThreshold: Number.POSITIVE_INFINITY, base: [1.4, 0.14, 4.4], long: [1.4, 0.14, 4.4] },
  },
  {
    canonicalId: 'moonshotai/kimi-k3.1-pro',
    family: 'moonshotai',
    tier: 1,
    premium: false,
    contextWindow: 256_000,
    capabilities: { tools: true, reasoning: true, vision: false },
    pricing: { longContextThreshold: Number.POSITIVE_INFINITY, base: [2, 0.2, 10], long: [2, 0.2, 10] },
  },
  {
    canonicalId: 'xai/grok-4.7',
    family: 'xai',
    tier: 2,
    premium: true,
    contextWindow: 1_000_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: { longContextThreshold: 200_000, base: [2, 0.5, 6], long: [4, 1, 12] },
  },
  {
    canonicalId: 'anthropic/claude-sonnet-5-5',
    family: 'anthropic',
    tier: 1,
    premium: false,
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: { longContextThreshold: 200_000, base: [3, 0.3, 15], long: [6, 0.6, 22.5] },
  },
  {
    canonicalId: 'anthropic/claude-opus-4-6',
    family: 'anthropic',
    tier: 2,
    premium: true,
    contextWindow: 200_000,
    capabilities: { tools: true, reasoning: true, vision: true },
    pricing: { longContextThreshold: 200_000, base: [15, 1.5, 75], long: [30, 3, 112.5] },
  },
];

export const CANONICAL_MODELS: ReadonlyMap<string, CanonicalModelEntry> = new Map(
  CANONICAL_ENTRIES.map((entry) => [entry.canonicalId, entry] as const),
);

const ROUTES: readonly (readonly [string, string])[] = [
  ['openai-codex/gpt-6.2-sol', 'openai/gpt-6.2-sol'],
  ['openai-codex/gpt-6.2-astra', 'openai/gpt-6.2-astra'],
  ['opencode-go/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017'],
  ['opencode-go/glm-5.3-flash', 'zhipuai/glm-5.3-flash'],
  ['opencode-go/hy3', 'tencent/hy3'],
  ['opencode-go/glm-5.3', 'zhipuai/glm-5.3'],
  ['opencode-go/kimi-k3.1-pro', 'moonshotai/kimi-k3.1-pro'],
  ['opencode-go/grok-4.7', 'xai/grok-4.7'],
  ['opencode-go/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
  ['deepseek-official/deepseek-flash', 'deepseek/deepseek-v4.1-flash-1017'],
  ['deepseek-official/deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017'],
  ['deepseek-official/deepseek-v4-pro', 'deepseek/deepseek-v4-pro'],
  ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'],
  ['anthropic/claude-opus-4-6', 'anthropic/claude-opus-4-6'],
];

export const BUILTIN_ROUTE_CANONICAL: ReadonlyMap<string, string> = new Map(ROUTES);

export function parseCanonicalIdentity(canonicalModel: unknown): { canonicalModel: string; family: string } | null {
  if (typeof canonicalModel !== 'string' || !routeId(canonicalModel) || !/^[^/]+\/[^/]+$/.test(canonicalModel)) return null;
  const canonical = canonicalModel.toLowerCase();
  const family = canonical.split('/')[0];
  return KNOWN_FAMILIES.has(family) ? { canonicalModel: canonical, family } : null;
}

export function lookupCanonicalModel(canonicalId: unknown): CanonicalModelEntry | null {
  if (typeof canonicalId !== 'string') return null;
  const identity = parseCanonicalIdentity(canonicalId);
  return identity ? (CANONICAL_MODELS.get(identity.canonicalModel) ?? null) : null;
}

export function lookupBuiltinRoute(upstream: string, model: string): CanonicalModelEntry | null {
  const canonicalId = BUILTIN_ROUTE_CANONICAL.get(`${upstream}/${model}`.toLowerCase());
  return canonicalId ? lookupCanonicalModel(canonicalId) : null;
}

export function isSupportedUpstream(value: unknown): value is UpstreamId {
  return typeof value === 'string' && (SUPPORTED_UPSTREAMS as readonly string[]).includes(value);
}

const MAX_OVERRIDES_BYTES = 256 * 1024;
const SECRET_KEY_FOLDS = new Set(['apikey', 'token', 'secret', 'authorization', 'password']);

const foldedKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function containsSecretLikeKey(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    const record = asRecord(value);
    if (!record) continue;
    for (const [key, item] of Object.entries(record)) {
      if (SECRET_KEY_FOLDS.has(foldedKey(key))) return true;
      pending.push(item);
    }
  }
  return false;
}

const validHolidayOverrides = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item));

const positiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const POOL_SOFT_BUDGET_KEYS: ReadonlySet<string> = new Set(['rolling5hUsd', 'weeklyUsd', 'rolling5hRequests', 'weeklyRequests']);

function validPoolSoftBudgets(value: unknown): value is Record<string, PoolSoftBudget> {
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every((budget) => {
    const entry = asRecord(budget);
    if (!entry || Object.keys(entry).length === 0) return false;
    return Object.entries(entry).every(([key, amount]) => POOL_SOFT_BUDGET_KEYS.has(key) && positiveFinite(amount));
  });
}

export function loadLocalRoutingOverrides(
  kittoHomePath: string,
): { status: 'missing' } | { status: 'ok'; overrides: LocalRoutingOverrides } | { status: 'invalid'; reason: string } {
  let raw: Buffer;
  try {
    raw = readFileSync(join(kittoHomePath, 'routing-profiles.json'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid', reason: 'unreadable-file' };
  }
  if (raw.byteLength > MAX_OVERRIDES_BYTES) return { status: 'invalid', reason: 'file-too-large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 'invalid', reason: 'invalid-json' };
  }
  if (containsSecretLikeKey(parsed)) return { status: 'invalid', reason: 'secret-like-field-disallowed' };
  const record = asRecord(parsed);
  if (!record || record.schema !== 1) return { status: 'invalid', reason: 'unsupported-schema' };
  const models = record.models;
  if (models !== undefined && (!asRecord(models) || Object.values(models as Record<string, unknown>).some((entry) => !asRecord(entry))))
    return { status: 'invalid', reason: 'invalid-models' };
  const holidayOverrides = record.holidayOverrides;
  if (holidayOverrides !== undefined && !validHolidayOverrides(holidayOverrides))
    return { status: 'invalid', reason: 'invalid-holiday-overrides' };
  const poolSoftBudgets = record.poolSoftBudgets;
  if (poolSoftBudgets !== undefined && !validPoolSoftBudgets(poolSoftBudgets))
    return { status: 'invalid', reason: 'invalid-pool-soft-budgets' };
  return {
    status: 'ok',
    overrides: {
      schema: 1,
      ...(models !== undefined && { models: models as Record<string, Partial<CanonicalModelEntry>> }),
      ...(holidayOverrides !== undefined && { holidayOverrides: [...(holidayOverrides as string[])] }),
      ...(poolSoftBudgets !== undefined && { poolSoftBudgets: poolSoftBudgets as Record<string, PoolSoftBudget> }),
    },
  };
}
