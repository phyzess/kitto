import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { timestamp } from './go-allowance.ts';
import { isSupportedUpstream } from './routing-catalog.ts';
import { routeId } from './routing-policy.ts';
import type { UpstreamId } from './routing-catalog.ts';

export type PoolHealthStatus = 'healthy' | 'tight' | 'held-quota' | 'held-outage' | 'auth-broken' | 'needs-reprobe';
export type QuotaWindowKind = '5h' | 'rolling' | 'weekly' | 'monthly' | 'balance' | 'unknown';
export type FailureKind = 'quota' | 'rate_limit' | 'outage' | 'auth';
export type PoolHealthSource = 'probe' | 'report-failure' | 'burn-rate' | 'manual-clear';

export interface PoolHealthRecord {
  schema: 1;
  pool: string;
  upstream: UpstreamId;
  status: PoolHealthStatus;
  updatedAt: string;
  observedAt: string;
  failureKind?: FailureKind;
  window?: QuotaWindowKind;
  resetsAt?: string;
  consecutiveFailures?: number;
  reason?: string;
  source: PoolHealthSource;
}

export interface EffectivePoolHealth {
  pool: string;
  upstream: UpstreamId;
  status: PoolHealthStatus;
  available: boolean;
  tight: boolean;
  needsReprobe: boolean;
  resetsAt?: string;
  window?: QuotaWindowKind;
  reason: string;
  observedAt?: string;
  source?: PoolHealthSource;
}

export interface PoolFailureInput {
  pool: string;
  upstream: UpstreamId;
  kind: FailureKind;
  window?: QuotaWindowKind;
  resetsAt?: string;
  reason?: string;
  observedAt?: string;
}

export interface PoolProbeResultInput {
  pool: string;
  upstream: UpstreamId;
  status: 'healthy' | 'tight' | 'held-quota' | 'held-outage' | 'auth-broken';
  window?: QuotaWindowKind;
  resetsAt?: string;
  reason?: string;
  observedAt?: string;
}

export interface PoolHealthStore {
  recordFailure(input: PoolFailureInput, now?: number): PoolHealthRecord;
  recordProbeResult(input: PoolProbeResultInput, now?: number): PoolHealthRecord;
  clearPool(pool: string, upstream: UpstreamId, reason?: string, now?: number): PoolHealthRecord;
  getEffective(pool: string, upstream: UpstreamId, now?: number): EffectivePoolHealth;
  listAll(now?: number): EffectivePoolHealth[];
}

export const FAILURE_KINDS: readonly FailureKind[] = ['quota', 'rate_limit', 'outage', 'auth'];
export const QUOTA_WINDOWS: readonly QuotaWindowKind[] = ['5h', 'rolling', 'weekly', 'monthly', 'balance', 'unknown'];

const STORED_STATUSES: readonly string[] = ['healthy', 'tight', 'held-quota', 'held-outage', 'auth-broken'];
const SOURCES: readonly string[] = ['probe', 'report-failure', 'burn-rate', 'manual-clear'];
const MAX_BYTES = 1_000_000;
const CLOCK_SKEW_MS = 60_000;
const CACHE_TTL_MS = 300_000;
const POOL_FILE = /^pool-[0-9a-f]{64}\.json$/;

export function poolHealthKey(upstream: UpstreamId, pool: string): string {
  if (!isSupportedUpstream(upstream) || !routeId(pool)) throw new Error('Unverified pool identity.');
  return createHash('sha256').update(`${upstream}\0${pool}`).digest('hex');
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

const own = (stats: { mode: number; uid: number }): boolean =>
  (stats.mode & 0o077) === 0 && (process.getuid === undefined || stats.uid === process.getuid());

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const iso = (now: number): string => new Date(now).toISOString();

const finiteStamp = (value: unknown): value is string => Number.isFinite(timestamp(value));

const validWindow = (value: unknown): value is QuotaWindowKind =>
  typeof value === 'string' && (QUOTA_WINDOWS as readonly string[]).includes(value);

const validFailureKind = (value: unknown): value is FailureKind =>
  typeof value === 'string' && (FAILURE_KINDS as readonly string[]).includes(value);

const noRecord = (pool: string, upstream: UpstreamId): EffectivePoolHealth => ({
  pool,
  upstream,
  status: 'healthy',
  available: true,
  tight: false,
  needsReprobe: false,
  reason: 'no-recorded-issues',
});

const invalidState = (pool: string, upstream: UpstreamId): EffectivePoolHealth => ({
  pool,
  upstream,
  status: 'needs-reprobe',
  available: false,
  tight: false,
  needsReprobe: true,
  reason: 'pool-health-state-invalid',
});

function readPrivate(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || !own(stats) || stats.size > MAX_BYTES) throw new Error('Invalid pool health state file.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivate(path: string, value: unknown): void {
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(temp, path);
    syncDir(dirname(path));
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(temp);
    } catch {}
    throw error;
  }
}

function rootOf(kittoHomePath: string): string {
  return join(kittoHomePath, 'routing-v2');
}

function optionalDirectory(kittoHomePath: string): string | null {
  const root = rootOf(kittoHomePath);
  try {
    const stats = lstatSync(root);
    if (!stats.isDirectory() || !own(stats)) throw new Error('Invalid private pool health directory.');
    return root;
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function ensureDirectory(kittoHomePath: string): string {
  ensureRoot(rootOf(kittoHomePath));
  const root = optionalDirectory(kittoHomePath);
  if (!root) throw new Error('Invalid private pool health directory.');
  return root;
}

function ensureRoot(root: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function transaction<T>(kittoHomePath: string, name: string, update: (path: string) => T): T {
  const root = ensureDirectory(kittoHomePath);
  const path = join(root, name),
    lock = `${path}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try {
    return update(path);
  } finally {
    rmdirSync(lock);
  }
}

function unlockedPath(kittoHomePath: string, name: string): string | null {
  const root = optionalDirectory(kittoHomePath);
  if (!root) return null;
  const path = join(root, name);
  try {
    lstatSync(`${path}.lock`);
  } catch (error) {
    if (missing(error)) return path;
    throw error;
  }
  throw new Error('Pool health transaction is incomplete or busy.');
}

function parseRecord(raw: unknown): PoolHealthRecord | null {
  const row = asRecord(raw);
  if (!row) return null;
  const status = row.status,
    source = row.source;
  if (
    row.schema !== 1 ||
    !routeId(row.pool) ||
    !isSupportedUpstream(row.upstream) ||
    typeof status !== 'string' ||
    !STORED_STATUSES.includes(status) ||
    typeof source !== 'string' ||
    !SOURCES.includes(source) ||
    !finiteStamp(row.updatedAt) ||
    !finiteStamp(row.observedAt)
  )
    return null;
  if (Object.hasOwn(row, 'failureKind') && !validFailureKind(row.failureKind)) return null;
  if (Object.hasOwn(row, 'window') && !validWindow(row.window)) return null;
  if (Object.hasOwn(row, 'resetsAt') && !finiteStamp(row.resetsAt)) return null;
  if (
    Object.hasOwn(row, 'consecutiveFailures') &&
    !(typeof row.consecutiveFailures === 'number' && Number.isInteger(row.consecutiveFailures) && row.consecutiveFailures >= 0)
  )
    return null;
  if (Object.hasOwn(row, 'reason') && typeof row.reason !== 'string') return null;
  return {
    schema: 1,
    pool: row.pool,
    upstream: row.upstream,
    status: status as PoolHealthStatus,
    updatedAt: row.updatedAt,
    observedAt: row.observedAt,
    source: source as PoolHealthSource,
    ...(row.failureKind !== undefined && { failureKind: row.failureKind as FailureKind }),
    ...(row.window !== undefined && { window: row.window as QuotaWindowKind }),
    ...(row.resetsAt !== undefined && { resetsAt: row.resetsAt as string }),
    ...(row.consecutiveFailures !== undefined && { consecutiveFailures: row.consecutiveFailures as number }),
    ...(row.reason !== undefined && { reason: row.reason as string }),
  };
}

function readRecordFile(path: string): PoolHealthRecord | null {
  let raw: unknown;
  try {
    raw = readPrivate(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const record = parseRecord(raw);
  if (!record) throw new Error('Invalid pool health state.');
  return record;
}

function parseRecordQuietly(path: string): PoolHealthRecord | null {
  try {
    return readRecordFile(path);
  } catch {
    return null;
  }
}

function evaluate(record: PoolHealthRecord, now: number): EffectivePoolHealth {
  const base = {
    pool: record.pool,
    upstream: record.upstream,
    observedAt: record.observedAt,
    source: record.source,
    ...(record.resetsAt !== undefined && { resetsAt: record.resetsAt }),
    ...(record.window !== undefined && { window: record.window }),
  };
  if (record.status === 'auth-broken')
    return {
      ...base,
      status: 'auth-broken',
      available: false,
      tight: false,
      needsReprobe: false,
      reason: record.reason ?? 'authentication-failed',
    };
  if (record.status === 'held-quota' || record.status === 'held-outage') {
    const reset = timestamp(record.resetsAt);
    if (Number.isFinite(reset) && reset <= now) {
      const reason = record.status === 'held-quota' ? 'quota-window-reset-elapsed' : 'outage-cooldown-elapsed';
      return { ...base, status: 'needs-reprobe', available: true, tight: false, needsReprobe: true, reason };
    }
    const reason = record.reason ?? (record.status === 'held-quota' ? 'quota-limit-reached' : 'upstream-outage');
    return { ...base, status: record.status, available: false, tight: false, needsReprobe: false, reason };
  }
  if (record.status === 'tight')
    return { ...base, status: 'tight', available: true, tight: true, needsReprobe: false, reason: record.reason ?? 'pool-pressure-tight' };
  return { ...base, status: 'healthy', available: true, tight: false, needsReprobe: false, reason: record.reason ?? 'pool-healthy' };
}

function observation(value: unknown, now: number): string {
  if (!Number.isFinite(now)) throw new Error('Invalid pool health clock.');
  if (value === undefined) return iso(now);
  const time = timestamp(value);
  if (!Number.isFinite(time) || time > now + CLOCK_SKEW_MS) throw new Error('Fresh UTC pool evidence required.');
  return iso(time);
}

function resetStamp(value: unknown): string {
  const time = timestamp(value);
  if (!Number.isFinite(time)) throw new Error('Invalid quota reset timestamp.');
  return iso(time);
}

function verifiedIdentity(pool: unknown, upstream: unknown): { pool: string; upstream: UpstreamId } {
  if (!routeId(pool) || !isSupportedUpstream(upstream)) throw new Error('Unverified pool identity.');
  return { pool, upstream };
}

export function createPoolHealthStore(kittoHomePath: string): PoolHealthStore {
  const fileName = (upstream: UpstreamId, pool: string): string => `pool-${poolHealthKey(upstream, pool)}.json`;
  return {
    recordFailure(input: PoolFailureInput, now: number = Date.now()): PoolHealthRecord {
      const { pool, upstream } = verifiedIdentity(input.pool, input.upstream);
      const kind = input.kind;
      if (!validFailureKind(kind)) throw new Error('Unsupported pool failure kind.');
      if (input.window !== undefined && !validWindow(input.window)) throw new Error('Unsupported quota window.');
      const observedAt = observation(input.observedAt, now);
      const resetsAt = input.resetsAt === undefined ? undefined : resetStamp(input.resetsAt);
      return transaction(kittoHomePath, fileName(upstream, pool), (path: string) => {
        const previous = parseRecordQuietly(path);
        const common = { schema: 1 as const, pool, upstream, updatedAt: iso(now), observedAt, failureKind: kind };
        let record: PoolHealthRecord;
        if (kind === 'auth') {
          record = { ...common, status: 'auth-broken', reason: input.reason ?? 'authentication-failed', source: 'report-failure' };
        } else if (kind === 'quota') {
          record = {
            ...common,
            status: 'held-quota',
            window: input.window ?? 'unknown',
            reason: input.reason ?? 'quota-limit-reached',
            source: 'report-failure',
            ...(resetsAt !== undefined && timestamp(resetsAt) > now && { resetsAt }),
          };
        } else if (kind === 'rate_limit') {
          record = {
            ...common,
            status: 'held-quota',
            window: input.window ?? '5h',
            resetsAt: resetsAt ?? iso(now + 15 * 60_000),
            reason: input.reason ?? 'rate-limit-reached',
            source: 'report-failure',
          };
        } else {
          const consecutiveFailures = (previous?.failureKind === 'outage' ? (previous.consecutiveFailures ?? 0) : 0) + 1;
          const backoff = consecutiveFailures === 1 ? 2 * 60_000 : consecutiveFailures === 2 ? 5 * 60_000 : 15 * 60_000;
          record = {
            ...common,
            status: 'held-outage',
            consecutiveFailures,
            resetsAt: resetsAt ?? iso(now + backoff),
            reason: input.reason ?? 'upstream-outage',
            source: 'report-failure',
          };
        }
        writePrivate(path, record);
        return record;
      });
    },
    recordProbeResult(input: PoolProbeResultInput, now: number = Date.now()): PoolHealthRecord {
      const { pool, upstream } = verifiedIdentity(input.pool, input.upstream);
      if (!STORED_STATUSES.includes(input.status)) throw new Error('Unsupported probe status.');
      if (input.window !== undefined && !validWindow(input.window)) throw new Error('Unsupported quota window.');
      const observedAt = observation(input.observedAt, now);
      const resetsAt = input.resetsAt === undefined ? undefined : resetStamp(input.resetsAt);
      const failureKind: FailureKind | undefined =
        input.status === 'held-quota'
          ? 'quota'
          : input.status === 'held-outage'
            ? 'outage'
            : input.status === 'auth-broken'
              ? 'auth'
              : undefined;
      const record: PoolHealthRecord = {
        schema: 1,
        pool,
        upstream,
        status: input.status,
        updatedAt: iso(now),
        observedAt,
        source: 'probe',
        ...(failureKind !== undefined && { failureKind }),
        ...(input.window !== undefined && { window: input.window }),
        ...(resetsAt !== undefined && { resetsAt }),
        ...(input.reason !== undefined && { reason: input.reason }),
      };
      return transaction(kittoHomePath, fileName(upstream, pool), (path: string) => {
        writePrivate(path, record);
        return record;
      });
    },
    clearPool(pool: string, upstream: UpstreamId, reason?: string, now: number = Date.now()): PoolHealthRecord {
      const identity = verifiedIdentity(pool, upstream);
      if (!Number.isFinite(now)) throw new Error('Invalid pool health clock.');
      const record: PoolHealthRecord = {
        schema: 1,
        pool: identity.pool,
        upstream: identity.upstream,
        status: 'healthy',
        updatedAt: iso(now),
        observedAt: iso(now),
        reason: reason ?? 'cleared-by-operator',
        source: 'manual-clear',
      };
      return transaction(kittoHomePath, fileName(identity.upstream, identity.pool), (path: string) => {
        writePrivate(path, record);
        return record;
      });
    },
    getEffective(pool: string, upstream: UpstreamId, now: number = Date.now()): EffectivePoolHealth {
      const identity = verifiedIdentity(pool, upstream);
      let path: string | null;
      try {
        path = unlockedPath(kittoHomePath, fileName(identity.upstream, identity.pool));
      } catch {
        return invalidState(identity.pool, identity.upstream);
      }
      if (!path) return noRecord(identity.pool, identity.upstream);
      let record: PoolHealthRecord | null;
      try {
        record = readRecordFile(path);
      } catch {
        return invalidState(identity.pool, identity.upstream);
      }
      if (!record) return noRecord(identity.pool, identity.upstream);
      if (record.pool !== identity.pool || record.upstream !== identity.upstream) return invalidState(identity.pool, identity.upstream);
      if (timestamp(record.observedAt) > now + CLOCK_SKEW_MS) return invalidState(identity.pool, identity.upstream);
      return evaluate(record, now);
    },
    listAll(now: number = Date.now()): EffectivePoolHealth[] {
      const root = optionalDirectory(kittoHomePath);
      if (!root) return [];
      let names: string[];
      try {
        names = readdirSync(root).filter((name: string) => POOL_FILE.test(name));
      } catch {
        return [];
      }
      const rows: EffectivePoolHealth[] = [];
      for (const name of names) {
        const record = parseRecordQuietly(join(root, name));
        if (!record) continue;
        rows.push(timestamp(record.observedAt) > now + CLOCK_SKEW_MS ? invalidState(record.pool, record.upstream) : evaluate(record, now));
      }
      return rows.sort((a, b) => a.pool.localeCompare(b.pool) || a.upstream.localeCompare(b.upstream));
    },
  };
}

export function writeProbeCache(kittoHomePath: string, snapshot: unknown): void {
  transaction(kittoHomePath, 'probe-cache.json', (path: string) => {
    writePrivate(path, snapshot);
  });
}

export function readProbeCache<T>(kittoHomePath: string, now: number = Date.now(), ttlMs: number = CACHE_TTL_MS): T | null {
  let path: string | null;
  try {
    path = unlockedPath(kittoHomePath, 'probe-cache.json');
  } catch {
    return null;
  }
  if (!path) return null;
  let value: unknown;
  try {
    value = readPrivate(path);
  } catch {
    return null;
  }
  const observed = timestamp(asRecord(value)?.observedAt);
  if (!Number.isFinite(observed) || observed > now + CLOCK_SKEW_MS || now - observed > ttlMs) return null;
  return value as T;
}
