import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';
import { resolveTaskRoutes } from '../lib/routing-resolver.ts';
import { routeQuestions } from '../lib/task-route-questions.ts';
import { evaluateDshTaskRoutes } from '../integration/dsh-task-routing.ts';
import { evaluatePiTaskRoutes } from '../integration/pi-task-routing.ts';
import { evaluateCodexTaskRoutes } from '../integration/codex-task-routing.ts';
import { requireCliBin } from './helpers/kitto-fixture.ts';
import type { ProbeSnapshot } from '../lib/routing-probe.ts';
import type { PlanInput } from '../lib/task-route-plan.ts';
import type { ResolvedTaskPlan } from '../lib/routing-resolver.ts';

type Json = Record<string, any>;

const peak = Date.parse('2026-11-25T02:00:00Z');
const offPeak = Date.parse('2026-11-28T12:00:00Z');
const soon = Date.parse('2026-11-25T00:50:00Z');
const iso = (value: number): string => new Date(value).toISOString();
const resetsAt = iso(peak + 3_600_000);

const base = {
  available: true,
  dispatchable: true,
  fallback: 'none',
  dataAllowed: true,
  accountVerified: true,
  efforts: ['low', 'medium', 'high'],
};
const goRoute = (model: string, canonicalModel: string, extra: Json = {}): Json => ({
  ...base,
  provider: 'opencode-go',
  model,
  canonicalModel,
  upstream: 'opencode-go',
  account: 'my-go',
  billing: 'go-included',
  quotaReady: true,
  ...extra,
});
const deepseekFlash = goRoute('deepseek-v4.1-flash', 'deepseek/deepseek-v4.1-flash-1017');
const glmFlash = goRoute('glm-5.3-flash', 'zhipuai/glm-5.3-flash');
const glm = goRoute('glm-5.3', 'zhipuai/glm-5.3');
const kimi = goRoute('kimi-k3.1-pro', 'moonshotai/kimi-k3.1-pro');
const grok = goRoute('grok-4.7', 'xai/grok-4.7');
const sol = {
  ...base,
  provider: 'openai-codex',
  model: 'gpt-6.2-sol',
  canonicalModel: 'openai/gpt-6.2-sol',
  upstream: 'openai-codex',
  account: 'codex-personal',
  billing: 'subscription',
};
const metered = {
  ...base,
  provider: 'deepseek-official',
  model: 'deepseek-v4.1-flash',
  canonicalModel: 'deepseek/deepseek-v4.1-flash-1017',
  upstream: 'deepseek-official',
  account: 'deepseek-account',
  billing: 'metered',
  estimateUsd: 0.42,
};

function role(id: string, extra: Json = {}): Json {
  return { id, workRevision: 'diff-1', data: 'personal', effects: 'read', dependencies: [], ...extra };
}
function plan(roles: Json[], routes: Json[], extra: Json = {}, at: number = peak): Json {
  return {
    id: 'work-item',
    host: { kind: 'dsh', surface: 'teams', session: 'test-session', observedAt: iso(at), routes },
    roles,
    ...extra,
  };
}
function probe(pools: Record<string, Json> = {}, extra: Json = {}): ProbeSnapshot {
  return {
    schema: 1,
    observedAt: iso(peak),
    networkUsed: false,
    pricingWindows: {},
    pools: pools as unknown as ProbeSnapshot['pools'],
    warnings: [],
    ...extra,
  };
}
const adapterInput = (value: Json): PlanInput => value as unknown as PlanInput;
function poolEntry(pool: string, upstream: string, status: string, extra: Json = {}): Json {
  return {
    pool,
    upstream,
    probeMode: 'skipped-offline',
    health: {
      pool,
      upstream,
      status,
      available: status === 'healthy' || status === 'tight',
      tight: status === 'tight',
      needsReprobe: false,
      reason: status,
      ...extra,
    },
  };
}
const rowOf = (result: ResolvedTaskPlan, id: string) => {
  const row = result.rows.find((item) => item.id === id);
  assert.ok(row, `no row for ${id}`);
  return row;
};
const models = (result: ResolvedTaskPlan, id: string) => rowOf(result, id).fallbackChain.map((option) => option.model);

test('deepseek weekday peak reroutes batch to the same-tier off-peak alternative', () => {
  const input = plan([role('batch-1', { choice: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })], [deepseekFlash, glmFlash]);
  const result = resolveTaskRoutes(input, { now: peak });
  const row = rowOf(result, 'batch-1');
  assert.equal(row.status, 'auto-rerouted');
  assert.equal(row.rerouteReason, 'deepseek-peak-avoided');
  assert.equal(row.route?.model, 'glm-5.3-flash');
  assert.deepEqual(row.autoReroutedFrom, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' });
  const peakOption = row.fallbackChain.find((option) => option.model === 'deepseek-v4.1-flash');
  assert.equal(peakOption?.pricingLabel, 'peak');
  assert.ok(peakOption && peakOption.effectiveMultiplier > 1);
  assert.ok(models(result, 'batch-1').includes('deepseek-v4.1-flash'));
  assert.equal(row.route?.model, 'glm-5.3-flash');
  assert.ok(!row.fallbackChain.some((option) => option.model === 'glm-5.3-flash'));
  assert.equal(row.fallbackChain[0].model, 'deepseek-v4.1-flash');
  assert.deepEqual(result.ready, ['batch-1']);
});

test('a peak-only route stays selectable as the last resort and says so', () => {
  const input = plan([role('verify-1', { choice: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })], [deepseekFlash]);
  const result = resolveTaskRoutes(input, { now: peak });
  const row = rowOf(result, 'verify-1');
  assert.equal(row.status, 'ready');
  assert.equal(row.route?.model, 'deepseek-v4.1-flash');
  assert.ok(row.trace.includes('peak-fallback-only'));
  assert.equal(result.status, 'ready');
});

test('off-peak deepseek is the first choice for batch and verify roles', () => {
  const input = plan([role('batch-1'), role('verify-1')], [deepseekFlash, glmFlash], {}, offPeak);
  const result = resolveTaskRoutes(input, { now: offPeak });
  for (const id of ['batch-1', 'verify-1']) {
    const row = rowOf(result, id);
    assert.equal(row.status, 'ready');
    assert.equal(row.route?.model, 'deepseek-v4.1-flash');
    assert.equal(row.route?.pricingLabel, 'off-peak');
    assert.equal(row.fallbackChain[0].model, 'glm-5.3-flash');
    assert.ok(!row.fallbackChain.some((option) => option.model === 'deepseek-v4.1-flash'));
  }
});

test('ten minutes before the peak boundary deepseek is avoided proactively', () => {
  const input = plan(
    [role('batch-1', { choice: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } })],
    [deepseekFlash, glmFlash],
    {},
    soon,
  );
  const result = resolveTaskRoutes(input, { now: soon });
  const row = rowOf(result, 'batch-1');
  assert.equal(row.status, 'auto-rerouted');
  assert.equal(row.rerouteReason, 'deepseek-peak-avoided');
  assert.equal(row.route?.model, 'glm-5.3-flash');
  const deepseek = row.fallbackChain.find((option) => option.model === 'deepseek-v4.1-flash');
  assert.ok(deepseek && deepseek.effectiveMultiplier > 1);
});

test('a held subscription reroutes implement work to tier one instead of a tier zero flash', () => {
  const input = plan(
    [role('implement-1', { choice: { provider: 'openai-codex', model: 'gpt-6.2-sol' } })],
    [sol, glm, deepseekFlash, glmFlash],
  );
  const result = resolveTaskRoutes(input, {
    now: peak,
    probe: probe({ 'openai-codex': poolEntry('openai-codex', 'openai-codex', 'held-quota', { window: '5h' }) }),
  });
  const row = rowOf(result, 'implement-1');
  assert.equal(row.status, 'auto-rerouted');
  assert.equal(row.rerouteReason, 'pool-held-quota:5h');
  assert.equal(row.route?.model, 'glm-5.3');
  assert.equal(row.route?.billing, 'go-included');
  assert.ok(row.rejected.some((item) => item.model === 'deepseek-v4.1-flash' && item.reason === 'capability-under-floor'));
  assert.ok(row.rejected.some((item) => item.model === 'glm-5.3-flash' && item.reason === 'capability-under-floor'));
});

test('metered-only survivors require an explicit decision and never spend silently', () => {
  const input = plan([role('verify-1')], [metered], {}, offPeak);
  const result = resolveTaskRoutes(input, { now: offPeak });
  const row = rowOf(result, 'verify-1');
  assert.equal(row.status, 'decision-required');
  assert.equal(row.reason, 'metered-cost-not-authorized');
  assert.equal(row.route, undefined);
  assert.equal(result.status, 'pending');
  const questions = routeQuestions(result);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].id, 'verify-1');
  assert.ok(questions[0].options.some((option) => option.choice === 'defer'));
  assert.ok(questions[0].options.some((option) => option.label.includes('$0.42')));
});

test('an authorized metered-only route resolves ready instead of asking for authorization', () => {
  const allowed = resolveTaskRoutes(plan([role('verify-1', { allowMetered: true })], [metered], {}, offPeak), { now: offPeak });
  const allowedRow = rowOf(allowed, 'verify-1');
  assert.equal(allowedRow.status, 'ready');
  assert.equal(allowedRow.route?.model, 'deepseek-v4.1-flash');
  assert.equal(allowedRow.route?.billing, 'metered');
  assert.equal(allowed.status, 'ready');
  const budgeted = resolveTaskRoutes(plan([role('verify-1', { maxUsd: 1 })], [metered], {}, offPeak), { now: offPeak });
  const budgetedRow = rowOf(budgeted, 'verify-1');
  assert.equal(budgetedRow.status, 'ready');
  assert.equal(budgetedRow.route?.approvedUsd, 1);
  assert.equal(budgeted.status, 'ready');
});

test('a hot session cache survives the peak unless the pool is hard-held', () => {
  const sticky = { ...deepseekFlash, pool: 'team-go' };
  const input = plan(
    [
      role('batch-1', {
        choice: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
        sessionStickyRoute: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      }),
    ],
    [sticky, glmFlash],
  );
  const kept = resolveTaskRoutes(input, { now: peak });
  const keptRow = rowOf(kept, 'batch-1');
  assert.equal(keptRow.route?.model, 'deepseek-v4.1-flash');
  assert.ok(keptRow.trace.includes('sticky-session-preserved'));
  const held = resolveTaskRoutes(input, {
    now: peak,
    probe: probe({ 'team-go': poolEntry('team-go', 'opencode-go', 'held-quota', { window: '5h' }) }),
  });
  const heldRow = rowOf(held, 'batch-1');
  assert.equal(heldRow.status, 'auto-rerouted');
  assert.equal(heldRow.rerouteReason, 'pool-held-quota:5h');
  assert.equal(heldRow.route?.model, 'glm-5.3-flash');
});

test('independent review rejects the cheapest same-family route and stops when none is left', () => {
  const implementers = [{ canonicalModel: 'zhipuai/glm-5.3-flash', family: 'zhipuai' }];
  const independent = resolveTaskRoutes(
    plan([role('reviewer', { reviewGate: 'independent', implementers })], [glm, kimi, glmFlash], {}, offPeak),
    { now: offPeak },
  );
  const picked = rowOf(independent, 'reviewer');
  assert.equal(picked.route?.model, 'kimi-k3.1-pro');
  assert.ok(picked.rejected.some((item) => item.model === 'glm-5.3' && item.reason === 'not-independent'));
  const blocked = resolveTaskRoutes(
    plan(
      [
        role('reviewer', {
          reviewGate: 'independent',
          implementers: [
            { canonicalModel: 'zhipuai/glm-5.3-flash', family: 'zhipuai' },
            { canonicalModel: 'moonshotai/kimi-k3.1-pro', family: 'moonshotai' },
          ],
        }),
      ],
      [glm, kimi, glmFlash],
      {},
      offPeak,
    ),
    { now: offPeak },
  );
  const blockedRow = rowOf(blocked, 'reviewer');
  assert.equal(blockedRow.status, 'unavailable');
  assert.equal(blockedRow.reason, 'external-review-pending');
});

test('teams headroom protection keeps go for review and moves batch to the subscription pool', () => {
  const entry = {
    ...poolEntry('opencode-go', 'opencode-go', 'healthy'),
    goMeter: { status: 'available', remaining: 0.02, limitingWindow: 'weekly', resetsAt },
  };
  const input = plan(
    [
      role('reviewer', { roleKind: 'review', choice: { provider: 'opencode-go', model: 'glm-5.3' }, maxMonthlyGoFraction: 0.015 }),
      role('batch-1', { choice: { provider: 'opencode-go', model: 'glm-5.3-flash' }, maxMonthlyGoFraction: 0.015 }),
    ],
    [glm, glmFlash, sol],
  );
  const result = resolveTaskRoutes(input, { now: peak, probe: probe({ 'opencode-go': entry }) });
  const reviewer = rowOf(result, 'reviewer');
  const batch = rowOf(result, 'batch-1');
  assert.equal(reviewer.status, 'ready');
  assert.equal(reviewer.route?.model, 'glm-5.3');
  assert.equal(batch.status, 'auto-rerouted');
  assert.equal(batch.rerouteReason, 'pool-headroom-reallocated');
  assert.equal(batch.route?.model, 'gpt-6.2-sol');
  assert.deepEqual(new Set(result.ready), new Set(['reviewer', 'batch-1']));
});

test('a long-context prompt avoids the doubled grok tariff', () => {
  const input = plan(
    [
      role('implementer', {
        allowPremium: true,
        expectedTokens: { input: 120_000, output: 12_000, cacheHitRatio: 0.85, promptTokens: 250_000 },
      }),
    ],
    [grok, kimi],
    {},
    offPeak,
  );
  const result = resolveTaskRoutes(input, { now: offPeak });
  const row = rowOf(result, 'implementer');
  assert.equal(row.route?.model, 'kimi-k3.1-pro');
  const grokOption = row.fallbackChain.find((option) => option.model === 'grok-4.7');
  assert.ok(grokOption);
  assert.equal(grokOption.longContextApplied, true);
  assert.ok(grokOption.notes.includes('long-context-doubled'));
});

function temporaryHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'kitto-routing-resolver-'));
  t.onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const json = (value: string): Json => JSON.parse(value);

test('the CLI records a failure and resolves away from the held codex pool', (t) => {
  const home = temporaryHome(t);
  const env = { ...process.env, HOME: home, KITTO_HOME: home };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [requireCliBin(), 'route', ...args], { encoding: 'utf8', env, timeout: 60_000 });
  const recorded = run(
    'report-failure',
    '--pool',
    'openai-codex',
    '--upstream',
    'openai-codex',
    '--kind',
    'quota',
    '--window',
    '5h',
    '--resets-at',
    resetsAt,
    '--now',
    iso(peak),
  );
  assert.equal(recorded.status, 0, recorded.stderr);
  const input = plan([role('implement-1', { choice: { provider: 'openai-codex', model: 'gpt-6.2-sol' } })], [sol, glm, deepseekFlash]);
  const file = join(home, 'plan.json');
  writeFileSync(file, JSON.stringify(input));
  const resolved = run('resolve', '--input', file, '--now', iso(peak));
  assert.equal(resolved.status, 0, resolved.stderr);
  const output = json(resolved.stdout);
  assert.equal(output.status, 'ready');
  assert.equal(output.rows[0].status, 'auto-rerouted');
  assert.equal(output.rows[0].rerouteReason, 'pool-held-quota:5h');
  assert.equal(output.rows[0].route.model, 'glm-5.3');
  assert.deepEqual(output.decisionPrompt, []);
  const probeFile = join(home, 'probe.json');
  writeFileSync(probeFile, JSON.stringify(probe({})));
  const noProbe = run('resolve', '--input', file, '--probe', probeFile, '--now', iso(peak));
  assert.equal(noProbe.status, 0, noProbe.stderr);
  assert.equal(json(noProbe.stdout).rows[0].status, 'ready');
  assert.equal(json(noProbe.stdout).rows[0].route.model, 'gpt-6.2-sol');
  const badPolicy = run('resolve', '--input', file, '--policy', 'turbo');
  assert.notEqual(badPolicy.status, 0);
  assert.match(badPolicy.stderr, /Usage: kitto route resolve/);
});

test('host adapters pass resolve mode through with a supplied probe', () => {
  const probeValue = probe({});
  const routes = [glm, deepseekFlash];
  const dshInput = {
    ...plan([role('implementer', { choice: { provider: 'opencode-go', model: 'glm-5.3' } })], routes, {
      host: { kind: 'dsh', surface: 'teams', session: 'native-session', observedAt: iso(peak), routes },
    }),
    mode: 'resolve',
    probe: probeValue,
  };
  const dsh = evaluateDshTaskRoutes(adapterInput(dshInput), 'native-session', peak);
  assert.equal(dsh.status, 'ready');
  assert.equal(dsh.rows?.[0]?.route?.model, 'glm-5.3');
  assert.deepEqual(dsh.decisionPrompt, []);
  const piInput = {
    ...plan([role('implementer', { choice: { provider: 'opencode-go', model: 'glm-5.3' } })], routes, {
      host: { kind: 'pi', surface: 'subagent', session: 'pi-session', observedAt: iso(peak), routes },
    }),
    mode: 'resolve',
    probe: probeValue,
  };
  const pi = evaluatePiTaskRoutes(adapterInput(piInput), { session: 'pi-session' }, peak);
  assert.equal(pi.status, 'ready');
  assert.equal(pi.rows?.[0]?.route?.model, 'glm-5.3');
  const codexInput = {
    ...plan([role('implementer', { choice: { provider: 'opencode-go', model: 'glm-5.3' } })], routes, {
      host: {
        kind: 'codex',
        surface: 'subagent',
        session: 'codex-thread',
        observedAt: iso(peak),
        routes,
        native: { thread: { id: 'codex-thread' }, modelProvider: 'opencode-go', model: 'glm-5.3' },
      },
    }),
    mode: 'resolve',
    probe: probeValue,
  };
  const codex = evaluateCodexTaskRoutes(adapterInput(codexInput), peak);
  assert.equal(codex.status, 'ready');
  assert.equal(codex.rows?.[0]?.route?.model, 'glm-5.3');
  const planModeInput = { ...dshInput } as Json;
  delete planModeInput.mode;
  delete planModeInput.probe;
  const planMode = evaluateDshTaskRoutes(adapterInput(planModeInput), 'native-session', peak);
  assert.equal(planMode.rows?.[0]?.options !== undefined, true);
  const firstRow = dsh.rows?.[0] as unknown as Json;
  assert.ok(Array.isArray(firstRow.fallbackChain));
});
