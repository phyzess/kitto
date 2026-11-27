import { test } from 'vitest';
import type { TestContext } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import type { ScopeRegistry } from '../lib/scopes.ts';
import { readScopeRegistry, resolveScopes, writeScopeRegistry } from '../lib/scopes.ts';

const cli = fileURLToPath(new URL('../dist/bin/kitto.mjs', import.meta.url));

const unchecked = (value: unknown) => value as ScopeRegistry;

async function scopeFixture(t: TestContext) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'kitto-scope-cli-')));
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data');
  const env = { ...process.env, HOME: temp, KITTO_HOME: data, PI_CODING_AGENT_DIR: join(temp, 'pi') };
  return { temp, data, env };
}

function runScope(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 30_000 });
}

function scopeOk(env: NodeJS.ProcessEnv, ...args: string[]) {
  const result = runScope(env, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

test('scoped CLI preserves shared files and discovers repos created after setup', async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "kitto user's scope ")));
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data'),
    workspace = join(temp, 'work'),
    other = workspace + '-other';
  const env = { ...process.env, HOME: temp, KITTO_HOME: data, PI_CODING_AGENT_DIR: join(temp, 'pi') };
  const setup = (...args: string[]) => execFileSync(process.execPath, [cli, 'setup', ...args, '--agents', 'pi'], { env, encoding: 'utf8' });
  setup('--workspace', workspace, '--dry-run');
  await assert.rejects(stat(data), { code: 'ENOENT' });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  setup('--global');
  setup('--workspace', workspace);
  await writeFile(join(workspace, 'AGENTS.md'), 'Use shared tests.\n');
  await mkdir(other);
  const alias = join(temp, 'alias');
  await symlink(workspace, alias, 'dir');
  setup('--workspace', alias);
  assert.equal(await readFile(join(workspace, 'AGENTS.md'), 'utf8'), 'Use shared tests.\n');
  const nested = join(workspace, 'sub');
  setup('--workspace', nested);
  const repo = join(nested, 'new-repo');
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'AGENTS.md'), 'Repo rules.\n');
  const roots = async (dir: string) => (await resolveScopes(dir, data)).map((scope) => scope.root);
  assert.deepEqual(await roots(join(alias, 'sub/new-repo')), [join(data, 'global'), workspace, nested]);
  assert.deepEqual(await roots(other), [join(data, 'global')]);
  assert.equal(await readFile(join(repo, 'AGENTS.md'), 'utf8'), 'Repo rules.\n');
});

test('a workspace parent opts future child workspaces in independently', async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'kitto-workspace-parent-')));
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data');
  const parent = join(temp, 'workspaces');
  const parentAlias = join(temp, 'alias');
  const outside = join(temp, 'workspaces-other');
  const env = { ...process.env, HOME: temp, KITTO_HOME: data, PI_CODING_AGENT_DIR: join(temp, 'pi') };
  const setup = (...args: string[]) =>
    execFileSync(process.execPath, [cli, 'setup', ...args, '--agents', 'pi'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  await mkdir(parent);
  await mkdir(outside);
  await symlink(parent, parentAlias, 'dir');
  setup('--workspace-parent', parentAlias, '--dry-run');
  await assert.rejects(stat(data), { code: 'ENOENT' });
  assert.throws(() => setup('--global', '--workspace-parent', parentAlias), /Choose exactly one/);
  assert.throws(() => setup('--workspace', outside, '--workspace-parent', parentAlias), /Choose exactly one/);
  assert.throws(() => setup('--workspace-parent', parentAlias, '--dsh-service', 'dsh.service'), /requires --workspace PATH/);
  setup('--workspace-parent', parentAlias);
  setup('--workspace-parent', parent);
  await assert.rejects(stat(join(parent, 'AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(stat(join(parent, '.agents')), { code: 'ENOENT' });
  const registry = JSON.parse(await readFile(join(data, 'scopes.json'), 'utf8'));
  assert.deepEqual(registry.workspaceParents, [parent]);

  const first = join(parent, 'workspace-1');
  const second = join(parent, 'workspace-2');
  const repo = join(first, 'new-clone');
  execFileSync('git', ['init', '-q', repo]);
  for (const child of [first, second]) {
    await mkdir(join(child, '.agents/skills'), { recursive: true });
    await writeFile(join(child, 'AGENTS.md'), child + '\n');
  }
  const roots = async (dir: string) => (await resolveScopes(dir, data)).map((scope) => scope.root);
  assert.deepEqual(await resolveScopes(join(parentAlias, 'workspace-1/new-clone'), data), [
    {
      root: first,
      instructions: join(first, 'AGENTS.md'),
      skills: join(first, '.agents/skills'),
    },
  ]);
  assert.deepEqual(await roots(second), [second]);
  assert.deepEqual(await roots(parent), []);
  assert.deepEqual(await roots(outside), []);
  const escape = join(parent, 'outside-link');
  await symlink(outside, escape, 'dir');
  assert.deepEqual(await roots(escape), []);
  setup('--workspace', first);
  assert.deepEqual(await roots(repo), [first]);
});

test('scope list reports an empty registry without creating files', async (t) => {
  const { data, env } = await scopeFixture(t);
  assert.match(scopeOk(env, '--help').stdout, /kitto scope list/);
  for (const args of [
    ['scope'],
    ['scope', '--help'],
    ['scope', '-h'],
    ['scope', 'list', '--help'],
    ['scope', 'list', '-h'],
    ['scope', 'remove', '--help'],
    ['scope', 'remove', '-h'],
  ]) {
    assert.match(scopeOk(env, ...args).stdout, /Kitto scope registry/);
  }
  const human = scopeOk(env, 'scope', 'list').stdout;
  assert.match(human, /Global: disabled/);
  assert.match(human, /Workspaces:\n {2}\(none\)/);
  assert.match(human, /Workspace parents:\n {2}\(none\)/);
  assert.deepEqual(JSON.parse(scopeOk(env, 'scope', 'list', '--json').stdout), {
    version: 1,
    global: false,
    workspaces: [],
    workspaceParents: [],
  });
  await assert.rejects(stat(join(data, 'scopes.json')), { code: 'ENOENT' });
  for (const args of [
    ['scope', 'list', '--yaml'],
    ['scope', 'list', 'extra'],
    ['scope', 'remove'],
    ['scope', 'remove', '--workspace'],
    ['scope', 'remove', '--global', '--workspace', '/tmp/example'],
    ['scope', 'unknown'],
  ]) {
    const result = runScope(env, ...args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /^Kitto: /);
  }
});

test('scope list shows registered scopes and keeps unknown registry fields', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const workspace = join(temp, 'work'),
    parent = join(temp, 'workspaces');
  const registry = { version: 1, global: true, workspaces: [workspace], workspaceParents: [parent], lastMigration: { from: 'other-host' } };
  await mkdir(data, { recursive: true });
  await writeFile(join(data, 'scopes.json'), JSON.stringify(registry, null, 2) + '\n');
  const human = scopeOk(env, 'scope', 'list').stdout;
  assert.match(human, /Global: enabled/);
  assert.ok(human.includes(`  ${workspace}\n`));
  assert.ok(human.includes(`  ${parent}\n`));
  assert.deepEqual(JSON.parse(scopeOk(env, 'scope', 'list', '--json').stdout), registry);
  await writeFile(join(data, 'scopes.json'), JSON.stringify({ version: 2, global: true, workspaces: [] }));
  const invalid = runScope(env, 'scope', 'list');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid Kitto scope registry/);
});

test('scope remove --global only unregisters and keeps global files', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const globalRoot = join(data, 'global');
  const rules = join(globalRoot, 'AGENTS.md'),
    skill = join(globalRoot, '.agents/skills/review/SKILL.md');
  const adapter = join(globalRoot, 'host-adapter.json');
  await mkdir(join(globalRoot, '.agents/skills/review'), { recursive: true });
  await writeFile(rules, 'Global rules.\n');
  await writeFile(skill, '# review\n');
  await writeFile(adapter, '{"host":"pi"}\n');
  const registry = {
    version: 1,
    global: true,
    workspaces: [join(temp, 'work')],
    workspaceParents: [join(temp, 'parents')],
    note: 'keep me',
  };
  await writeFile(join(data, 'scopes.json'), JSON.stringify(registry, null, 2) + '\n');
  assert.match(scopeOk(env, 'scope', 'remove', '--global').stdout, /Removed global scope registration/);
  assert.deepEqual(await readScopeRegistry(data), { ...registry, global: false });
  assert.equal((await stat(join(data, 'scopes.json'))).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(data)).filter((name) => name.endsWith('.tmp')),
    [],
  );
  for (const [file, expected] of [
    [rules, 'Global rules.\n'],
    [skill, '# review\n'],
    [adapter, '{"host":"pi"}\n'],
  ]) {
    assert.equal(await readFile(file, 'utf8'), expected);
  }
  const again = runScope(env, 'scope', 'remove', '--global');
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /Global scope is not registered/);
});

test('scope remove --workspace unregisters only the exact path and keeps its files', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const workspace = join(temp, 'work'),
    sibling = workspace + '-other',
    parent = join(temp, 'parents');
  const rules = join(workspace, 'AGENTS.md'),
    skill = join(workspace, '.agents/skills/review/SKILL.md');
  await mkdir(join(workspace, '.agents/skills/review'), { recursive: true });
  await writeFile(rules, 'Workspace rules.\n');
  await writeFile(skill, '# shared\n');
  await mkdir(data, { recursive: true });
  const file = join(data, 'scopes.json');
  const registry = { version: 1, global: true, workspaces: [workspace, sibling], workspaceParents: [parent] };
  await writeFile(file, JSON.stringify(registry, null, 2) + '\n');
  assert.match(scopeOk(env, 'scope', 'remove', '--workspace', workspace).stdout, /Removed workspace scope registration/);
  assert.deepEqual(await readScopeRegistry(data), { ...registry, workspaces: [sibling] });
  assert.equal(await readFile(rules, 'utf8'), 'Workspace rules.\n');
  assert.equal(await readFile(skill, 'utf8'), '# shared\n');
  const before = await readFile(file, 'utf8');
  const unknown = runScope(env, 'scope', 'remove', '--workspace', join(temp, 'missing'));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /No workspace scope registered/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(data), ['scopes.json']);
  const relative = spawnSync(process.execPath, [cli, 'scope', 'remove', '--workspace', 'work-other'], {
    cwd: temp,
    env,
    encoding: 'utf8',
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.deepEqual((await readScopeRegistry(data)).workspaces, []);
});

test('scope remove --workspace-parent unregisters one parent and rejects unknown paths', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const parent = join(temp, 'workspaces'),
    other = join(temp, 'workspaces-other');
  const rules = join(parent, 'AGENTS.md'),
    childRules = join(parent, 'child/AGENTS.md');
  await mkdir(join(parent, 'child/.agents/skills'), { recursive: true });
  await writeFile(rules, 'Parent rules.\n');
  await writeFile(childRules, 'Child rules.\n');
  await mkdir(data, { recursive: true });
  await writeFile(
    join(data, 'scopes.json'),
    JSON.stringify(
      {
        version: 1,
        global: true,
        workspaces: [],
        workspaceParents: [parent, other],
      },
      null,
      2,
    ) + '\n',
  );
  assert.match(scopeOk(env, 'scope', 'remove', '--workspace-parent', parent).stdout, /Removed workspace-parent scope registration/);
  const registry = await readScopeRegistry(data);
  assert.deepEqual(registry.workspaceParents, [other]);
  assert.equal(registry.global, true);
  assert.equal(await readFile(rules, 'utf8'), 'Parent rules.\n');
  assert.equal(await readFile(childRules, 'utf8'), 'Child rules.\n');
  const missing = runScope(env, 'scope', 'remove', '--workspace-parent', parent);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No workspace-parent scope registered/);
  const relative = spawnSync(process.execPath, [cli, 'scope', 'remove', '--workspace-parent', 'workspaces-other'], {
    cwd: temp,
    env,
    encoding: 'utf8',
  });
  assert.equal(relative.status, 0, relative.stderr);
  assert.deepEqual((await readScopeRegistry(data)).workspaceParents, []);
});

test('scope list and remove work with registrations written by setup, including symlinked workspaces', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const workspace = join(temp, 'work'),
    alias = join(temp, 'alias');
  await mkdir(workspace);
  await symlink(workspace, alias, 'dir');
  const setup = (...args: string[]) =>
    execFileSync(process.execPath, [cli, 'setup', ...args, '--agents', 'pi'], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  setup('--global');
  setup('--workspace', alias);
  const rules = join(workspace, 'AGENTS.md'),
    skills = join(workspace, '.agents/skills');
  assert.equal((await stat(rules)).isFile(), true);
  let listed = JSON.parse(scopeOk(env, 'scope', 'list', '--json').stdout);
  assert.equal(listed.global, true);
  assert.deepEqual(listed.workspaces, [workspace]);
  assert.match(scopeOk(env, 'scope', 'remove', '--workspace', alias).stdout, /Removed workspace scope registration/);
  scopeOk(env, 'scope', 'remove', '--global');
  listed = JSON.parse(scopeOk(env, 'scope', 'list', '--json').stdout);
  assert.deepEqual(listed, { version: 1, global: false, workspaces: [], workspaceParents: [] });
  assert.equal((await stat(rules)).isFile(), true);
  assert.equal((await stat(skills)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(join(data, 'scopes.json'), 'utf8')).global, false);
});

test('scope remove respects the scope setup lock', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const workspace = join(temp, 'work'),
    file = join(data, 'scopes.json');
  await mkdir(data, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, global: true, workspaces: [workspace] }, null, 2) + '\n');
  const before = await readFile(file, 'utf8');
  await mkdir(join(data, '.scope-setup.lock'));
  const locked = runScope(env, 'scope', 'remove', '--workspace', workspace);
  assert.notEqual(locked.status, 0);
  assert.match(locked.stderr, /locked by setup/);
  assert.equal(await readFile(file, 'utf8'), before);
  await rm(join(data, '.scope-setup.lock'), { recursive: true });
  assert.equal(scopeOk(env, 'scope', 'remove', '--workspace', workspace).status, 0);
  assert.deepEqual((await readScopeRegistry(data)).workspaces, []);
});

test('writeScopeRegistry is atomic, mode 0600, and keeps unknown top-level fields', async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'kitto-scope-write-')));
  t.onTestFinished(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'nested/data'),
    workspace = join(temp, 'work'),
    file = join(home, 'scopes.json');
  assert.deepEqual(await readScopeRegistry(home), { version: 1, global: false, workspaces: [], workspaceParents: [] });
  await writeScopeRegistry(home, unchecked({ version: 1, global: true, workspaces: [workspace], future: { pinned: true } }));
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    global: true,
    workspaces: [workspace],
    workspaceParents: [],
    future: { pinned: true },
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(home), ['scopes.json']);
  const retained = JSON.parse(await readFile(file, 'utf8'));
  await writeScopeRegistry(home, { ...retained, global: false, workspaces: [] });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    version: 1,
    global: false,
    workspaces: [],
    workspaceParents: [],
    future: { pinned: true },
  });
  assert.deepEqual(await readdir(home), ['scopes.json']);
  const invalid = [
    null,
    [],
    { version: 2, global: false, workspaces: [] },
    { version: 1, global: 'yes', workspaces: [] },
    { version: 1, global: false, workspaces: ['relative'] },
    { version: 1, global: false, workspaces: [workspace], workspaceParents: 'nope' },
  ];
  for (const registry of invalid) await assert.rejects(writeScopeRegistry(home, unchecked(registry)), /Invalid Kitto scope registry/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).global, false);
  await writeFile(file, '{ not json');
  await assert.rejects(readScopeRegistry(home), /Invalid Kitto scope registry/);
});

test('scoped setup refuses the app-managed DSH desktop profile and never writes its patch', async (t) => {
  const { temp, data, env } = await scopeFixture(t);
  const workspace = join(temp, 'work');
  for (const target of [['--global'], ['--workspace', workspace], ['--workspace-parent', join(temp, 'workspaces')]]) {
    const result = runScope(env, 'setup', ...target, '--agents', 'dsh', '--dsh-profile', 'desktop');
    assert.notEqual(result.status, 0, target.join(' '));
    assert.match(result.stderr, /desktop profile is managed/);
  }
  await assert.rejects(stat(join(data, 'scopes.json')), { code: 'ENOENT' });
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  assert.equal(existsSync(join(temp, '.dsh/profiles/desktop/cordis.patch.yml')), false);

  const service = runScope(
    env,
    'setup',
    '--workspace',
    workspace,
    '--dsh-service',
    'dsh.service',
    '--agents',
    'dsh',
    '--dsh-profile',
    'desktop',
  );
  assert.notEqual(service.status, 0);
  assert.match(service.stderr, /cannot be configured for a system service/);

  const mixed = runScope(env, 'setup', '--global', '--agents', 'pi,dsh', '--dsh-profile', 'desktop');
  assert.equal(mixed.status, 0, mixed.stderr);
  assert.match(mixed.stderr, /skipping the DSH desktop profile/);
  assert.equal(JSON.parse(await readFile(join(data, 'scopes.json'), 'utf8')).global, true);
  assert.equal(existsSync(join(temp, '.dsh/profiles/desktop/cordis.patch.yml')), false);
});
