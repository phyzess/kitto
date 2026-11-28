import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import {
  BUILTIN_ROUTE_CANONICAL,
  CANONICAL_MODELS,
  KNOWN_FAMILIES,
  SUPPORTED_UPSTREAMS,
  isSupportedUpstream,
  loadLocalRoutingOverrides,
  lookupBuiltinRoute,
  lookupCanonicalModel,
  parseCanonicalIdentity,
} from '../lib/routing-catalog.ts';
import {
  BUILTIN_PRICING_SCHEDULES,
  DEEPSEEK_PEAK_UTC_SCHEDULE,
  evaluatePricingWindow,
  estimateRouteCostUsd,
  utcDateKey,
} from '../lib/routing-pricing.ts';
import { effectiveGoMultiplier, estimateGoFraction } from '../lib/go-allowance.ts';

const at = (iso: string): number => Date.parse(iso);
const MONDAY_PEAK = at('2026-11-23T02:00:00Z');
const MONDAY_OFF_PEAK = at('2026-11-23T12:00:00Z');
const approx = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

function temporaryHome(t: TestContext, files: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'kitto-routing-profiles-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(home, name), content);
  return home;
}

test('supported upstreams cover codex, go, deepseek, anthropic and openrouter', () => {
  assert.deepEqual(SUPPORTED_UPSTREAMS, ['openai-codex', 'opencode-go', 'deepseek-official', 'anthropic', 'openrouter']);
  for (const upstream of SUPPORTED_UPSTREAMS) assert.equal(isSupportedUpstream(upstream), true);
  assert.equal(isSupportedUpstream('xai'), false);
  assert.equal(isSupportedUpstream(42), false);
});

test('known families match the routing policy family list', () => {
  assert.deepEqual([...KNOWN_FAMILIES].sort(), [
    'alibaba',
    'anthropic',
    'deepseek',
    'google',
    'minimax',
    'moonshotai',
    'openai',
    'tencent',
    'xai',
    'xiaomi',
    'zhipuai',
  ]);
  for (const family of KNOWN_FAMILIES) assert.equal(parseCanonicalIdentity(`${family}/model`)?.family, family);
});

test('canonical identities normalize case and reject malformed values', () => {
  assert.deepEqual(parseCanonicalIdentity('OpenAI/GPT-6.2-Sol'), { canonicalModel: 'openai/gpt-6.2-sol', family: 'openai' });
  assert.equal(parseCanonicalIdentity('unknown/model'), null);
  assert.equal(parseCanonicalIdentity('openai'), null);
  assert.equal(parseCanonicalIdentity('openai/a/b'), null);
  assert.equal(parseCanonicalIdentity(null), null);
  assert.equal(lookupCanonicalModel('ANTHROPIC/CLAUDE-OPUS-4-6')?.tier, 2);
  assert.equal(lookupCanonicalModel('openai/unknown'), null);
});

test('canonical catalog records tiers, capabilities and pricing profiles', () => {
  const sol = lookupCanonicalModel('openai/gpt-6.2-sol');
  assert.ok(sol);
  assert.equal(sol.family, 'openai');
  assert.equal(sol.tier, 1);
  assert.equal(sol.premium, false);
  assert.equal(sol.contextWindow, 400_000);
  assert.deepEqual(sol.capabilities, { tools: true, reasoning: true, vision: true });
  assert.deepEqual(sol.pricing.base, [2, 0.1, 10]);
  assert.deepEqual(sol.pricing.long, [4, 0.2, 15]);
  assert.equal(sol.pricing.longContextThreshold, 272_000);

  const flash = lookupCanonicalModel('deepseek/deepseek-v4.1-flash-1017');
  assert.ok(flash);
  assert.equal(flash.tier, 0);
  assert.equal(flash.capabilities.vision, true);
  assert.equal(flash.pricing.pricingScheduleId, 'deepseek-peak-utc');
  assert.equal(flash.pricing.longContextThreshold, Number.POSITIVE_INFINITY);

  const opus = lookupCanonicalModel('anthropic/claude-opus-4-6');
  assert.ok(opus);
  assert.equal(opus.premium, true);
  assert.deepEqual(opus.pricing.base, [15, 1.5, 75]);

  const pro = lookupCanonicalModel('deepseek/deepseek-v4-pro');
  assert.ok(pro);
  assert.equal(pro.capabilities.vision, false);
  assert.equal(pro.pricing.pricingScheduleId, 'deepseek-peak-utc');
});

test('built-in route map resolves every upstream alias to a catalog entry', () => {
  for (const [key, canonicalId] of BUILTIN_ROUTE_CANONICAL) {
    const [upstream, model] = key.split('/');
    const entry = lookupBuiltinRoute(upstream, model);
    assert.ok(entry, key);
    assert.equal(entry.canonicalId, canonicalId);
    assert.equal(CANONICAL_MODELS.get(canonicalId), entry);
  }
  assert.equal(lookupBuiltinRoute('deepseek-official', 'deepseek-flash')?.canonicalId, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(lookupBuiltinRoute('deepseek-official', 'deepseek-v4.1-flash')?.tier, 0);
  assert.equal(lookupBuiltinRoute('opencode-go', 'deepseek-v4.1-flash')?.premium, false);
  assert.equal(lookupBuiltinRoute('openai-codex', 'gpt-6.2-sol')?.canonicalId, 'openai/gpt-6.2-sol');
  assert.equal(lookupBuiltinRoute('openai-codex', 'gpt-6.2-astra')?.tier, 2);
  assert.equal(lookupBuiltinRoute('anthropic', 'claude-sonnet-5-5')?.capabilities.vision, true);
  assert.equal(lookupBuiltinRoute('opencode-go', 'unknown-model'), null);
  assert.equal(lookupBuiltinRoute('unknown-codex', 'gpt-6.2-sol'), null);
});

test('local routing overrides report a missing profile file', (t) => {
  assert.deepEqual(loadLocalRoutingOverrides(temporaryHome(t)), { status: 'missing' });
});

test('local routing overrides accept models, holidays and pool budgets', (t) => {
  const home = temporaryHome(t, {
    'routing-profiles.json': JSON.stringify({
      schema: 1,
      models: { 'openai/gpt-6.2-sol': { premium: true, tier: 2 } },
      holidayOverrides: ['2026-12-25', '2027-01-01'],
      poolSoftBudgets: { 'go-default': { rolling5hUsd: 12.5, weeklyRequests: 200 } },
    }),
  });
  const loaded = loadLocalRoutingOverrides(home);
  assert.equal(loaded.status, 'ok');
  if (loaded.status !== 'ok') return;
  assert.equal(loaded.overrides.schema, 1);
  assert.deepEqual(loaded.overrides.models?.['openai/gpt-6.2-sol'], { premium: true, tier: 2 });
  assert.deepEqual(loaded.overrides.holidayOverrides, ['2026-12-25', '2027-01-01']);
  assert.deepEqual(loaded.overrides.poolSoftBudgets?.['go-default'], { rolling5hUsd: 12.5, weeklyRequests: 200 });
});

test('local routing overrides reject unsupported schemas and malformed values', (t) => {
  const cases: Array<[string, string]> = [
    ['unsupported-schema', JSON.stringify({ schema: 2 })],
    ['invalid-json', '{"schema":1,'],
    ['invalid-models', JSON.stringify({ schema: 1, models: [] })],
    ['invalid-holiday-overrides', JSON.stringify({ schema: 1, holidayOverrides: ['2026-1-1'] })],
    ['invalid-pool-soft-budgets', JSON.stringify({ schema: 1, poolSoftBudgets: { go: { weeklyUsd: -5 } } })],
    ['invalid-pool-soft-budgets', JSON.stringify({ schema: 1, poolSoftBudgets: { go: { monthlyUsd: 5 } } })],
    ['invalid-pool-soft-budgets', JSON.stringify({ schema: 1, poolSoftBudgets: { go: {} } })],
    ['file-too-large', ' '.repeat(256 * 1024 + 1)],
  ];
  for (const [reason, content] of cases) {
    const home = temporaryHome(t, { 'routing-profiles.json': content });
    assert.deepEqual(loadLocalRoutingOverrides(home), { status: 'invalid', reason }, reason);
  }
});

test('local routing overrides reject secret-like keys at any depth', (t) => {
  const nested = temporaryHome(t, {
    'routing-profiles.json': JSON.stringify({ schema: 1, models: { 'openai/gpt-6.2-sol': { apiKey: 'x' } } }),
  });
  assert.deepEqual(loadLocalRoutingOverrides(nested), { status: 'invalid', reason: 'secret-like-field-disallowed' });
  const array = temporaryHome(t, {
    'routing-profiles.json': JSON.stringify({ schema: 1, models: { 'openai/gpt-6.2-sol': { headers: [{ Authorization: 'x' }] } } }),
  });
  assert.deepEqual(loadLocalRoutingOverrides(array), { status: 'invalid', reason: 'secret-like-field-disallowed' });
});

test('built-in pricing schedules point at canonical models', () => {
  for (const schedule of BUILTIN_PRICING_SCHEDULES) {
    for (const model of schedule.models) {
      const entry = lookupCanonicalModel(model);
      assert.ok(entry, model);
      assert.equal(entry.pricing.pricingScheduleId, schedule.id);
    }
  }
  assert.deepEqual(
    DEEPSEEK_PEAK_UTC_SCHEDULE.windows.map((window) => [window.startMinuteUtc, window.endMinuteUtc, window.multiplier]),
    [
      [60, 240, 2],
      [360, 600, 2],
    ],
  );
  assert.equal(DEEPSEEK_PEAK_UTC_SCHEDULE.boundaryBufferMinutes, 15);
  assert.equal(utcDateKey(Date.parse('2026-11-23T23:59:59Z')), '2026-11-23');
});

test('deepseek weekday peak windows hold their exact UTC boundaries', () => {
  const model = 'deepseek/deepseek-v4.1-flash-1017';
  const before = evaluatePricingWindow(model, at('2026-11-23T00:59:59Z'));
  assert.equal(before.label, 'off-peak');
  assert.equal(before.currentMultiplier, 1);
  assert.equal(before.enteringPeakSoon, true);
  assert.equal(before.effectiveMultiplier, 2);
  assert.equal(before.minutesUntilChange, 1);
  assert.equal(before.reason, 'entering-peak-window-soon');

  const first = evaluatePricingWindow(model, at('2026-11-23T01:00:00Z'));
  assert.equal(first.label, 'peak');
  assert.equal(first.currentMultiplier, 2);
  assert.equal(first.effectiveMultiplier, 2);
  assert.equal(first.enteringPeakSoon, false);
  assert.equal(first.minutesUntilChange, 180);
  assert.equal(first.reason, 'in-peak-window');

  const endOfFirst = evaluatePricingWindow(model, at('2026-11-23T03:59:59Z'));
  assert.equal(endOfFirst.label, 'peak');
  assert.equal(endOfFirst.minutesUntilChange, 1);

  const afterFirst = evaluatePricingWindow(model, at('2026-11-23T04:00:00Z'));
  assert.equal(afterFirst.label, 'off-peak');
  assert.equal(afterFirst.enteringPeakSoon, false);
  assert.equal(afterFirst.effectiveMultiplier, 1);
  assert.equal(afterFirst.minutesUntilChange, 120);

  const second = evaluatePricingWindow(model, at('2026-11-23T06:00:00Z'));
  assert.equal(second.label, 'peak');
  assert.equal(second.minutesUntilChange, 240);

  const afterSecond = evaluatePricingWindow(model, at('2026-11-23T10:00:00Z'));
  assert.equal(afterSecond.label, 'off-peak');
  assert.equal(afterSecond.enteringPeakSoon, false);
  assert.equal(afterSecond.effectiveMultiplier, 1);
  assert.equal(afterSecond.minutesUntilChange, 900);
  assert.equal(afterSecond.reason, 'weekday-off-peak');
});

test('boundary buffer and expected duration pull the effective multiplier forward', () => {
  const model = 'deepseek/deepseek-v4-pro';
  const buffered = evaluatePricingWindow(model, at('2026-11-23T00:50:00Z'));
  assert.equal(buffered.label, 'off-peak');
  assert.equal(buffered.currentMultiplier, 1);
  assert.equal(buffered.enteringPeakSoon, true);
  assert.equal(buffered.effectiveMultiplier, 2);
  assert.equal(buffered.minutesUntilChange, 10);

  const duration = evaluatePricingWindow(model, at('2026-11-23T00:30:00Z'), { expectedDurationMinutes: 40 });
  assert.equal(duration.label, 'off-peak');
  assert.equal(duration.enteringPeakSoon, true);
  assert.equal(duration.effectiveMultiplier, 2);
  assert.equal(duration.minutesUntilChange, 30);
  assert.equal(duration.reason, 'entering-peak-window-soon');
});

test('weekends stay off-peak across both peak windows', () => {
  const model = 'deepseek/deepseek-v4.1-flash-1017';
  for (const iso of ['2026-11-21T02:00:00Z', '2026-11-21T08:00:00Z', '2026-11-22T02:00:00Z', '2026-11-22T08:00:00Z']) {
    const evaluation = evaluatePricingWindow(model, at(iso));
    assert.equal(evaluation.label, 'off-peak', iso);
    assert.equal(evaluation.currentMultiplier, 1, iso);
    assert.equal(evaluation.effectiveMultiplier, 1, iso);
    assert.equal(evaluation.enteringPeakSoon, false, iso);
    assert.equal(evaluation.reason, 'weekend-off-peak', iso);
  }
  assert.equal(evaluatePricingWindow(model, at('2026-11-21T02:00:00Z')).minutesUntilChange, null);
  assert.equal(evaluatePricingWindow(model, at('2026-11-22T08:00:00Z')).minutesUntilChange, 1020);
});

test('sunday night lookahead crosses into the monday peak window', () => {
  const model = 'deepseek/deepseek-v4.1-flash-1017';
  const buffered = evaluatePricingWindow(model, at('2026-11-22T23:50:00Z'));
  assert.equal(buffered.label, 'off-peak');
  assert.equal(buffered.enteringPeakSoon, false);
  assert.equal(buffered.effectiveMultiplier, 1);
  assert.equal(buffered.minutesUntilChange, 70);

  const long = evaluatePricingWindow(model, at('2026-11-22T23:50:00Z'), { expectedDurationMinutes: 80 });
  assert.equal(long.label, 'off-peak');
  assert.equal(long.enteringPeakSoon, true);
  assert.equal(long.effectiveMultiplier, 2);
  assert.equal(long.minutesUntilChange, 70);
});

test('holiday overrides suspend a weekday peak but keep the next window visible', () => {
  const model = 'deepseek/deepseek-v4.1-flash-1017';
  const evaluation = evaluatePricingWindow(model, at('2026-11-23T02:00:00Z'), { holidayOverrides: ['2026-11-23'] });
  assert.equal(evaluation.label, 'off-peak');
  assert.equal(evaluation.currentMultiplier, 1);
  assert.equal(evaluation.effectiveMultiplier, 1);
  assert.equal(evaluation.enteringPeakSoon, false);
  assert.equal(evaluation.minutesUntilChange, 1380);
  assert.equal(evaluation.reason, 'holiday-override');

  const nextMorning = evaluatePricingWindow(model, at('2026-11-24T00:50:00Z'));
  assert.equal(nextMorning.enteringPeakSoon, true);
  assert.equal(nextMorning.effectiveMultiplier, 2);
});

test('models without a schedule keep a standard multiplier', () => {
  const evaluation = evaluatePricingWindow('openai/gpt-6.2-sol', MONDAY_PEAK);
  assert.equal(evaluation.scheduleId, null);
  assert.equal(evaluation.label, 'standard');
  assert.equal(evaluation.currentMultiplier, 1);
  assert.equal(evaluation.effectiveMultiplier, 1);
  assert.equal(evaluation.enteringPeakSoon, false);
  assert.equal(evaluation.minutesUntilChange, null);
  assert.equal(evaluation.reason, 'no-time-window-pricing');
});

test('non-finite timestamps fall back to a standard multiplier', () => {
  const model = 'deepseek/deepseek-v4.1-flash-1017';
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(evaluatePricingWindow(model, now), {
      scheduleId: null,
      label: 'standard',
      currentMultiplier: 1,
      effectiveMultiplier: 1,
      enteringPeakSoon: false,
      minutesUntilChange: null,
      reason: 'invalid-timestamp',
    });
  }
});

test('remote multipliers apply statically or as timed windows', () => {
  const staticEvaluation = evaluatePricingWindow('openai/gpt-6.2-sol', MONDAY_OFF_PEAK, {
    remoteMultipliers: [{ factor: 1.5 }, { factor: 2 }, { factor: 0.5 }],
  });
  assert.equal(staticEvaluation.scheduleId, 'remote-multiplier');
  assert.equal(staticEvaluation.label, 'peak');
  assert.equal(staticEvaluation.currentMultiplier, 3);
  assert.equal(staticEvaluation.effectiveMultiplier, 3);
  assert.equal(staticEvaluation.reason, 'remote-static-multiplier');

  const timed = { factor: 2, utcStart: '01:00', utcEnd: '04:00', utcDays: [1] };
  const active = evaluatePricingWindow('openai/gpt-6.2-sol', MONDAY_PEAK, { remoteMultipliers: [timed] });
  assert.equal(active.scheduleId, 'remote-multiplier');
  assert.equal(active.label, 'peak');
  assert.equal(active.currentMultiplier, 2);
  assert.equal(active.minutesUntilChange, 120);

  const upcoming = evaluatePricingWindow('openai/gpt-6.2-sol', at('2026-11-23T00:50:00Z'), {
    remoteMultipliers: [timed],
    boundaryBufferMinutes: 15,
  });
  assert.equal(upcoming.label, 'off-peak');
  assert.equal(upcoming.enteringPeakSoon, true);
  assert.equal(upcoming.effectiveMultiplier, 2);
  assert.equal(upcoming.minutesUntilChange, 10);
});

test('route cost estimates combine cache hits, peak multipliers and long context', () => {
  const sol = lookupCanonicalModel('openai/gpt-6.2-sol');
  assert.ok(sol);
  const cached = estimateRouteCostUsd(sol.pricing, { input: 100_000, output: 0, cacheHitRatio: 0.5 });
  assert.ok(cached);
  approx(cached.usd, 0.105);
  assert.equal(cached.longContextApplied, false);
  assert.equal(cached.freshInputRate, 2);
  assert.equal(cached.cachedInputRate, 0.1);

  const peak = estimateRouteCostUsd(sol.pricing, { input: 100_000, output: 0, cacheHitRatio: 0.5 }, 2);
  assert.ok(peak);
  approx(peak.usd, 0.21);
  assert.equal(peak.multiplier, 2);

  const allCached = estimateRouteCostUsd(sol.pricing, { input: 100_000, output: 0, cacheHitRatio: 1 });
  assert.ok(allCached);
  approx(allCached.usd, 0.01);

  const long = estimateRouteCostUsd(sol.pricing, { input: 300_000, output: 100_000, promptTokens: 300_000 });
  assert.ok(long);
  assert.equal(long.longContextApplied, true);
  approx(long.usd, 2.7);

  const atThreshold = estimateRouteCostUsd(sol.pricing, { input: 272_000, output: 0, promptTokens: 272_000 });
  assert.ok(atThreshold);
  assert.equal(atThreshold.longContextApplied, false);
  const pastThreshold = estimateRouteCostUsd(sol.pricing, { input: 272_001, output: 0, promptTokens: 272_001 });
  assert.ok(pastThreshold);
  assert.equal(pastThreshold.longContextApplied, true);
});

test('long context pricing applies above the Grok threshold', () => {
  const grok = lookupCanonicalModel('xai/grok-4.7');
  assert.ok(grok);
  const estimate = estimateRouteCostUsd(grok.pricing, { input: 250_000, output: 0, promptTokens: 250_000 });
  assert.ok(estimate);
  assert.equal(estimate.longContextApplied, true);
  assert.equal(estimate.freshInputRate, 4);
  approx(estimate.usd, 1);
});

test('route cost estimates reject invalid inputs', () => {
  const sol = lookupCanonicalModel('openai/gpt-6.2-sol');
  assert.ok(sol);
  assert.equal(estimateRouteCostUsd(sol.pricing, { input: -1, output: 0 }), null);
  assert.equal(estimateRouteCostUsd(sol.pricing, { input: 1_000, output: 0, cacheHitRatio: 1.5 }), null);
  assert.equal(estimateRouteCostUsd(sol.pricing, { input: 1_000, output: 0 }, 0), null);
  assert.equal(estimateRouteCostUsd(sol.pricing, { input: 1_000, output: 0 }, Number.NaN), null);
});

const goCatalogItem = {
  id: 'deepseek-v4.1-flash',
  canonical_id: 'deepseek/deepseek-v4.1-flash-1017',
  cost: { text: { input: { price: 0.15 }, output: { price: 0.6 } }, multipliers: [{ factor: 2 }] },
};

test('go multipliers default to worst case and honor effective mode', () => {
  assert.equal(effectiveGoMultiplier(goCatalogItem), 2);
  assert.equal(effectiveGoMultiplier(goCatalogItem, MONDAY_PEAK), 2);
  assert.equal(effectiveGoMultiplier(goCatalogItem, MONDAY_PEAK, { mode: 'effective' }), 2);
  assert.equal(effectiveGoMultiplier(goCatalogItem, MONDAY_OFF_PEAK, { mode: 'effective' }), 1);
  assert.equal(effectiveGoMultiplier(goCatalogItem, MONDAY_PEAK, { mode: 'effective', holidayOverrides: ['2026-11-23'] }), 1);
  assert.equal(effectiveGoMultiplier({ canonical_id: 'deepseek/deepseek-v4-pro' }), 1);
  assert.equal(effectiveGoMultiplier({ canonical_id: 'deepseek/deepseek-v4-pro' }, MONDAY_PEAK, { mode: 'effective' }), 2);
  assert.equal(effectiveGoMultiplier({ cost: { multipliers: [{ factor: 0 }] } }), null);
});

test('go fraction estimates follow worst-case or effective multipliers', () => {
  const tokens = { input: 1_000_000, output: 1_000_000 };
  const worstCase = estimateGoFraction({ item: goCatalogItem, cap: 100 }, tokens);
  assert.ok(worstCase);
  approx(worstCase, 0.015);

  const effectiveOffPeak = estimateGoFraction({ item: goCatalogItem, cap: 100 }, tokens, {
    now: MONDAY_OFF_PEAK,
    mode: 'effective',
  });
  assert.ok(effectiveOffPeak);
  approx(effectiveOffPeak, 0.0075);

  const effectivePeak = estimateGoFraction({ item: goCatalogItem, cap: 100 }, tokens, {
    now: MONDAY_PEAK,
    mode: 'effective',
  });
  assert.ok(effectivePeak);
  approx(effectivePeak, 0.015);

  assert.equal(estimateGoFraction({ item: goCatalogItem, cap: 100 }, { input: 0, output: 1_000 }), null);
  assert.equal(
    estimateGoFraction({ item: { ...goCatalogItem, cost: { ...goCatalogItem.cost, multipliers: [{ factor: 0 }] } }, cap: 100 }, tokens),
    null,
  );
});
