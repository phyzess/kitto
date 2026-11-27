import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codegraphPlan, codegraphTargets, ensureCodeGraphIndexes } from '../lib/codegraph.ts';

function temp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'kitto-codegraph-'));
  t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function repo(path: string) {
  mkdirSync(join(path, '.git'), { recursive: true });
  return path;
}

function scopes(home: string, value: Record<string, unknown>) {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'scopes.json'), JSON.stringify({ version: 1, global: false, workspaces: [], ...value }));
}

test('codegraphTargets follows registered workspaces and workspace parents', async (t) => {
  const directory = temp(t);
  const home = join(directory, 'kitto');
  const workspace = repo(join(directory, 'repo-a'));
  const parent = join(directory, 'workspaces');
  mkdirSync(parent);
  const child = repo(join(parent, 'repo-b'));
  mkdirSync(join(parent, 'not-a-repo'));
  scopes(home, { workspaces: [workspace], workspaceParents: [parent] });
  const targets = await codegraphTargets({
    home,
    source: join(directory, 'source'),
    dshHome: join(directory, 'dsh'),
    agentsHome: join(directory, 'agents'),
    cwd: directory,
  });
  assert.deepEqual(targets, [workspace, child].sort());
});

test('codegraphTargets falls back to the current workspace and excludes Kitto source', async (t) => {
  const directory = temp(t);
  const home = join(directory, 'kitto');
  const projects = join(directory, 'projects');
  mkdirSync(projects);
  const first = repo(join(projects, 'first'));
  const second = repo(join(projects, 'second'));
  const targets = await codegraphTargets({ home, source: second, cwd: projects });
  assert.deepEqual(targets, [first]);
});

test('registeredOnly ignores the current workspace fallback', async (t) => {
  const directory = temp(t);
  const home = join(directory, 'kitto');
  const projects = join(directory, 'projects');
  mkdirSync(projects);
  repo(join(projects, 'first'));
  assert.deepEqual(await codegraphTargets({ home, cwd: projects, registeredOnly: true }), []);
  assert.deepEqual(await codegraphTargets({ home, cwd: projects }), [join(projects, 'first')]);
});

test('codegraphPlan separates ready, missing, unavailable and unwritable indexes', (t) => {
  const directory = temp(t);
  const ready = join(directory, 'ready');
  const missing = join(directory, 'missing');
  mkdirSync(join(ready, '.codegraph'), { recursive: true });
  mkdirSync(missing, { recursive: true });
  assert.deepEqual(codegraphPlan([ready, missing], { available: true, writable: () => true }), [
    { path: ready, action: 'ready' },
    { path: missing, action: 'init' },
  ]);
  assert.equal(codegraphPlan([missing], { available: false })[0].action, 'missing-cli');
  assert.equal(codegraphPlan([missing], { available: true, writable: () => false })[0].action, 'unwritable');
});

test('ensureCodeGraphIndexes initializes missing indexes only when applying', async (t) => {
  const directory = temp(t);
  const target = repo(join(directory, 'repo'));
  const calls: string[] = [];
  const logs: string[] = [];
  const run = (path: string) => {
    calls.push(path);
    mkdirSync(join(path, '.codegraph'));
    return { status: 0 };
  };
  await ensureCodeGraphIndexes(
    {},
    {
      targets: [target],
      apply: false,
      available: true,
      writable: () => true,
      run,
      log: (line: string) => logs.push(line),
    },
  );
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /codegraph index missing: .*run codegraph init/);
  await ensureCodeGraphIndexes(
    {},
    {
      targets: [target],
      apply: true,
      available: true,
      writable: () => true,
      run,
      log: (line: string) => logs.push(line),
    },
  );
  assert.deepEqual(calls, [target]);
  assert.match(logs.join('\n'), /codegraph index created:/);
});

test('ensureCodeGraphIndexes honors KITTO_NO_CODEGRAPH_INIT', async (t) => {
  const directory = temp(t);
  const target = repo(join(directory, 'repo'));
  const calls: string[] = [];
  const previous = process.env.KITTO_NO_CODEGRAPH_INIT;
  process.env.KITTO_NO_CODEGRAPH_INIT = '1';
  try {
    await ensureCodeGraphIndexes(
      {},
      {
        targets: [target],
        apply: true,
        available: true,
        writable: () => true,
        run: (path: string) => {
          calls.push(path);
          return { status: 0 };
        },
        log: () => {},
      },
    );
  } finally {
    if (previous === undefined) delete process.env.KITTO_NO_CODEGRAPH_INIT;
    else process.env.KITTO_NO_CODEGRAPH_INIT = previous;
  }
  assert.deepEqual(calls, []);
});

test('ensureCodeGraphIndexes reports missing CLI and unwritable targets without running', async (t) => {
  const directory = temp(t);
  const target = repo(join(directory, 'repo'));
  const calls: string[] = [];
  const logs: string[] = [];
  const run = (path: string) => {
    calls.push(path);
    return { status: 0 };
  };
  await ensureCodeGraphIndexes({}, { targets: [target], apply: true, available: false, run, log: (line: string) => logs.push(line) });
  await ensureCodeGraphIndexes(
    {},
    { targets: [target], apply: true, available: true, writable: () => false, run, log: (line: string) => logs.push(line) },
  );
  assert.deepEqual(calls, []);
  assert.match(logs.join('\n'), /codegraph CLI not found/);
  assert.match(logs.join('\n'), /not writable by the current user/);
});
