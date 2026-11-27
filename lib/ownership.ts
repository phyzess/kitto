import type { State } from '../types/kitto.d.ts';

export type OwnershipKind = 'skill' | 'instructions' | 'mcp' | 'pi-package';
export type OwnershipStatus = 'owned' | 'pending' | 'kept';

export interface OwnershipEntry {
  hash: string | null;
  status: OwnershipStatus;
  previous?: string;
  spec?: unknown;
}

export type OwnershipScope = Record<string, OwnershipEntry>;
export type OwnershipLedger = Partial<Record<OwnershipKind, Record<string, OwnershipScope>>>;

export const KINDS: readonly OwnershipKind[] = Object.freeze(['skill', 'instructions', 'mcp', 'pi-package']);
export const STATUSES: readonly OwnershipStatus[] = Object.freeze(['owned', 'pending', 'kept']);

function assertKey(label: string, value: unknown) {
  if (typeof value !== 'string' || !value || value === '__proto__') {
    throw new Error(`Invalid ownership ${label}: ${JSON.stringify(value)}`);
  }
}

function assertKind(kind: unknown): asserts kind is OwnershipKind {
  if (!KINDS.includes(kind as OwnershipKind)) throw new Error(`Unknown ownership kind: ${JSON.stringify(kind)}`);
}

function assertHash(hash: unknown): asserts hash is string {
  if (typeof hash !== 'string' || !hash) throw new Error('An ownership hash must be a non-empty string.');
}

function address(kind: unknown, scope: unknown, name: unknown) {
  assertKind(kind);
  assertKey('scope', scope);
  assertKey('name', name);
}

function scopeOf(state: State, kind: OwnershipKind, scope: string, create: boolean): OwnershipScope | undefined {
  if (!create) return state.owned?.[kind]?.[scope];
  state.owned ||= {};
  state.owned[kind] ||= {};
  state.owned[kind][scope] ||= {};
  return state.owned[kind][scope];
}

function entryOf(state: State, kind: OwnershipKind, scope: string, name: string): OwnershipEntry | undefined {
  const scoped = scopeOf(state, kind, scope, false);
  return scoped && Object.hasOwn(scoped, name) ? scoped[name] : undefined;
}

export function get(state: State, kind: OwnershipKind, scope: string, name: string): OwnershipEntry | undefined {
  address(kind, scope, name);
  const entry = entryOf(state, kind, scope, name);
  return entry && { ...entry };
}

export function list(state: State, kind: OwnershipKind, scope: string, status?: OwnershipStatus): Array<OwnershipEntry & { name: string }> {
  assertKind(kind);
  assertKey('scope', scope);
  const scoped = scopeOf(state, kind, scope, false) ?? {};
  return Object.entries(scoped)
    .filter(([, entry]) => status === undefined || entry.status === status)
    .map(([name, entry]) => ({ name, ...entry }));
}

export function scopes(state: State, kind: OwnershipKind): string[] {
  assertKind(kind);
  return Object.keys(state.owned?.[kind] ?? {});
}

export function record(state: State, kind: OwnershipKind, scope: string, name: string, hash: string, { spec = undefined }: { spec?: unknown } = {}): void {
  address(kind, scope, name);
  assertHash(hash);
  scopeOf(state, kind, scope, true)[name] = { hash, status: 'owned', ...(spec === undefined ? {} : { spec }) };
}

export function markPending(state: State, kind: OwnershipKind, scope: string, name: string, hash: string): void {
  address(kind, scope, name);
  assertHash(hash);
  const existing = entryOf(state, kind, scope, name);
  const entry: OwnershipEntry = { hash, status: 'pending' };
  if (existing?.status === 'owned') entry.previous = existing.hash;
  else if (existing?.status === 'pending' && existing.previous !== undefined) entry.previous = existing.previous;
  scopeOf(state, kind, scope, true)[name] = entry;
}

export function promote(state: State, kind: OwnershipKind, scope: string, name: string, hash?: string): void {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  const next = hash ?? (existing?.status === 'pending' ? existing.hash : undefined);
  assertHash(next);
  scopeOf(state, kind, scope, true)[name] = { hash: next, status: 'owned' };
}

export function forgetPending(state: State, kind: OwnershipKind, scope: string, name: string): boolean {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  if (existing?.status !== 'pending') return false;
  const scoped = scopeOf(state, kind, scope, false);
  if (existing.previous === undefined) delete scoped[name];
  else scoped[name] = { hash: existing.previous, status: 'owned' };
  return true;
}

export function markKept(state: State, kind: OwnershipKind, scope: string, name: string): void {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  if (existing && existing.status !== 'kept') {
    throw new Error(`Cannot keep ${kind} ${scope}/${name}: Kitto already ${existing.status === 'owned' ? 'owns' : 'is writing'} it.`);
  }
  scopeOf(state, kind, scope, true)[name] = { hash: null, status: 'kept' };
}

export function release(state: State, kind: OwnershipKind, scope: string, name: string): boolean {
  address(kind, scope, name);
  if (!entryOf(state, kind, scope, name)) return false;
  delete scopeOf(state, kind, scope, false)[name];
  return true;
}

export function replaceScope(state: State, kind: OwnershipKind, scope: string, { owned = {}, kept = [] }: { owned?: Record<string, string>; kept?: string[] } = {}): void {
  assertKind(kind);
  assertKey('scope', scope);
  const next: OwnershipScope = {};
  for (const [name, hash] of Object.entries(owned)) {
    assertKey('name', name);
    assertHash(hash);
    next[name] = { hash, status: 'owned' };
  }
  for (const name of kept) {
    assertKey('name', name);
    if (!Object.hasOwn(next, name)) next[name] = { hash: null, status: 'kept' };
  }
  scopeOf(state, kind, scope, true);
  state.owned[kind][scope] = next;
}

export function recordedHash(state: State, kind: OwnershipKind, scope: string, name: string): string | null | undefined {
  const entry = get(state, kind, scope, name);
  if (!entry || entry.status === 'kept') return undefined;
  return entry.status === 'pending' ? entry.previous ?? entry.hash : entry.hash;
}

export function isOwnedWith(state: State, kind: OwnershipKind, scope: string, name: string, liveHash: unknown, { includePending = false }: { includePending?: boolean } = {}): boolean {
  const entry = get(state, kind, scope, name);
  if (!entry || typeof liveHash !== 'string') return false;
  if (entry.status === 'owned') return entry.hash === liveHash;
  if (entry.status === 'pending' && includePending) return entry.hash === liveHash || entry.previous === liveHash;
  return false;
}
