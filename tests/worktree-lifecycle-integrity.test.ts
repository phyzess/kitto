import assert from 'node:assert/strict';
import { chmod, lstat, lutimes, readFile, readlink, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fixture } from './helpers/worktree-fixture.ts';

const finishFlags = (head: string) => ['--quiescent', '--delivered', head];

async function cacheOldStat(
  f: Awaited<ReturnType<typeof fixture>>,
  checkout: string,
  path: string,
  setTime: (path: string, atime: number, mtime: number) => Promise<void>,
) {
  f.git('config', 'core.trustctime', 'false');
  f.git('config', 'core.checkStat', 'minimal');
  const time = 1000000000;
  await setTime(path, time, time);
  f.git('-C', checkout, 'update-index', '--refresh');
  return () => setTime(path, time, time);
}

test('same-size cached-stat edits cannot receive or use a removal token', async (t) => {
  const f = await fixture(t);
  const created = f.start();
  const path = join(created.path, 'tracked');
  const restoreMtime = await cacheOldStat(f, created.path, path, utimes);
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  await writeFile(path, 'lost\n');
  await restoreMtime();
  assert.equal(f.git('-C', created.path, '--no-optional-locks', 'status', '--porcelain'), '');
  assert.equal(f.invoke('finish', flags).confirm, null);
  assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
  assert.equal(await readFile(path, 'utf8'), 'lost\n');
});

test('a cached-stat symlink edit is checked as object bytes, not as the target file', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, 'otherxx'), 'base\n');
  await symlink('tracked', join(f.repo, 'link'));
  f.git('add', 'otherxx', 'link');
  f.git('commit', '-m', 'Add a tracked link');
  const created = f.start();
  const path = join(created.path, 'link');
  const restoreMtime = await cacheOldStat(f, created.path, path, lutimes);
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  await rm(path);
  await symlink('otherxx', path);
  await restoreMtime();
  assert.equal(f.git('-C', created.path, '--no-optional-locks', 'status', '--porcelain'), '');
  assert.equal(await readFile(path, 'utf8'), 'base\n');
  assert.equal(f.invoke('finish', flags).confirm, null);
  assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
  assert.equal(await readlink(path), 'otherxx');
});

test('Git filemode settings cannot hide a checkout mode mismatch', async (t) => {
  const f = await fixture(t);
  const created = f.start();
  const path = join(created.path, 'tracked');
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  f.git('config', 'core.filemode', 'false');
  await chmod(path, 0o755);
  assert.equal(f.git('-C', created.path, '--no-optional-locks', 'status', '--porcelain'), '');
  assert.equal(f.invoke('finish', flags).confirm, null);
  assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
  assert.equal((await lstat(path)).mode & 0o777, 0o755);
});

test('removal refuses active conversion or filters even if checkout bytes match', async (t) => {
  const f = await fixture(t);
  const created = f.start();
  const path = join(created.path, 'tracked');
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);

  const attributes = join(f.repo, '.git', 'info', 'attributes');
  await writeFile(attributes, 'tracked text\n');
  assert.ok(f.invoke('finish', flags).blockers.includes('filesystem-unverified'));
  assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
  await rm(attributes);
  f.git('config', 'core.autocrlf', 'input');
  assert.equal(f.invoke('finish', flags).confirm, null);
  f.git('config', '--unset', 'core.autocrlf');

  const filterRan = join(f.root, 'filter-ran');
  await writeFile(attributes, 'tracked filter=tripwire\n');
  f.git('config', 'filter.tripwire.clean', `touch '${filterRan}'; cat`);
  assert.equal(f.invoke('finish', flags).confirm, null);
  assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
  await assert.rejects(lstat(filterRan), { code: 'ENOENT' });
  assert.equal(await readFile(path, 'utf8'), 'base\n');
});

test('an unreadable tracked file cannot be approved even with a clean index cache', async (t) => {
  if (!process.getuid || process.getuid() === 0) return t.skip('Requires an unprivileged POSIX user');
  const f = await fixture(t);
  const created = f.start();
  const path = join(created.path, 'tracked');
  await cacheOldStat(f, created.path, path, utimes);
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  await chmod(path, 0);
  try {
    await assert.rejects(readFile(path), { code: 'EACCES' });
    assert.equal(f.git('-C', created.path, '--no-optional-locks', 'status', '--porcelain'), '');
    assert.ok(f.invoke('finish', flags).blockers.includes('filesystem-unverified'));
    assert.notEqual(f.run('apply', [...flags, '--confirm', clean.confirm]).status, 0);
    assert.equal((await lstat(path)).mode & 0o777, 0);
  } finally {
    await chmod(path, 0o644);
  }
  assert.equal(await readFile(path, 'utf8'), 'base\n');
});

test('clean SHA-256 blobs are verified as raw bytes, including binary files', async (t) => {
  const f = await fixture(t, 'sha256');
  const name = 'binary\tfile\n';
  const bytes = Buffer.from([0, 255, 10, 13]);
  await writeFile(join(f.repo, name), bytes);
  f.git('add', '--', name);
  f.git('commit', '-m', 'Add binary blob');
  const created = f.start();
  assert.equal(created.baseHead.length, 64);
  assert.deepEqual(await readFile(join(created.path, name)), bytes);
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  assert.equal(f.invoke('apply', [...flags, '--confirm', clean.confirm]).applied, true);
  assert.equal(f.git('rev-parse', `refs/heads/${created.branch}`), created.baseHead);
});
