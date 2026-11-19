import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveScopes } from '../lib/scopes.mjs';

const cli = fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url));

test('scoped CLI preserves shared files and discovers repos created after setup', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "kitto user's scope ")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data'), workspace = join(temp, 'work'), other = workspace + '-other';
  const env = { ...process.env, HOME: temp, KITTO_HOME: data, PI_CODING_AGENT_DIR: join(temp, 'pi') };
  const setup = (...args) => execFileSync(process.execPath, [cli, 'setup', ...args, '--agents', 'pi'], { env, encoding: 'utf8' });
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
  const roots = async dir => (await resolveScopes(dir, data)).map(scope => scope.root);
  assert.deepEqual(await roots(join(alias, 'sub/new-repo')), [join(data, 'global'), workspace, nested]);
  assert.deepEqual(await roots(other), [join(data, 'global')]);
  assert.equal(await readFile(join(repo, 'AGENTS.md'), 'utf8'), 'Repo rules.\n');
});

test('a workspace parent opts future child workspaces in independently', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'kitto-workspace-parent-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const data = join(temp, 'data');
  const parent = join(temp, 'workspaces');
  const parentAlias = join(temp, 'alias');
  const outside = join(temp, 'workspaces-other');
  const env = { ...process.env, HOME: temp, KITTO_HOME: data, PI_CODING_AGENT_DIR: join(temp, 'pi') };
  const setup = (...args) => execFileSync(process.execPath, [cli, 'setup', ...args, '--agents', 'pi'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
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
  const roots = async dir => (await resolveScopes(dir, data)).map(scope => scope.root);
  assert.deepEqual(await resolveScopes(join(parentAlias, 'workspace-1/new-clone'), data), [{
    root: first, instructions: join(first, 'AGENTS.md'), skills: join(first, '.agents/skills'),
  }]);
  assert.deepEqual(await roots(second), [second]);
  assert.deepEqual(await roots(parent), []);
  assert.deepEqual(await roots(outside), []);
  const escape = join(parent, 'outside-link');
  await symlink(outside, escape, 'dir');
  assert.deepEqual(await roots(escape), []);
  setup('--workspace', first);
  assert.deepEqual(await roots(repo), [first]);
});
