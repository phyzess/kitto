import { authorizeGoRead, knownGoCanonical } from './model-routing.ts';
import { maxPrice, timestamp } from './go-allowance.ts';
import { routeId } from './routing-policy.ts';
import type { State } from '../types/kitto.d.ts';
import type { RoutingRequest } from './model-routing.ts';

interface GoCatalogItem {
  id: string;
  canonical_id: string;
  type: 'chat';
  go: { monthly_usage: Record<string, number>; training: false };
  cost: { text: { input: { price: number }; output: { price: number } }; multipliers: Array<{ factor: number }> };
}

interface GoCatalog {
  object: 'list';
  data: GoCatalogItem[];
}

interface GoUsageWindow {
  status: 'ok' | 'rate-limited';
  percent: number;
  resetsAt: string;
}

export interface GoBinding {
  account: string;
  plan: string;
  profile: string;
  model: string;
  canonicalModel: string;
}

type MetadataRead = { status: 'stop'; reason: string; statusCode?: number } | { status: 'ok'; value: unknown };

type Stopped = { status: 'stop'; reason: string; statusCode?: number };

interface Collected {
  status: 'collected';
  source: 'opencode-go-metadata';
  account: string;
  plan: string;
  profile: string;
  catalogObservedAt: string;
  observedAt: string;
  catalog: GoCatalog;
  usage: Record<string, GoUsageWindow>;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const BASE = 'https://opencode.ai/inference/go/v1';
const MAX_BYTES = 512 * 1024;
const WINDOW_NAMES = ['rolling', 'weekly', 'monthly'];
const stopped = (reason: string, statusCode?: number): Stopped => ({ status: 'stop', reason, ...(statusCode && { statusCode }) });

async function readMetadata(fetcher: Fetcher, name: string, headers: Record<string, string>, signal: AbortSignal): Promise<MetadataRead> {
  const response = await fetcher(`${BASE}/${name}`, { method: 'GET', headers, signal, redirect: 'error', credentials: 'omit' });
  if (response.redirected || (response.status >= 300 && response.status < 400)) return stopped('metadata-redirect', response.status);
  if (response.status !== 200) return stopped('metadata-http-error', response.status);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body)
    return stopped('metadata-invalid');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) return stopped('metadata-too-large');
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
      return stopped('metadata-too-large');
    }
    try {
      text += decoder.decode(value, { stream: true });
    } catch {
      return stopped('metadata-invalid');
    }
  }
  try {
    return { status: 'ok' as const, value: JSON.parse(text + decoder.decode()) };
  } catch {
    return stopped('metadata-invalid');
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

const positiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

function catalogProjection(response: unknown, binding: GoBinding & { plan: string }): GoCatalog | null {
  const rows = at(response, 'data');
  if (at(response, 'object') !== 'list' || !Array.isArray(rows)) return null;
  const seen = new Set<string>();
  for (const item of rows) {
    const id = at(item, 'id');
    if (!routeId(id) || seen.has(id)) return null;
    seen.add(id);
  }
  const data = rows.flatMap((item: unknown) => {
    const verified = projectModel(item, binding.plan);
    return verified ? [verified] : [];
  });
  return data.some((item) => item.id === binding.model && item.canonical_id === binding.canonicalModel) ? { object: 'list', data } : null;
}

function projectModel(item: unknown, plan: string): GoCatalogItem | null {
  const id = at(item, 'id'),
    canonicalId = at(item, 'canonical_id'),
    cap = at(item, 'go', 'monthly_usage', plan);
  const canonical = typeof id === 'string' ? knownGoCanonical(id) : undefined;
  if (
    !canonical ||
    typeof id !== 'string' ||
    at(item, 'type') !== 'chat' ||
    typeof canonicalId !== 'string' ||
    canonicalId.toLowerCase() !== canonical ||
    at(item, 'go', 'training') !== false ||
    !positiveNumber(cap)
  )
    return null;
  const input = maxPrice(asRecord(at(item, 'cost', 'text', 'input'))),
    output = maxPrice(asRecord(at(item, 'cost', 'text', 'output')));
  const rawMultipliers = at(item, 'cost', 'multipliers');
  const multipliers = rawMultipliers === undefined ? [] : rawMultipliers;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input + output <= 0 || !Array.isArray(multipliers)) return null;
  const factors = multipliers.map((row: unknown) => at(row, 'factor'));
  if (!factors.every(positiveNumber) || !Number.isFinite(factors.reduce((product: number, factor) => product * Math.max(1, factor), 1)))
    return null;
  return {
    id,
    canonical_id: canonical,
    type: 'chat',
    go: { monthly_usage: { [plan]: cap }, training: false },
    cost: { text: { input: { price: input }, output: { price: output } }, multipliers: factors.map((factor) => ({ factor })) },
  };
}

function usageProjection(response: unknown, now: number): Record<string, GoUsageWindow> | null {
  const windows: Array<[string, GoUsageWindow]> = [];
  for (const name of WINDOW_NAMES) {
    const item = at(response, 'usage', name);
    const status = at(item, 'status'),
      percent = at(item, 'percent'),
      resetsAt = at(item, 'resetsAt');
    if (
      (status !== 'ok' && status !== 'rate-limited') ||
      typeof percent !== 'number' ||
      !Number.isInteger(percent) ||
      percent < 0 ||
      percent > 100 ||
      typeof resetsAt !== 'string' ||
      !(timestamp(resetsAt) > now)
    )
      return null;
    windows.push([name, { status, percent, resetsAt }]);
  }
  return Object.fromEntries(windows);
}

export async function collectGoMetadata({
  state,
  request,
  optedIn,
  fetcher = globalThis.fetch,
  readKey = () => process.env.KITTO_GO_METADATA_KEY,
  clock = Date.now,
  timeoutMs = 10_000,
}: {
  state: State;
  request: RoutingRequest;
  optedIn?: boolean;
  fetcher?: Fetcher;
  readKey?: () => string | undefined;
  clock?: () => number;
  timeoutMs?: number;
}): Promise<Collected | Stopped> {
  if (optedIn !== true) return stopped('metadata-opt-in-required');
  const binding = authorizeGoRead(state, request, clock());
  if (!binding) return stopped('metadata-account-or-policy-unverified');
  let key: string | undefined;
  try {
    key = readKey();
  } catch {
    return stopped('metadata-key-unavailable');
  }
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_.~-]{1,1024}$/.test(key)) return stopped('metadata-key-unavailable');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<Stopped>((resolve) => {
      timer = setTimeout(
        () => {
          controller.abort();
          resolve(stopped('metadata-timeout'));
        },
        Math.min(10_000, timeoutMs),
      );
    });
    const collection = async (): Promise<Collected | Stopped> => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      const models = await readMetadata(fetcher, 'models', headers, controller.signal);
      if (models.status === 'stop') return models;
      const catalog = catalogProjection(models.value, binding);
      if (!catalog) return stopped('metadata-catalog-unverified');
      const catalogObservedAt = new Date(clock()).toISOString();
      controller.signal.throwIfAborted();
      const meter = await readMetadata(fetcher, 'usage', { ...headers, Authorization: `Bearer ${key}` }, controller.signal);
      if (meter.status === 'stop') return meter;
      const now = clock(),
        usage = usageProjection(meter.value, now);
      if (!usage) return stopped('metadata-meter-unverified');
      return {
        status: 'collected',
        source: 'opencode-go-metadata',
        account: binding.account,
        plan: binding.plan,
        profile: binding.profile,
        catalogObservedAt,
        observedAt: new Date(now).toISOString(),
        catalog,
        usage,
      };
    };
    return await Promise.race([deadline, collection()]);
  } catch {
    return stopped(controller.signal.aborted ? 'metadata-timeout' : 'metadata-transport-error');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
