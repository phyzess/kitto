import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { evaluateDshTaskRoutes, registerDshTaskRouting } from '../integration/dsh-task-routing.ts';
import { evaluatePiTaskRoutes, registerPiTaskRouting } from '../integration/pi-task-routing.ts';
import { evaluateCodexTaskRoutes } from '../integration/codex-task-routing.ts';
import type { DshPluginContext, Json, PiExtensionApi, PiSessionContext } from '../types/kitto.d.ts';

const now = Date.now();
const session = 'native-session';
const route = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  upstream: 'deepseek-official',
  account: 'official',
  billing: 'metered',
  estimateUsd: 0.15,
  accountVerified: true,
  dataAllowed: true,
  available: true,
  dispatchable: true,
  fallback: 'none',
};
function pluginContext(fake: Partial<DshPluginContext>): DshPluginContext {
  return fake as DshPluginContext;
}
function piApi(fake: Partial<PiExtensionApi>): PiExtensionApi {
  return fake as PiExtensionApi;
}
function piSession(fake: Partial<PiSessionContext>): PiSessionContext {
  return fake as PiSessionContext;
}
function input(kind: string, surface: string): Json {
  return {
    id: 'review-work',
    host: { kind, surface, session, observedAt: new Date(now).toISOString(), routes: [route] },
    roles: [
      {
        id: 'review',
        workRevision: 'diff1',
        effects: 'read',
        data: 'personal',
        dependencies: [],
        choice: route,
        authorization: { ...route, plan: 'review-work', role: 'review', workRevision: 'diff1', data: 'personal', maxUsd: 0.3 },
      },
    ],
  };
}

test('DSH planner binds to the native session and does not launch a role', () => {
  assert.equal(evaluateDshTaskRoutes(input('dsh', 'teams'), session, now).status, 'ready');
  assert.equal(evaluateDshTaskRoutes(input('dsh', 'teams'), 'other', now).reason, 'native-session-mismatch');
});

test('DSH staged check rejects extra native work, route edits and unresolved fallback', () => {
  const request = input('dsh', 'teams');
  const ready = evaluateDshTaskRoutes(request, session, now).rows[0];
  request.approval = [{ id: ready.id, approvalKey: ready.route.approvalKey }];
  const task = {
    id: 'review',
    provider: route.provider,
    model: route.model,
    effort: 'default',
    fallback: 'none',
    workRevision: 'diff1',
    dependencies: [],
  };
  request.host.nativePlan = { id: request.id, phase: 'staged', session, tasks: [task] };
  assert.equal(evaluateDshTaskRoutes(request, session, now).status, 'approved');
  request.host.nativePlan.tasks.push({ ...task, id: 'unapproved' });
  assert.equal(evaluateDshTaskRoutes(request, session, now).reason, 'team-launch-scope-mismatch');
  request.host.nativePlan.tasks.pop();
  for (const edit of [{ provider: 'other' }, { effort: 'high' }, { fallback: 'unknown' }, { workRevision: 'diff2' }]) {
    request.host.nativePlan.tasks[0] = { ...task, ...edit };
    assert.equal(evaluateDshTaskRoutes(request, session, now).reason, 'team-launch-scope-mismatch');
  }
});

test('Pi binds a current model check to the actual model; headless command does not prompt', async () => {
  const request = input('pi', 'current');
  assert.equal(evaluatePiTaskRoutes(request, { session, current: { provider: route.provider, id: route.model } }, now).status, 'ready');
  assert.equal(
    evaluatePiTaskRoutes(request, { session, current: { provider: 'other', id: route.model } }, now).questions[0].reason,
    'select-in-native-host',
  );
  const commands: Array<{ handler(args: string, ctx: PiSessionContext): Promise<void> }> = [];
  registerPiTaskRouting(
    piApi({
      registerCommand(name, value) {
        assert.equal(name, 'kitto-route');
        commands.push(value);
      },
    }),
  );
  const [command] = commands;
  assert.ok(command);
  await command.handler(
    '',
    piSession({
      hasUI: false,
      get ui() {
        return assert.fail('headless Pi cannot prompt');
      },
    }),
  );
});

test('Codex groups outstanding decisions and presents paid estimates without treating selection as approval', () => {
  const request = input('codex', 'current');
  request.host.native = { thread: { id: session }, model: route.model, modelProvider: route.provider };
  delete request.roles[0].authorization;
  const result = evaluateCodexTaskRoutes(request, now);
  assert.equal(result.status, 'pending');
  assert.equal(result.decisionPrompt.length, 1);
  assert.match(result.decisionPrompt[0].options[0].label, /estimated \$0\.15/);
  assert.equal(result.decisionPrompt[0].options.at(-1).choice, 'defer');
  assert.deepEqual(result.ready, []);
});

test('current route requires an observed non-default effort and ignores a route-row assertion', () => {
  for (const kind of ['codex', 'pi']) {
    const request = input(kind, 'current');
    request.roles[0].choice = { ...route, effort: 'high' };
    request.host.routes = [{ ...route, efforts: ['high', 'low'], nativeEffort: 'high' }];
    const evaluate = (effort: string | undefined) => {
      if (kind === 'pi')
        return evaluatePiTaskRoutes(request, { session, current: { provider: route.provider, id: route.model }, effort }, now);
      request.host.native = { thread: { id: session }, model: route.model, modelProvider: route.provider, reasoningEffort: effort };
      return evaluateCodexTaskRoutes(request, now);
    };
    assert.equal(evaluate(undefined).questions[0].reason, 'native-effort-unverified');
    assert.equal(evaluate('low').questions[0].reason, 'set-effort-in-native-host');
    assert.equal(evaluate('high').status, 'ready');
  }
});

test('DSH parent-session route is not inferred from a caller-supplied current model', () => {
  const request = input('dsh', 'current');
  for (const current of [undefined, { provider: 'other', model: 'other' }, route]) {
    request.host.current = current;
    assert.equal(evaluateDshTaskRoutes(request, session, now).reason, 'native-current-route-unverified');
    request.approval = [];
    assert.equal(evaluateDshTaskRoutes(request, session, now).reason, 'native-current-route-unverified');
    delete request.approval;
  }
});

test('Codex model override does not imply an upstream override', () => {
  const request = input('codex', 'subagent');
  request.host.native = {
    thread: { id: session },
    model: 'primary',
    modelProvider: 'openai',
    spawnParameters: ['model', 'reasoning_effort'],
  };
  assert.equal(evaluateCodexTaskRoutes(request, now).rows[0].options[0].reason, 'host-cannot-select-route');
  request.host.native.modelProvider = route.provider;
  assert.equal(evaluateCodexTaskRoutes(request, now).status, 'ready');
  request.host.native.spawnParameters = [];
  assert.equal(evaluateCodexTaskRoutes(request, now).rows[0].options[0].reason, 'host-cannot-select-route');
});

test('public CLI plan and check accept only the approved official DSH task and matching staged scope', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-task-cli-'));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const fixture = join(temp, 'plan.json');
  const cli = fileURLToPath(new URL('../bin/kitto.ts', import.meta.url));
  const request = input('dsh', 'teams');
  const run = (operation: string, nativeSession: string | null = session) => {
    const env = { ...process.env };
    if (nativeSession === null) delete env.DSH_SESSION_ID;
    else env.DSH_SESSION_ID = nativeSession;
    writeFileSync(fixture, JSON.stringify(request), { mode: 0o600 });
    const result = spawnSync(process.execPath, [cli, 'route', operation, '--input', fixture], {
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.stderr, '');
    return [result.status, JSON.parse(result.stdout)];
  };
  const [code, planned] = run('plan');
  assert.equal(code, 0);
  const [{ id, route: selected }] = planned.rows;
  assert.equal(selected.provider, 'deepseek-official');
  request.approval = [{ id, approvalKey: selected.approvalKey }];
  assert.equal(run('check')[0], 2);
  request.host.nativePlan = {
    id: request.id,
    phase: 'staged',
    session,
    tasks: [
      {
        id,
        provider: selected.provider,
        model: selected.model,
        effort: selected.effort,
        fallback: 'none',
        workRevision: 'diff1',
        dependencies: [],
      },
    ],
  };
  assert.equal(run('check')[1].status, 'approved');
  for (const invalidSession of [null, 'other']) {
    const [exit, result] = run('check', invalidSession);
    assert.equal(exit, 2);
    assert.equal(result.reason, 'native-session-mismatch');
  }
  assert.equal(run('plan', null)[0], 0);
  const removed = spawnSync(process.execPath, [cli, 'route', 'preflight', '--input', fixture], { encoding: 'utf8', timeout: 5000 });
  assert.notEqual(removed.status, 0);
  assert.match(removed.stderr, /Usage: kitto route plan\|check/);
  request.host.nativePlan.tasks[0].model = 'other';
  assert.equal(run('check')[0], 2);
});

test('independently recomputing the native work fingerprint rejects a stale scope approval', () => {
  const fingerprint = (contract: string, diff: string) =>
    createHash('sha256')
      .update(JSON.stringify([contract, diff]))
      .digest('hex');
  const request = input('dsh', 'teams');
  const [role] = request.roles;
  role.workRevision = fingerprint('Review billing only', 'original diff');
  role.authorization.workRevision = role.workRevision;
  const ready = evaluateDshTaskRoutes(request, session, now).rows[0];
  request.approval = [{ id: ready.id, approvalKey: ready.route.approvalKey }];
  const task = {
    id: role.id,
    provider: route.provider,
    model: route.model,
    effort: 'default',
    fallback: 'none',
    workRevision: role.workRevision,
    dependencies: [],
  };
  request.host.nativePlan = { id: request.id, phase: 'staged', session, tasks: [task] };
  assert.equal(evaluateDshTaskRoutes(request, session, now).status, 'approved');
  task.workRevision = fingerprint('Review billing only', 'updated diff');
  assert.equal(evaluateDshTaskRoutes(request, session, now).reason, 'team-launch-scope-mismatch');
});

test('Pi CLI plan refuses a self-reported effort without native state', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'kitto-pi-cli-'));
  t.onTestFinished(() => rmSync(temp, { recursive: true, force: true }));
  const fixture = join(temp, 'plan.json');
  const cli = fileURLToPath(new URL('../bin/kitto.ts', import.meta.url));
  const request = input('pi', 'current');
  request.host.routes = [{ ...route, efforts: ['high'], nativeEffort: 'high' }];
  request.roles[0].choice = { ...route, effort: 'high' };
  writeFileSync(fixture, JSON.stringify(request), { mode: 0o600 });
  for (const operation of ['plan', 'check']) {
    const result = spawnSync(process.execPath, [cli, 'route', operation, '--input', fixture], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, 'pi-native-state-unverified');
  }
});

test(
  'real DSH tool definition registers and runs the paid-route plan without spawning',
  { skip: !process.env.KITTO_TEST_DSH_INSTALL },
  async () => {
    const installDir = process.env.KITTO_TEST_DSH_INSTALL;
    assert.ok(installDir);
    const installAnchor = join(installDir, 'package.json');
    const require = createRequire(installAnchor);
    assert.equal(require('./package.json').name, '@deepseek-ai/dsh');
    const tools: Json[] = [];
    registerDshTaskRouting(
      pluginContext({
        inject(deps: string[], activate: (host: Json) => unknown) {
          assert.deepEqual(deps, ['profileContext', 'tools']);
          activate({
            profileContext: { installAnchor, name: 'web' },
            tools: {
              register(tool: Json) {
                tools.push(tool);
              },
            },
          });
        },
      }),
    );
    assert.equal(tools.length, 1);
    const result = await tools[0].execute(
      { input_json: JSON.stringify(input('dsh', 'teams')) },
      {
        agent: { session: { id: session } },
        signal: new AbortController().signal,
      },
    );
    assert.equal(JSON.parse(result).rows[0].route.billing, 'metered');
  },
);
