import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { requireCliBin } from './helpers/kitto-fixture.ts';
import { createPoolHealthStore, poolHealthKey, readProbeCache, writeProbeCache } from '../lib/routing-pool-health.ts';
import { runRoutingProbe } from '../lib/routing-probe.ts';
import type { ProbeSnapshot } from '../lib/routing-probe.ts';
import type { UpstreamId } from '../lib/routing-catalog.ts';

const now = Date.parse('2026-11-23T02:00:00Z');
const offPeak = Date.parse('2026-11-23T12:00:00Z');
const iso = (value: number): string => new Date(value).toISOString();
const reset = iso(now + 2 * 60 * 60_000);
const json = (value: string): Record<string, any> => JSON.parse(value);

function temporaryHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'kitto-routing-probe-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function writeRow(home: string, upstream: UpstreamId, pool: string, row: Record<string, unknown>): string {
  mkdirSync(join(home, 'routing-v2'), { recursive: true, mode: 0o700 });
  const file = join(home, 'routing-v2', `pool-${poolHealthKey(upstream, pool)}.json`);
  writeFileSync(file, JSON.stringify(row), { mode: 0o600 });
  return file;
}

const usage = (rolling: number, weekly: number, monthly: number, rollingStatus = 'ok') => ({
  usage: {
    rolling: { status: rollingStatus, percent: rolling, resetsAt: reset },
    weekly: { status: 'ok', percent: weekly, resetsAt: reset },
    monthly: { status: 'ok', percent: monthly, resetsAt: reset },
  },
});

const keyEnv = {
  KITTO_GO_METADATA_KEY: 'sk-go-synthetic',
  DEEPSEEK_API_KEY: 'sk-deepseek-synthetic',
  OPENROUTER_API_KEY: 'sk-or-synthetic',
};

test('a quota hold expires at its reset timestamp and then demands a reprobe', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const resetsAt = iso(now + 3_600_000);
  const record = store.recordFailure({ pool: 'opencode-go', upstream: 'opencode-go', kind: 'quota', window: '5h', resetsAt }, now);
  assert.equal(record.status, 'held-quota');
  assert.equal(record.resetsAt, resetsAt);
  assert.equal(record.source, 'report-failure');
  assert.equal(record.failureKind, 'quota');
  const held = store.getEffective('opencode-go', 'opencode-go', now);
  assert.equal(held.status, 'held-quota');
  assert.equal(held.available, false);
  assert.equal(held.needsReprobe, false);
  assert.equal(held.window, '5h');
  assert.equal(held.resetsAt, resetsAt);
  const elapsed = store.getEffective('opencode-go', 'opencode-go', now + 3_600_000);
  assert.equal(elapsed.status, 'needs-reprobe');
  assert.equal(elapsed.available, true);
  assert.equal(elapsed.needsReprobe, true);
  assert.equal(elapsed.reason, 'quota-window-reset-elapsed');
});

test('a quota hold without a reset never expires on its own', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const record = store.recordFailure({ pool: 'personal-go', upstream: 'opencode-go', kind: 'quota' }, now);
  assert.equal(record.window, 'unknown');
  assert.equal('resetsAt' in record, false);
  const later = now + 30 * 24 * 3_600_000;
  assert.equal(store.getEffective('personal-go', 'opencode-go', later).status, 'held-quota');
  assert.equal(store.getEffective('personal-go', 'opencode-go', later).available, false);
  const cleared = store.clearPool('personal-go', 'opencode-go', 'operator-cleared', later);
  assert.equal(cleared.status, 'healthy');
  assert.equal(cleared.source, 'manual-clear');
  assert.equal(store.getEffective('personal-go', 'opencode-go', later).reason, 'operator-cleared');
  store.recordFailure({ pool: 'personal-go', upstream: 'opencode-go', kind: 'quota' }, later);
  const probed = store.recordProbeResult({ pool: 'personal-go', upstream: 'opencode-go', status: 'healthy' }, later + 1_000);
  assert.equal(probed.source, 'probe');
  assert.equal(store.getEffective('personal-go', 'opencode-go', later + 1_000).status, 'healthy');
});

test('rate limits default to a fifteen minute cooldown', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const record = store.recordFailure({ pool: 'opencode-go', upstream: 'opencode-go', kind: 'rate_limit' }, now);
  assert.equal(record.window, '5h');
  assert.equal(record.resetsAt, iso(now + 15 * 60_000));
  assert.equal(record.reason, 'rate-limit-reached');
  assert.equal(store.getEffective('opencode-go', 'opencode-go', now + 15 * 60_000 - 1).available, false);
  const elapsed = store.getEffective('opencode-go', 'opencode-go', now + 15 * 60_000);
  assert.equal(elapsed.status, 'needs-reprobe');
  assert.equal(elapsed.reason, 'quota-window-reset-elapsed');
});

test('outages back off exponentially and recover after the cooldown', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const first = store.recordFailure({ pool: 'openai-codex', upstream: 'openai-codex', kind: 'outage' }, now);
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.resetsAt, iso(now + 2 * 60_000));
  const second = store.recordFailure({ pool: 'openai-codex', upstream: 'openai-codex', kind: 'outage' }, now + 60_000);
  assert.equal(second.consecutiveFailures, 2);
  assert.equal(second.resetsAt, iso(now + 60_000 + 5 * 60_000));
  const third = store.recordFailure({ pool: 'openai-codex', upstream: 'openai-codex', kind: 'outage' }, now + 120_000);
  assert.equal(third.consecutiveFailures, 3);
  assert.equal(third.resetsAt, iso(now + 120_000 + 15 * 60_000));
  assert.equal(store.getEffective('openai-codex', 'openai-codex', now + 120_000 + 15 * 60_000 - 1).available, false);
  const recovered = store.getEffective('openai-codex', 'openai-codex', now + 120_000 + 15 * 60_000);
  assert.equal(recovered.status, 'needs-reprobe');
  assert.equal(recovered.available, true);
  assert.equal(recovered.needsReprobe, true);
  assert.equal(recovered.reason, 'outage-cooldown-elapsed');
  const probed = store.recordProbeResult(
    { pool: 'openai-codex', upstream: 'openai-codex', status: 'healthy' },
    now + 120_000 + 15 * 60_000,
  );
  assert.equal('consecutiveFailures' in probed, false);
  assert.equal(store.getEffective('openai-codex', 'openai-codex', now + 120_000 + 15 * 60_000).status, 'healthy');
});

test('authentication failures never expire on their own', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const record = store.recordFailure({ pool: 'anthropic', upstream: 'anthropic', kind: 'auth', resetsAt: iso(now + 1_000) }, now);
  assert.equal(record.status, 'auth-broken');
  assert.equal(record.reason, 'authentication-failed');
  assert.equal('resetsAt' in record, false);
  const far = now + 365 * 24 * 3_600_000;
  const health = store.getEffective('anthropic', 'anthropic', far);
  assert.equal(health.status, 'auth-broken');
  assert.equal(health.available, false);
  assert.equal(health.needsReprobe, false);
});

test('corrupt, busy and future-dated pool rows fail closed', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  const file = writeRow(home, 'openrouter', 'openrouter', { broken: true });
  const corrupt = store.getEffective('openrouter', 'openrouter', now);
  assert.equal(corrupt.status, 'needs-reprobe');
  assert.equal(corrupt.available, false);
  assert.equal(corrupt.needsReprobe, true);
  assert.equal(corrupt.reason, 'pool-health-state-invalid');
  const row = {
    schema: 1,
    pool: 'openrouter',
    upstream: 'openrouter',
    status: 'held-quota',
    updatedAt: iso(now),
    observedAt: iso(now),
    source: 'report-failure',
  };
  writeFileSync(file, JSON.stringify(row), { mode: 0o600 });
  assert.equal(store.getEffective('openrouter', 'openrouter', now).status, 'held-quota');
  mkdirSync(`${file}.lock`, { mode: 0o700 });
  assert.equal(store.getEffective('openrouter', 'openrouter', now).needsReprobe, true);
  rmSync(`${file}.lock`, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...row, observedAt: iso(now + 120_000) }), { mode: 0o600 });
  assert.equal(store.getEffective('openrouter', 'openrouter', now).needsReprobe, true);
  writeFileSync(file, JSON.stringify({ ...row, observedAt: iso(now) }), { mode: 0o600 });
  chmodSync(file, 0o644);
  assert.equal(store.getEffective('openrouter', 'openrouter', now).needsReprobe, true);
});

test('pool listing includes custom pools recorded by operators', (t) => {
  const home = temporaryHome(t);
  const store = createPoolHealthStore(home);
  store.recordFailure({ pool: 'personal-codex', upstream: 'openai-codex', kind: 'quota', window: 'weekly' }, now);
  store.recordProbeResult({ pool: 'opencode-go', upstream: 'opencode-go', status: 'tight' }, now);
  const rows = store.listAll(now);
  assert.deepEqual(
    rows.map((row) => [row.pool, row.upstream, row.status]),
    [
      ['opencode-go', 'opencode-go', 'tight'],
      ['personal-codex', 'openai-codex', 'held-quota'],
    ],
  );
  assert.equal(createPoolHealthStore(join(home, 'missing')).listAll(now).length, 0);
});

test('offline probe reports UTC pricing windows and ledger state without using the network', async (t) => {
  const home = temporaryHome(t);
  createPoolHealthStore(home).recordFailure(
    { pool: 'deepseek-official', upstream: 'deepseek-official', kind: 'quota', window: 'balance' },
    now,
  );
  const snapshot = await runRoutingProbe({ kittoHomePath: home, now, allowNetwork: false, writeCache: false });
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.networkUsed, false);
  assert.equal(snapshot.observedAt, iso(now));
  assert.equal(snapshot.pricingWindows['deepseek/deepseek-v4.1-flash-1017'].label, 'peak');
  assert.equal(snapshot.pricingWindows['deepseek/deepseek-v4-pro'].label, 'peak');
  assert.equal(snapshot.pools['opencode-go'].probeMode, 'skipped-offline');
  assert.equal(snapshot.pools['openai-codex'].probeMode, 'passive-only');
  assert.equal(snapshot.pools['anthropic'].probeMode, 'passive-only');
  assert.equal(snapshot.pools['deepseek-official'].health.status, 'held-quota');
  assert.equal(snapshot.pools['deepseek-official'].health.available, false);
  assert.equal(snapshot.pools['deepseek-official'].health.window, 'balance');
  assert.equal(snapshot.pools['opencode-go'].health.status, 'healthy');
  const later = await runRoutingProbe({ kittoHomePath: home, now: offPeak, allowNetwork: false, writeCache: false });
  assert.equal(later.pricingWindows['deepseek/deepseek-v4-pro'].label, 'off-peak');
});

test('opencode go probes report exhaustion, pressure and health from the usage meter', async (t) => {
  const target = [{ pool: 'opencode-go', upstream: 'opencode-go' as const }];
  const probe = async (rolling: number, weekly: number, monthly: number, rollingStatus = 'ok'): Promise<ProbeSnapshot> =>
    runRoutingProbe({
      kittoHomePath: temporaryHome(t),
      pools: target,
      allowNetwork: true,
      writeCache: false,
      now,
      env: keyEnv,
      fetcher: async (): Promise<Response> => Response.json(usage(rolling, weekly, monthly, rollingStatus)),
    });
  const exhausted = await probe(100, 10, 10, 'rate-limited');
  assert.equal(exhausted.networkUsed, true);
  assert.equal(exhausted.pools['opencode-go'].probeMode, 'active-api');
  assert.equal(exhausted.pools['opencode-go'].goMeter?.status, 'exhausted');
  assert.equal(exhausted.pools['opencode-go'].health.status, 'held-quota');
  assert.equal(exhausted.pools['opencode-go'].health.available, false);
  assert.equal(exhausted.pools['opencode-go'].health.window, 'rolling');
  assert.equal(exhausted.pools['opencode-go'].health.resetsAt, reset);
  const pressure = await probe(10, 88, 10);
  assert.equal(pressure.pools['opencode-go'].health.status, 'tight');
  assert.equal(pressure.pools['opencode-go'].health.available, true);
  assert.equal(pressure.pools['opencode-go'].health.tight, true);
  assert.equal(pressure.pools['opencode-go'].health.window, 'weekly');
  const healthy = await probe(10, 10, 10);
  assert.equal(healthy.pools['opencode-go'].health.status, 'healthy');
  assert.equal(healthy.pools['opencode-go'].goMeter?.status, 'available');
});

test('simultaneous go exhaustion holds the pool until the longest window resets', async (t) => {
  const rollingReset = iso(now + 2 * 60 * 60_000);
  const weeklyReset = iso(now + 3 * 24 * 60 * 60_000);
  const snapshot = await runRoutingProbe({
    kittoHomePath: temporaryHome(t),
    pools: [{ pool: 'opencode-go', upstream: 'opencode-go' }],
    allowNetwork: true,
    writeCache: false,
    now,
    env: keyEnv,
    fetcher: async (): Promise<Response> =>
      Response.json({
        usage: {
          rolling: { status: 'rate-limited', percent: 100, resetsAt: rollingReset },
          weekly: { status: 'rate-limited', percent: 100, resetsAt: weeklyReset },
          monthly: { status: 'ok', percent: 10, resetsAt: weeklyReset },
        },
      }),
  });
  const health = snapshot.pools['opencode-go'].health;
  assert.equal(health.status, 'held-quota');
  assert.equal(health.available, false);
  assert.equal(health.window, 'weekly');
  assert.equal(health.resetsAt, weeklyReset);
});

test('deepseek balance and openrouter credit probes map to pool health', async (t) => {
  const deepseek = async (isAvailable: boolean): Promise<ProbeSnapshot> =>
    runRoutingProbe({
      kittoHomePath: temporaryHome(t),
      pools: [{ pool: 'deepseek-official', upstream: 'deepseek-official' }],
      allowNetwork: true,
      writeCache: false,
      now,
      env: keyEnv,
      fetcher: async (): Promise<Response> => Response.json({ is_available: isAvailable }),
    });
  const exhausted = await deepseek(false);
  assert.equal(exhausted.pools['deepseek-official'].balanceAvailable, false);
  assert.equal(exhausted.pools['deepseek-official'].health.status, 'held-quota');
  assert.equal(exhausted.pools['deepseek-official'].health.window, 'balance');
  const available = await deepseek(true);
  assert.equal(available.pools['deepseek-official'].balanceAvailable, true);
  assert.equal(available.pools['deepseek-official'].health.status, 'healthy');
  const openrouter = async (limit: number | null, remaining: number | null): Promise<ProbeSnapshot> =>
    runRoutingProbe({
      kittoHomePath: temporaryHome(t),
      pools: [{ pool: 'openrouter', upstream: 'openrouter' }],
      allowNetwork: true,
      writeCache: false,
      now,
      env: keyEnv,
      fetcher: async (): Promise<Response> => Response.json({ data: { limit, limit_remaining: remaining } }),
    });
  const empty = await openrouter(100, 0);
  assert.equal(empty.pools['openrouter'].creditRemainingRatio, 0);
  assert.equal(empty.pools['openrouter'].health.status, 'held-quota');
  assert.equal(empty.pools['openrouter'].health.window, 'balance');
  const low = await openrouter(100, 10);
  assert.equal(low.pools['openrouter'].creditRemainingRatio, 0.1);
  assert.equal(low.pools['openrouter'].health.status, 'tight');
  const fine = await openrouter(100, 50);
  assert.equal(fine.pools['openrouter'].creditRemainingRatio, 0.5);
  assert.equal(fine.pools['openrouter'].health.status, 'healthy');
  const unlimited = await openrouter(null, null);
  assert.equal(unlimited.pools['openrouter'].health.status, 'healthy');
});

test('a single failing probe is isolated and never leaks credentials or payloads', async (t) => {
  const pools = [
    { pool: 'opencode-go', upstream: 'opencode-go' as const },
    { pool: 'deepseek-official', upstream: 'deepseek-official' as const },
  ];
  const failures: Array<[string, (url: string) => Promise<Response>]> = [
    ['probe-transport-error', async () => Promise.reject(new Error('socket closed'))],
    ['probe-http-error', async () => new Response('secret payload', { status: 500 })],
    ['probe-redirect', async () => new Response('secret payload', { status: 302 })],
    ['probe-invalid-json', async () => new Response('secret payload', { status: 200 })],
    ['probe-timeout', async () => new Promise<Response>(() => {})],
  ];
  for (const [reason, failing] of failures) {
    const home = temporaryHome(t);
    const snapshot = await runRoutingProbe({
      kittoHomePath: home,
      pools,
      allowNetwork: true,
      now,
      timeoutMs: 25,
      env: keyEnv,
      fetcher: async (url: string): Promise<Response> =>
        url.includes('deepseek') ? failing(url) : Promise.resolve(Response.json(usage(10, 10, 10))),
    });
    assert.equal(snapshot.pools['opencode-go'].health.status, 'healthy', reason);
    assert.equal(snapshot.pools['deepseek-official'].probeMode, 'probe-error', reason);
    assert.ok(
      snapshot.warnings.some((warning) => warning === `probe-error:deepseek-official:${reason}`),
      snapshot.warnings.join(','),
    );
    const serialized = JSON.stringify(snapshot) + readFileSync(join(home, 'routing-v2', 'probe-cache.json'), 'utf8');
    assert.equal(serialized.includes('synthetic'), false);
    assert.equal(serialized.includes('secret payload'), false);
  }
});

test('local burn-rate above the soft budget marks a passive pool tight', async (t) => {
  const home = temporaryHome(t);
  writeFileSync(
    join(home, 'routing-profiles.json'),
    JSON.stringify({
      schema: 1,
      holidayOverrides: ['2026-11-23'],
      poolSoftBudgets: { 'openai-codex': { rolling5hUsd: 100, weeklyRequests: 400 } },
    }),
  );
  const snapshot = await runRoutingProbe({
    kittoHomePath: home,
    now,
    allowNetwork: false,
    writeCache: false,
    localUsage: { 'openai-codex': { rolling5hUsd: 80 } },
  });
  assert.equal(snapshot.pools['openai-codex'].burnRateTight, true);
  assert.equal(snapshot.pools['openai-codex'].health.status, 'tight');
  assert.equal(snapshot.pools['openai-codex'].health.tight, true);
  assert.equal(snapshot.pools['openai-codex'].health.reason, 'local-burn-rate-near-soft-budget');
  assert.equal(snapshot.pools['opencode-go'].burnRateTight, undefined);
  assert.equal(snapshot.pricingWindows['deepseek/deepseek-v4-pro'].label, 'off-peak');
  assert.equal(snapshot.pricingWindows['deepseek/deepseek-v4-pro'].reason, 'holiday-override');
  writeFileSync(join(home, 'routing-profiles.json'), JSON.stringify({ schema: 2 }));
  const invalid = await runRoutingProbe({ kittoHomePath: home, now, allowNetwork: false, writeCache: false });
  assert.ok(invalid.warnings.includes('local-overrides-invalid:unsupported-schema'));
  assert.equal(invalid.pools['openai-codex'].burnRateTight, undefined);
});

test('probe cache writes privately and expires stale snapshots', (t) => {
  const home = temporaryHome(t);
  writeProbeCache(home, { schema: 1, observedAt: iso(now), marker: 'cached' });
  const file = join(home, 'routing-v2', 'probe-cache.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readProbeCache<{ marker: string }>(home, now, 1_000), { schema: 1, observedAt: iso(now), marker: 'cached' });
  assert.equal(readProbeCache(home, now + 2_000, 1_000), null);
  assert.equal(readProbeCache(join(home, 'missing'), now), null);
  chmodSync(file, 0o644);
  assert.equal(readProbeCache(home, now), null);
  chmodSync(file, 0o600);
  writeFileSync(file, '{broken', { mode: 0o600 });
  assert.equal(readProbeCache(home, now), null);
});

test('probe cache records the snapshot a probe wrote', async (t) => {
  const home = temporaryHome(t);
  const snapshot = await runRoutingProbe({ kittoHomePath: home, now, allowNetwork: false });
  const cached = readProbeCache<ProbeSnapshot>(home, now);
  assert.equal(cached?.schema, 1);
  assert.equal(cached?.pools['opencode-go'].probeMode, 'skipped-offline');
  assert.equal(readProbeCache(home, now + 400_000), null);
  assert.equal(snapshot.networkUsed, false);
});

test('route CLI records, probes and clears a pool hold end to end', (t) => {
  const home = temporaryHome(t);
  const env = { ...process.env, HOME: home, KITTO_HOME: home };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [requireCliBin(), 'route', ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const recorded = run(
    'report-failure',
    '--pool',
    'personal-codex',
    '--upstream',
    'openai-codex',
    '--kind',
    'quota',
    '--window',
    '5h',
    '--resets-at',
    iso(now + 3_600_000),
    '--reason',
    'operator-observed',
    '--now',
    iso(now),
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  const recordedOutput = json(recorded.stdout);
  assert.equal(recordedOutput.status, 'recorded');
  assert.equal(recordedOutput.record.status, 'held-quota');
  assert.equal(recordedOutput.record.pool, 'personal-codex');
  const held = run('probe', '--now', iso(now + 60_000));
  assert.equal(held.status, 0, held.stderr);
  assert.equal(json(held.stdout).pools['personal-codex'].health.status, 'held-quota');
  assert.equal(json(held.stdout).pools['personal-codex'].upstream, 'openai-codex');
  const cleared = run(
    'clear-pool',
    '--pool',
    'personal-codex',
    '--upstream',
    'openai-codex',
    '--reason',
    'operator-cleared',
    '--now',
    iso(now + 120_000),
  );
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(json(cleared.stdout).status, 'cleared');
  const healthy = run('probe', '--now', iso(now + 180_000), '--no-cache', '--json');
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(json(healthy.stdout).pools['personal-codex'].health.status, 'healthy');
  const invalidKind = run('report-failure', '--pool', 'personal-codex', '--upstream', 'openai-codex', '--kind', 'bogus');
  assert.notEqual(invalidKind.status, 0);
  assert.match(invalidKind.stderr, /Usage: kitto route report-failure/);
  const missingFlag = run('report-failure', '--pool', 'personal-codex');
  assert.notEqual(missingFlag.status, 0);
  assert.match(missingFlag.stderr, /Usage: kitto route report-failure/);
  const unknownFlag = run('probe', '--bogus');
  assert.notEqual(unknownFlag.status, 0);
  assert.match(unknownFlag.stderr, /Usage: kitto route probe/);
  const badPools = run('probe', '--pools', 'not-a-real-upstream');
  assert.notEqual(badPools.status, 0);
  assert.match(badPools.stderr, /Usage: kitto route probe/);
});
