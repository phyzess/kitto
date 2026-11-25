import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRoutingStore, newTicketId } from '../lib/routing-state.mjs';

const now = Date.UTC(2026, 10, 25, 12);
const iso = value => new Date(value).toISOString();
const selected = { provider: 'go-alias', model: 'flash', upstream: 'opencode-go', account: 'verified-member', billing: 'go-included' };
const pool = 'verified-subscription-member';
const library = new URL('../lib/routing-state.mjs', import.meta.url).href;
function child(home, snippet, ...params) {
  const program = `import { createRoutingStore } from ${JSON.stringify(library)}; const [home, ...args] = process.argv.slice(1); const store = createRoutingStore(home); ${snippet}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', program, home, ...params], { encoding: 'utf8' });
}

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'kitto-routing-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = createRoutingStore(home), id = newTicketId();
  store.issue({ id, selected, pool, issuedAt: now - 100, expiresAt: now + 60_000, binding: {}, request: {} });
  store.consume(id, () => {}, now - 99);
  const evidence = { attempt: id, route: selected, pool, code: 'ACCOUNT_QUOTA', observedAt: iso(now),
    source: 'operator-verified-native-failure', quotaScope: 'paid-go-pool' };
  return { store, home, id, evidence };
}

test('verified quota survives processes, elapsed time and alias changes without poisoning other pools', t => {
  const { store, home, id, evidence } = fixture(t);
  assert.throws(() => store.recordQuota(evidence, now), /activated paid Go attempt/);
  store.activate(id, now - 20);
  assert.throws(() => store.recordQuota({ ...evidence, route: { ...selected, model: 'other' } }, now), /does not match/);
  assert.throws(() => store.recordQuota({ ...evidence, quotaScope: 'model' }, now), /Fresh structured/);
  const writer = child(home, 'store.recordQuota(JSON.parse(args[0]), Number(args[1]))', JSON.stringify(evidence), String(now));
  assert.equal(writer.status, 0, writer.stderr);
  const reader = child(home, 'console.log(store.poolStatus(args[0], Number(args[1])), store.poolStatus("different-pool", Number(args[1])))',
    pool, String(now + 30 * 24 * 60 * 60_000));
  assert.equal(reader.status, 0, reader.stderr);
  assert.equal(reader.stdout.trim(), 'held clear');
  assert.throws(() => store.releasePool({ pool, source: 'authoritative-reset', observedAt: iso(now), afterAttempt: id }, now), /does not match/);
  assert.throws(() => store.releasePool({ pool, source: 'clock-expiry', observedAt: iso(now + 20), afterAttempt: id }, now + 20), /Fresh authoritative/);
  const release = { pool, source: 'authoritative-reset', observedAt: iso(now + 20), afterAttempt: id };
  store.releasePool(release, now + 20);
  store.releasePool(release, now + 20);
  assert.equal(store.poolStatus(pool, now + 20), 'clear');
  assert.equal(store.poolStatus(pool, now + 20, iso(now + 19)), 'stale');
  assert.equal(store.poolStatus(pool, now + 20, iso(now + 20)), 'clear');
  store.recordQuota(evidence, now + 20);
  assert.equal(store.poolStatus(pool, now + 20), 'clear');
  assert.equal(store.poolStatus(pool, now + 19), 'invalid');
});

test('interrupted writes and invalid pool rows fail closed for that pool alone', t => {
  const { store, home } = fixture(t);
  const key = createHash('sha256').update(`opencode-go\0${pool}`).digest('hex');
  const base = join(home, 'routing-v1', `pool-${key}.json`);
  mkdirSync(`${base}.lock`, { mode: 0o700 });
  assert.equal(store.poolStatus(pool, now), 'invalid');
  assert.equal(store.poolStatus('different-pool', now), 'clear');
  rmSync(`${base}.lock`, { dir: true, recursive: true });
  writeFileSync(base, '{broken', { mode: 0o600 });
  assert.equal(store.poolStatus(pool, now), 'invalid');
  assert.equal(store.poolStatus('different-pool', now), 'clear');
});

test('distinct quota evidence at the release timestamp installs a hold in either order', t => {
  for (const releaseFirst of [true, false]) {
    const { store, id, evidence } = fixture(t);
    store.activate(id, now - 20);
    store.recordQuota(evidence, now);
    const nextId = newTicketId();
    store.issue({ id: nextId, selected, pool, issuedAt: now - 100, expiresAt: now + 60_000, binding: {}, request: {} });
    store.consume(nextId, () => {}, now - 99);
    store.activate(nextId, now - 20);
    const sameTime = now + 20;
    const next = { ...evidence, attempt: nextId, observedAt: iso(sameTime) };
    const release = { pool, source: 'authoritative-reset', observedAt: iso(sameTime), afterAttempt: id };
    if (releaseFirst) {
      store.releasePool(release, sameTime);
      assert.equal(store.poolStatus(pool, sameTime), 'clear');
    }
    store.recordQuota(next, sameTime);
    assert.equal(store.poolStatus(pool, sameTime), 'held');
    assert.throws(() => store.releasePool(release, sameTime), /does not match/);
    assert.throws(() => store.releasePool({ ...release, afterAttempt: nextId }, sameTime), /does not match/);
    const finalRelease = { ...release, afterAttempt: nextId, observedAt: iso(sameTime + 1) };
    store.releasePool(finalRelease, sameTime + 1);
    store.releasePool(finalRelease, sameTime + 600_000);
    store.recordQuota(next, sameTime + 600_000);
    store.recordQuota(evidence, sameTime + 600_000);
    assert.equal(store.poolStatus(pool, sameTime + 600_000), 'clear');
  }
});

test('a distinct out-of-order failure holds without permitting an older release', t => {
  const { store, id, evidence } = fixture(t);
  store.activate(id, now - 20);
  store.recordQuota(evidence, now);
  const release = { pool, source: 'authoritative-reset', observedAt: iso(now + 20), afterAttempt: id };
  store.releasePool(release, now + 20);
  const nextId = newTicketId();
  store.issue({ id: nextId, selected, pool, issuedAt: now - 100, expiresAt: now + 60_000, binding: {}, request: {} });
  store.consume(nextId, () => {}, now - 99);
  store.activate(nextId, now - 20);
  store.recordQuota({ ...evidence, attempt: nextId, observedAt: iso(now + 10) }, now + 20);
  assert.equal(store.poolStatus(pool, now + 20), 'held');
  assert.throws(() => store.releasePool({ ...release, afterAttempt: nextId }, now + 20), /does not match/);
  store.releasePool({ ...release, afterAttempt: nextId, observedAt: iso(now + 21) }, now + 21);
  assert.equal(store.poolStatus(pool, now + 21), 'clear');
});
