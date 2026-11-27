import { test } from 'vitest';
import assert from 'node:assert/strict';
import { checkTaskRouteApproval, planTaskRoutes } from '../lib/task-route-plan.ts';

const now = Date.parse('2026-11-26T12:00:00Z');
const subscription = {
  provider: 'openai-codex',
  model: 'sol',
  canonicalModel: 'openai/sol',
  family: 'openai',
  upstream: 'openai-codex',
  account: 'native',
  accountVerified: true,
  billing: 'subscription',
  available: true,
  dispatchable: true,
  fallback: 'none',
  dataAllowed: true,
  efforts: ['medium'],
};
const paid = {
  ...subscription,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  canonicalModel: 'deepseek/flash',
  family: 'deepseek',
  upstream: 'deepseek-official',
  account: 'official',
  billing: 'metered',
  estimateUsd: 0.3,
  efforts: ['high'],
};
function role(id, route, dependencies = []) {
  const base = { id, workRevision: 'current-diff', data: 'personal', effects: 'read', dependencies };
  return {
    ...base,
    authorization: {
      plan: 'work-item',
      role: id,
      workRevision: base.workRevision,
      provider: route.provider,
      model: route.model,
      upstream: route.upstream,
      account: route.account,
      billing: route.billing,
      data: base.data,
      maxUsd: 0.5,
    },
  };
}
function plan(kind = 'dsh', surface = 'teams', roles = [role('review', paid)]) {
  return {
    id: 'work-item',
    host: {
      kind,
      surface,
      session: 'test-session',
      observedAt: new Date(now).toISOString(),
      routes: [subscription, paid],
      current: subscription,
    },
    roles,
  };
}
const approval = (result) =>
  result.rows.filter((row) => row.status === 'ready').map((row) => ({ id: row.id, approvalKey: row.route.approvalKey }));

test('explicit official Flash remains selectable with the exact paid task authorization', () => {
  const input = plan();
  input.roles[0].choice = { provider: paid.provider, model: paid.model, effort: 'high' };
  const result = planTaskRoutes(input, now);
  assert.equal(result.status, 'ready');
  assert.equal(result.rows[0].route.provider, 'deepseek-official');
  assert.equal(result.rows[0].route.estimateOnly, true);
  assert.equal(checkTaskRouteApproval(input, approval(result), now).status, 'approved');
  input.roles[0].authorization.maxUsd = 0.1;
  assert.equal(planTaskRoutes(input, now).questions[0].reason, 'metered-cost-not-authorized');
  assert.equal(checkTaskRouteApproval(input, approval(result), now).status, 'stop');
});

test('an authorized preset needs no question; a broken preset is not silently replaced', () => {
  const input = { ...plan('pi', 'current', [role('verify', subscription)]), presets: { verify: subscription } };
  assert.deepEqual(planTaskRoutes(input, now).questions, []);
  input.presets.verify = { provider: 'missing', model: 'unavailable' };
  assert.equal(planTaskRoutes(input, now).questions[0].reason, 'chosen-or-preset-route-unavailable');
});

test('a preset carries its reasoning effort unless a task choice overrides it', () => {
  const input = plan();
  input.presets = { review: { ...paid, effort: 'high' } };
  const result = planTaskRoutes(input, now);
  assert.equal(result.rows[0].route.effort, 'high');
  input.roles[0].choice = { ...paid, effort: 'default' };
  assert.equal(planTaskRoutes(input, now).rows[0].route.effort, 'default');
  assert.equal(checkTaskRouteApproval(input, approval(result), now).status, 'stop');
});

test('changing one route or work revision invalidates only that role approval', () => {
  const input = plan('dsh', 'teams', [role('verify', subscription), role('review', paid)]);
  const previous = approval(planTaskRoutes(input, now));
  input.roles[1] = { ...input.roles[1], choice: { ...paid, effort: 'high' } };
  assert.equal(checkTaskRouteApproval(input, previous, now).status, 'stop');
  assert.equal(checkTaskRouteApproval(input, previous.slice(0, 1), now).status, 'approved');
  input.roles[0].workRevision = 'changed';
  assert.equal(checkTaskRouteApproval(input, previous.slice(0, 1), now).status, 'stop');
});

test('independent review rejects another model from the implementation family even with the old opt-out', () => {
  const input = plan();
  const review = input.roles[0];
  review.choice = paid;
  review.reviewGate = 'independent';
  review.requireDifferentFamily = false;
  review.implementers = [{ canonicalModel: 'deepseek/pro', family: 'deepseek' }];
  assert.equal(planTaskRoutes(input, now).rows[0].options.find((option) => option.provider === paid.provider).reason, 'not-independent');
  review.implementers = [{ canonicalModel: subscription.canonicalModel, family: subscription.family }];
  assert.equal(planTaskRoutes(input, now).status, 'ready');
});

test('deferred and unavailable roles do not release dependent work', () => {
  const input = plan('codex', 'subagent', [
    role('verify', subscription),
    { ...role('review', paid), choice: 'defer' },
    role('integrate', subscription, ['review']),
  ]);
  const result = planTaskRoutes(input, now);
  assert.deepEqual(result.ready, ['verify']);
  assert.deepEqual(result.rows[2].blockedBy, ['review']);
  assert.equal(checkTaskRouteApproval(input, approval(result), now).status, 'stop');
  assert.equal(checkTaskRouteApproval(input, approval(result).slice(0, 1), now).status, 'approved');
});

test('cannot claim an upstream the native surface cannot dispatch or replay a failed route', () => {
  const input = plan('codex', 'subagent');
  input.host.routes = [{ ...paid, dispatchable: false }];
  assert.equal(planTaskRoutes(input, now).rows[0].options[0].reason, 'host-cannot-select-route');
  input.host.routes = [paid];
  input.roles[0].failed = [paid];
  assert.equal(planTaskRoutes(input, now).rows[0].options[0].reason, 'failed-route-or-account');
});
