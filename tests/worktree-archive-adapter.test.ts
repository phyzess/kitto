import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'vitest';
import type { DshPluginContext } from '../types/kitto.d.ts';
import { fixture, type Json } from './helpers/worktree-fixture.ts';

function pluginContext(fake: Partial<DshPluginContext>): DshPluginContext {
  return fake as DshPluginContext;
}

test('the DSH archive adapter stays disabled by default and does not mount on Desktop', async () => {
  const { apply } = await import('../integration/dsh.ts');
  const routingServices = ['profileContext', 'tools'];
  const archiveServices = ['profileContext', 'tools', 'workspaceRegistry', 'sessionPersistence'];
  for (const config of [undefined, { archiveReview: false }, { archiveReview: true }]) {
    const injections: string[][] = [];
    apply(
      pluginContext({
        skills: { registerProvider() {} },
        inject(deps: string[], enable: (host: Json) => unknown) {
          injections.push(deps);
          enable({
            profileContext: { name: 'desktop' },
            get tools() {
              return assert.fail('Desktop must not register tools');
            },
            get workspaceRegistry() {
              return assert.fail('Desktop must not access the archive registry');
            },
            get sessionPersistence() {
              return assert.fail('Desktop must not access archive persistence');
            },
          });
        },
      }),
      config,
    );
    assert.deepEqual(injections, config?.archiveReview ? [archiveServices, routingServices] : [routingServices]);
  }
});

test('installed DSH registry and actual adapter project durable archive and unarchive without mutating Kitto claims', async (t) => {
  if (!process.env.DSH_INSTALL_DIR) return t.skip('Requires an installed DSH runtime for the native contract test');
  const installAnchor = join(process.env.DSH_INSTALL_DIR, 'package.json');
  const require = createRequire(installAnchor);
  const { Context } = require('@deepseek-ai/cordis');
  const { WorkspaceRegistry } = require('@deepseek-ai/dsh-workspace');
  const f = await fixture(t);
  const session = 'fixture-native-session',
    task = 'ticket-42';
  const created = f.start({ session });
  const request = { repo: f.repo, task, session };
  const flags = ['--quiescent', '--release'];
  const before = f.invoke('finish', flags, { session });
  const vars = f.env;
  const prior = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.onTestFinished(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const { apply } = await import('../integration/dsh.ts');
  const data = join(f.root, 'workspace-archive-fixture.json');
  await writeFile(data, JSON.stringify({ initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }));
  let snapshots = [{ header: { id: session, cwd: created.path, createdAt: 1 } }];
  let list = async () => snapshots;
  async function boot() {
    const ctx = new Context();
    const tools = new Map();
    const storage = {
      open: async () => {
        let state = JSON.parse(await readFile(data, 'utf8'));
        return {
          table: () => new Map(),
          close() {},
          global: {
            get: () => state,
            async set(next: unknown) {
              await writeFile(data, JSON.stringify(next));
              state = next;
            },
          },
        };
      },
    };
    ctx.reflect.provide('profileContext', { name: 'web', installAnchor });
    ctx.reflect.provide('skills', { registerProvider() {} });
    ctx.reflect.provide('tools', {
      register(tool: Json) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    });
    ctx.reflect.provide('sessionPersistence', { list: () => list() });
    ctx.reflect.provide('storageDomain', storage);
    const workspace = ctx.plugin(WorkspaceRegistry);
    const plugin = ctx.plugin({ name: 'kitto-fixture', apply }, { archiveReview: true });
    t.onTestFinished(() => {
      plugin.dispose();
      workspace.dispose();
    });
    await workspace;
    await plugin;
    const tool = tools.get('kitto_worktree_archive_review');
    assert.ok(tool, 'actual DSH integration entry registered the tool');
    return { registry: ctx.get('workspaceRegistry'), review: (args: Json) => tool.execute(args, { signal: new AbortController().signal }) };
  }

  const first = await boot();
  assert.equal(await first.review(request), 'not-archived');
  await first.registry.archiveSession(session);
  assert.equal(await first.review(request), 'review-pending');
  await first.registry.archiveSession(session);
  assert.equal(await first.review(request), 'review-pending');
  assert.equal(await first.review({ ...request, task: 'unbound' }), 'unavailable');
  snapshots[0].header.cwd = f.repo;
  assert.equal(await first.review(request), 'unavailable');
  snapshots[0].header.cwd = created.path;
  list = async () => {
    throw new Error('unavailable persistence');
  };
  assert.equal(await first.review(request), 'unavailable');
  list = async () => snapshots;

  const resumed = await boot();
  assert.equal(await resumed.review(request), 'review-pending');
  let readEntered: () => void = () => {},
    proceed: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    readEntered = resolve;
  });
  const exitRead = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  list = async () => {
    readEntered();
    await exitRead;
    return snapshots;
  };
  const concurrent = resumed.review(request);
  await reading;
  await resumed.registry.unarchiveSession(session);
  proceed();
  assert.equal(await concurrent, 'not-archived');
  list = async () => snapshots;
  assert.equal(await resumed.review(request), 'not-archived');
  const reloaded = await boot();
  assert.equal(await reloaded.review(request), 'not-archived');
  assert.deepEqual(f.invoke('finish', flags, { session }), before);
  assert.equal(await readFile(join(created.path, 'tracked'), 'utf8'), 'base\n');
});
