export const KINDS = Object.freeze(['skill', 'instructions', 'mcp', 'pi-package']);
export const STATUSES = Object.freeze(['owned', 'pending', 'kept']);

function assertKey(label, value) {
  if (typeof value !== 'string' || !value || value === '__proto__') {
    throw new Error(`Invalid ownership ${label}: ${JSON.stringify(value)}`);
  }
}

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown ownership kind: ${JSON.stringify(kind)}`);
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !hash) throw new Error('An ownership hash must be a non-empty string.');
}

function address(kind, scope, name) {
  assertKind(kind);
  assertKey('scope', scope);
  assertKey('name', name);
}

function scopeOf(state, kind, scope, create) {
  if (!create) return state.owned?.[kind]?.[scope];
  state.owned ||= {};
  state.owned[kind] ||= {};
  state.owned[kind][scope] ||= {};
  return state.owned[kind][scope];
}

function entryOf(state, kind, scope, name) {
  const scoped = scopeOf(state, kind, scope, false);
  return scoped && Object.hasOwn(scoped, name) ? scoped[name] : undefined;
}

export function get(state, kind, scope, name) {
  address(kind, scope, name);
  const entry = entryOf(state, kind, scope, name);
  return entry && { ...entry };
}

export function list(state, kind, scope, status) {
  assertKind(kind);
  assertKey('scope', scope);
  const scoped = scopeOf(state, kind, scope, false) ?? {};
  return Object.entries(scoped)
    .filter(([, entry]) => status === undefined || entry.status === status)
    .map(([name, entry]) => ({ name, ...entry }));
}

export function scopes(state, kind) {
  assertKind(kind);
  return Object.keys(state.owned?.[kind] ?? {});
}

export function record(state, kind, scope, name, hash, { spec = undefined } = {}) {
  address(kind, scope, name);
  assertHash(hash);
  scopeOf(state, kind, scope, true)[name] = { hash, status: 'owned', ...(spec === undefined ? {} : { spec }) };
}

export function markPending(state, kind, scope, name, hash) {
  address(kind, scope, name);
  assertHash(hash);
  const existing = entryOf(state, kind, scope, name);
  const entry = { hash, status: 'pending' };
  if (existing?.status === 'owned') entry.previous = existing.hash;
  else if (existing?.status === 'pending' && existing.previous !== undefined) entry.previous = existing.previous;
  scopeOf(state, kind, scope, true)[name] = entry;
}

export function promote(state, kind, scope, name, hash) {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  const next = hash ?? (existing?.status === 'pending' ? existing.hash : undefined);
  assertHash(next);
  scopeOf(state, kind, scope, true)[name] = { hash: next, status: 'owned' };
}

export function forgetPending(state, kind, scope, name) {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  if (existing?.status !== 'pending') return false;
  const scoped = scopeOf(state, kind, scope, false);
  if (existing.previous === undefined) delete scoped[name];
  else scoped[name] = { hash: existing.previous, status: 'owned' };
  return true;
}

export function markKept(state, kind, scope, name) {
  address(kind, scope, name);
  const existing = entryOf(state, kind, scope, name);
  if (existing && existing.status !== 'kept') {
    throw new Error(`Cannot keep ${kind} ${scope}/${name}: Kitto already ${existing.status === 'owned' ? 'owns' : 'is writing'} it.`);
  }
  scopeOf(state, kind, scope, true)[name] = { hash: null, status: 'kept' };
}

export function release(state, kind, scope, name) {
  address(kind, scope, name);
  if (!entryOf(state, kind, scope, name)) return false;
  delete scopeOf(state, kind, scope, false)[name];
  return true;
}

export function replaceScope(state, kind, scope, { owned = {}, kept = [] } = {}) {
  assertKind(kind);
  assertKey('scope', scope);
  const next = {};
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

export function recordedHash(state, kind, scope, name) {
  const entry = get(state, kind, scope, name);
  if (!entry || entry.status === 'kept') return undefined;
  return entry.status === 'pending' ? entry.previous ?? entry.hash : entry.hash;
}

export function isOwnedWith(state, kind, scope, name, liveHash, { includePending = false } = {}) {
  const entry = get(state, kind, scope, name);
  if (!entry || typeof liveHash !== 'string') return false;
  if (entry.status === 'owned') return entry.hash === liveHash;
  if (entry.status === 'pending' && includePending) return entry.hash === liveHash || entry.previous === liveHash;
  return false;
}
