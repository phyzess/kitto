import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { clearGitIdentityCache, commonDir, git, registrations } from '../lib/worktree-audit.ts';

test('a repository mutation drops the cached identity lookups', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kitto-git-cache-')));
  t.onTestFinished(async () => {
    clearGitIdentityCache();
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, 'repo');
  await mkdir(repo);
  const runGit = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', '-C', repo, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'tracked'), 'base\n');
  runGit('add', '.');
  runGit('commit', '-qm', 'Base');

  const common = await commonDir(repo);
  assert.equal(registrations(repo).length, 1);
  assert.equal(registrations(repo).length, 1, 'a repeated read keeps the cached listing');
  assert.equal(await commonDir(repo), common);

  const linked = join(root, 'linked');
  git(repo, 'worktree', 'add', '-q', '--detach', linked);
  assert.equal(registrations(repo).length, 2, 'a worktree mutation must drop the cached registration list');

  assert.equal(await commonDir(linked), common, 'the new worktree resolves the same common directory');
  git(repo, 'worktree', 'remove', '--force', linked);
  assert.equal(registrations(repo).length, 1, 'a worktree removal must drop the cached registration list too');
});

test('a non-mutating config read keeps the cache and a config write drops it', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kitto-git-cache-')));
  t.onTestFinished(async () => {
    clearGitIdentityCache();
    await rm(root, { recursive: true, force: true });
  });
  const repo = join(root, 'repo');
  await mkdir(repo);
  const runGit = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', '-C', repo, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'tracked'), 'base\n');
  runGit('add', '.');
  runGit('commit', '-qm', 'Base');
  assert.equal(registrations(repo).length, 1);

  git(repo, 'config', '--get-regexp', '^filter\\..*\\.(clean|process)$');
  git(repo, 'config', 'branch.main.description', 'written by the test');
  assert.equal(
    git(repo, 'config', '--get', 'branch.main.description').stdout?.toString().trim(),
    'written by the test',
    'the config write is visible through the shared git helper',
  );
  assert.equal(registrations(repo).length, 1);
});
