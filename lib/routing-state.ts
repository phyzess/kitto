import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fresh, timestamp } from './go-allowance.ts';
import { routeId } from './routing-policy.ts';
import type { Json } from '../types/kitto.d.ts';

export const ticketId = (value: unknown): value is string => typeof value === 'string' && /^kr-[0-9a-f]{24}$/.test(value);
export const newTicketId = () => `kr-${randomBytes(12).toString('hex')}`;
const poolKey = (pool: unknown) => {
  if (!routeId(pool)) throw new Error('Unverified Go pool identity.');
  return createHash('sha256').update(`opencode-go\0${pool}`).digest('hex');
};
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const own = (stats: { mode: number; uid: number }) =>
  (stats.mode & 0o077) === 0 && (process.getuid === undefined || stats.uid === process.getuid());
const quotaCodes = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'RATE_LIMIT']);
const orderFloor = (row: Json) => timestamp(row.orderFloorAt ?? row.observedAt);
const lastPoolTime = (row: Json) => Math.max(orderFloor(row), timestamp(row.releasedAt) || 0);

function readPrivate(path: string): any {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || !own(stats) || stats.size > 1_000_000) throw new Error('Invalid routing state file.');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

function syncDir(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writePrivate(path: string, value: unknown) {
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

export function createRoutingStore(home: string) {
  const root = join(home, 'routing-v1');
  function directory(create = false): string {
    if (create) {
      try {
        mkdirSync(root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const stats = lstatSync(root);
    if (!stats.isDirectory() || !own(stats)) throw new Error('Invalid private routing state directory.');
    return root;
  }
  function transaction<T>(name: string, update: (path: string) => T): T {
    const path = join(directory(true), name),
      lock = `${path}.lock`;
    mkdirSync(lock, { mode: 0o700 });
    try {
      return update(path);
    } finally {
      rmdirSync(lock);
    }
  }
  function unlocked(name: string): string {
    const path = join(directory(), name);
    try {
      lstatSync(`${path}.lock`);
    } catch (error) {
      if (missing(error)) return path;
      throw error;
    }
    throw new Error('Routing state transaction is incomplete or busy.');
  }
  function ticketPath(id: unknown): string {
    if (!ticketId(id)) throw new Error('Invalid dispatch permit ID.');
    return `attempt-${id}.json`;
  }
  function readTicket(path: string, id: string): Json {
    const row = readPrivate(path);
    if (
      row?.schema !== 1 ||
      row.id !== id ||
      !['pending', 'consumed', 'activated', 'failed'].includes(row.status) ||
      !row.binding ||
      !row.request ||
      !Number.isFinite(row.issuedAt) ||
      !Number.isFinite(row.expiresAt)
    ) {
      throw new Error('Invalid dispatch permit state.');
    }
    return row;
  }
  function readPool(path: string, key: string): Json | null {
    let row: Json;
    try {
      row = readPrivate(path);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (
      row?.schema !== 1 ||
      row.key !== key ||
      !ticketId(row.attempt) ||
      !Number.isFinite(timestamp(row.observedAt)) ||
      !['held', 'released'].includes(row.status) ||
      !quotaCodes.has(row.code) ||
      (Object.hasOwn(row, 'orderFloorAt') && !(timestamp(row.orderFloorAt) >= timestamp(row.observedAt))) ||
      (row.status === 'released' &&
        (!['authoritative-reset', 'operator-reauthorization'].includes(row.releaseSource) ||
          !(timestamp(row.releasedAt) > orderFloor(row))))
    )
      throw new Error('Invalid Go pool state.');
    return row;
  }
  return {
    issue(row: Json) {
      return transaction(ticketPath(row.id), (path: string) => {
        try {
          lstatSync(path);
        } catch (error) {
          if (!missing(error)) throw error;
          writePrivate(path, { ...row, schema: 1, status: 'pending' });
          return;
        }
        throw new Error('Dispatch permit already exists.');
      });
    },
    peek(id: string) {
      return readTicket(unlocked(ticketPath(id)), id);
    },
    consume(id: string, check: (row: Json) => void, now: number) {
      return transaction(ticketPath(id), (path: string) => {
        const row = readTicket(path, id);
        if (row.status !== 'pending') throw new Error('Dispatch permit already spent.');
        check(row);
        writePrivate(path, { ...row, status: 'consumed', consumedAt: now });
        return row;
      });
    },
    activate(id: string, now: number) {
      return transaction(ticketPath(id), (path: string) => {
        const row = readTicket(path, id);
        if (row.status !== 'consumed' || !(now >= row.consumedAt)) throw new Error('No consumed dispatch permit.');
        writePrivate(path, { ...row, status: 'activated', activatedAt: now });
      });
    },
    poolStatus(pool: string, now: number = Date.now(), meterObservedAt?: string): string {
      try {
        const key = poolKey(pool),
          row = readPool(unlocked(`pool-${key}.json`), key);
        if (row && lastPoolTime(row) > now) return 'invalid';
        if (row?.status === 'released' && meterObservedAt !== undefined && !(timestamp(meterObservedAt) >= timestamp(row.releasedAt)))
          return 'stale';
        return row?.status === 'held' ? 'held' : 'clear';
      } catch (error) {
        return missing(error) ? 'clear' : 'invalid';
      }
    },
    recordQuota({ attempt, route, pool, code, observedAt, source, quotaScope }: Json, now: number = Date.now()) {
      const observed = timestamp(observedAt);
      if (
        source !== 'operator-verified-native-failure' ||
        quotaScope !== 'paid-go-pool' ||
        !quotaCodes.has(code) ||
        !Number.isFinite(observed) ||
        !(observed <= now)
      )
        throw new Error('Fresh structured Go pool failure evidence required.');
      const key = poolKey(pool);
      return transaction(ticketPath(attempt), (path: string) => {
        const row = readTicket(path, attempt),
          selected = row.selected;
        if (
          !['activated', 'failed'].includes(row.status) ||
          !(timestamp(observedAt) >= row.activatedAt) ||
          row.pool !== pool ||
          selected?.upstream !== 'opencode-go' ||
          selected.billing !== 'go-included' ||
          !['provider', 'model', 'upstream', 'account'].every(
            (field) => Object.hasOwn(selected, field) && selected[field] === route?.[field],
          )
        ) {
          throw new Error('Failure does not match an activated paid Go attempt.');
        }
        if (row.status === 'failed') {
          if (row.failure?.observedAt === observedAt && row.failure?.code === code) return;
          throw new Error('Attempt already has different terminal failure evidence.');
        }
        if (!fresh(observedAt, now, 300_000)) throw new Error('Fresh structured Go pool failure evidence required.');
        transaction(`pool-${key}.json`, (poolPath: string) => {
          const before = readPool(poolPath, key);
          const previous = before && lastPoolTime(before);
          if (previous > now) throw new Error('Future Go pool state.');
          writePrivate(poolPath, {
            schema: 1,
            key,
            status: 'held',
            attempt,
            code,
            observedAt,
            ...(previous > observed && { orderFloorAt: new Date(previous).toISOString() }),
          });
          writePrivate(path, { ...row, status: 'failed', failure: { code, observedAt } });
        });
      });
    },
    releasePool({ pool, source, observedAt, afterAttempt }: Json, now: number = Date.now()) {
      const observed = timestamp(observedAt);
      if (!['authoritative-reset', 'operator-reauthorization'].includes(source) || !Number.isFinite(observed) || !(observed <= now)) {
        throw new Error('Fresh authoritative reset or explicit operator reauthorization required.');
      }
      const key = poolKey(pool);
      return transaction(`pool-${key}.json`, (path: string) => {
        const row = readPool(path, key);
        if (!row || row.attempt !== afterAttempt || !(timestamp(observedAt) > orderFloor(row))) {
          throw new Error('Release does not match the current Go pool hold.');
        }
        if (row.status === 'released') {
          if (row.releaseSource === source && row.releasedAt === observedAt) return;
          throw new Error('Go pool hold already released.');
        }
        if (!fresh(observedAt, now, 300_000)) throw new Error('Fresh authoritative reset or explicit operator reauthorization required.');
        writePrivate(path, { ...row, status: 'released', releaseSource: source, releasedAt: observedAt });
      });
    },
  };
}
