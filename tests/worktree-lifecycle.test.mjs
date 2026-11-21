import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, lstat, lutimes, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url));

async function fixture(t, objectFormat = 'sha1') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kitto-lifecycle-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), repo = join(root, 'repo'), scopes = join(home, 'data');
  const state = join(home, 'state');
  await mkdir(scopes, { recursive: true });
  await mkdir(repo);
  const env = { PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: state, KITTO_HOME: scopes, GIT_CONFIG_NOSYSTEM: '1' };
  function git(...args) {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  }
  async function scope(workspaces = [repo]) {
    await writeFile(join(scopes, 'scopes.json'), JSON.stringify({ version: 1, global: true, workspaces }));
  }
  git('init', `--object-format=${objectFormat}`, '-b', 'main');
  await writeFile(join(repo, 'tracked'), 'base\n');
  await writeFile(join(repo, '.gitignore'), '*.ignored\n');
  git('add', '.'); git('commit', '-m', 'Base');
  await scope();
  const args = (command, flags = [], { task = 'ticket-42', session = 'parent' } = {}) =>
    [cli, 'worktree', command, '--repo', repo, '--task', task, '--session', session, ...flags];
  function run(command, flags, options, cwd = repo) {
    return spawnSync(process.execPath, args(command, flags, options), { cwd, env, encoding: 'utf8' });
  }
  function invoke(...args) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }
  function start(options) {
    const preview = invoke('start', [], options);
    return invoke('start', ['--confirm', preview.confirm], options);
  }
  function concurrently(command, flags, options) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args(command, flags, options), { cwd: repo, env });
      let stderr = '', stdout = '';
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.once('error', reject).once('close', status => resolve({status, stderr, stdout}));
    });
  }
  return { root, repo, state, git, scope, run, invoke, start, concurrently, env };
}

test('start is read-only until confirmation and reuses the same local task checkout', async t => {
  const f = await fixture(t);
  const preview = f.invoke('start');
  assert.equal(preview.action, 'create');
  assert.equal(preview.baseHead, f.git('rev-parse', 'HEAD'));
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
  await assert.rejects(lstat(preview.path), { code: 'ENOENT' });
  const created = f.invoke('start', ['--confirm', preview.confirm]);
  assert.equal(created.path, preview.path);
  assert.equal(f.git('-C', created.path, 'branch', '--show-current'), created.branch);
  assert.equal(f.git('branch', '--show-current'), 'main');
  const reused = f.start();
  assert.equal(reused.action, 'reuse');
  assert.equal(reused.path, created.path);
  assert.equal(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 2);
});

test('next-start hints are repository-local counts and never treat host events as handoff', async t => {
  const f = await fixture(t);
  const claimed = f.start({ task: 'claimed-task', session: 'private-parent-session' });
  f.start({ task: 'claimed-task', session: 'private-fork-session' });
  const released = { task: 'released-task' };
  f.start(released);
  const release = ['--quiescent', '--release'];
  const { confirm } = f.invoke('finish', release, released);
  f.invoke('apply', [...release, '--confirm', confirm], released);
  const fork = f.invoke('start', [], { task: 'claimed-task', session: 'private-parent-session' });
  const before = f.invoke('start');
  assert.deepEqual(before.handoffHints, { otherClaimed: 1, otherUnclaimed: 1, otherInterrupted: 0, incomplete: false });
  for (const name of ['private-parent-session', 'private-fork-session', 'claimed-task', 'released-task', claimed.path]) {
    assert.ok(!JSON.stringify(before).includes(name));
  }
  for (const event of ['unarchive', 'archive', 'archive', 'reload', 'fork', 'SessionEnd', 'exit', 'unarchive']) {
    assert.notEqual(f.run(event).status, 0);
  }
  assert.deepEqual(f.invoke('start'), before);
  assert.deepEqual(f.invoke('start', [], { task: 'claimed-task', session: 'private-parent-session' }), fork);
  assert.equal(f.invoke('finish', ['--quiescent', '--delivered', claimed.baseHead], {
    task: 'claimed-task', session: 'private-parent-session',
  }).confirm, null);
  const other = await fixture(t);
  assert.deepEqual(other.invoke('start').handoffHints, { otherClaimed: 0, otherUnclaimed: 0, otherInterrupted: 0, incomplete: false });
});

test('lifecycle ledger hints mark unknown rows and never read a symlink target', async t => {
  const f = await fixture(t);
  const kept = f.start({ task: 'kept' });
  const bucket = join(kept.path, '..');
  const data = join(bucket, 'a'.repeat(64) + '.json');
  await writeFile(data, '{not a ledger}', { mode: 0o600 });
  await symlink(`${kept.path}.json`, join(bucket, 'b'.repeat(64) + '.json'));
  const before = f.invoke('start');
  assert.deepEqual(before.handoffHints, { otherClaimed: 1, otherUnclaimed: 0, otherInterrupted: 0, incomplete: true });
  assert.equal(await readFile(data, 'utf8'), '{not a ledger}');
  assert.equal(f.invoke('start', ['--confirm', before.confirm]).applied, true);
});

test('finish previews removal, apply requires its current token and preserves the branch', async t => {
  const f = await fixture(t);
  const created = f.start();
  const flags = ['--quiescent', '--delivered', created.baseHead];
  const preview = f.invoke('finish', flags);
  assert.equal(preview.action, 'remove');
  assert.equal(preview.path, created.path);
  assert.deepEqual(preview.blockers, []);
  assert.ok(preview.confirm);
  assert.ok((await lstat(created.path)).isDirectory());
  assert.notEqual(f.run('apply', flags).status, 0);
  assert.notEqual(f.run('apply', [...flags, '--confirm', preview.confirm], undefined, created.path).status, 0);
  const result = f.invoke('apply', [...flags, '--confirm', preview.confirm]);
  assert.equal(result.applied, true);
  await assert.rejects(lstat(created.path), { code: 'ENOENT' });
  assert.equal(f.git('rev-parse', `refs/heads/${created.branch}`), created.baseHead);
  assert.notEqual(f.run('apply', [...flags, '--confirm', preview.confirm]).status, 0);
});

const finishFlags = head => ['--quiescent', '--delivered', head];

test('a stale preview or another active session cannot authorize removal', async t => {
  const f = await fixture(t);
  const created = f.start();
  const flags = finishFlags(created.baseHead);
  const initial = f.invoke('finish', flags);
  f.start({ session: 'child' });
  assert.notEqual(f.run('apply', [...flags, '--confirm', initial.confirm]).status, 0);
  assert.ok(f.invoke('finish', flags).blockers.includes('other-sessions-active'));
  const child = { session: 'child' }, release = ['--quiescent', '--release'];
  const childExit = f.invoke('finish', release, child);
  f.invoke('apply', [...release, '--confirm', childExit.confirm], child);
  assert.notEqual(f.run('apply', [...flags, '--confirm', initial.confirm]).status, 0);
  const preview = f.invoke('finish', flags);
  const hidden = join(created.path, 'secret.ignored');
  await writeFile(hidden, 'not disposable');
  assert.ok(f.invoke('finish', flags).blockers.includes('ignored'));
  assert.notEqual(f.run('apply', [...flags, '--confirm', preview.confirm]).status, 0);
  await lstat(hidden);
});

test('dirty, untracked, empty, locked or undelivered work is not removable', async t => {
  const f = await fixture(t);
  const created = f.start();
  const flags = finishFlags(created.baseHead);
  const blocks = name => assert.ok(f.invoke('finish', flags).blockers.includes(name), name);
  await writeFile(join(created.path, 'tracked'), 'edited');
  blocks('tracked');
  f.git('-C', created.path, 'restore', 'tracked');
  const newFile = join(created.path, 'new');
  await writeFile(newFile, 'new');
  blocks('untracked');
  await rm(newFile);
  const empty = join(created.path, 'empty');
  await mkdir(empty);
  blocks('filesystem-unverified');
  await rm(empty, { recursive: true });
  f.git('worktree', 'lock', created.path);
  blocks('locked');
  f.git('worktree', 'unlock', created.path);
  f.git('-C', created.path, 'commit', '--allow-empty', '-m', 'Not delivered');
  blocks('not-in-local-base');
  const delivered = f.git('-C', created.path, 'rev-parse', 'HEAD');
  f.git('merge', '--ff-only', created.branch);
  blocks('delivery-head-mismatch');
  assert.ok(f.invoke('finish', finishFlags(delivered)).confirm);
});

test('parallel start confirmations cannot adopt or duplicate a checkout', async t => {
  const f = await fixture(t);
  const next = { session: 'second' };
  const a = f.invoke('start'), b = f.invoke('start', [], next);
  const results = await Promise.all([
    f.concurrently('start', ['--confirm', a.confirm]),
    f.concurrently('start', ['--confirm', b.confirm], next),
  ]);
  assert.equal(results.filter(result => result.status === 0).length, 1, JSON.stringify(results));
  const denied = results.find(result => result.status !== 0);
  assert.match(denied.stderr, /locked|stale/);
  assert.equal(f.invoke('start').action, 'reuse');
  assert.equal(f.git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 2);
});

test('scope changes, imported worktrees and other local stores do not convey ownership', async t => {
  const f = await fixture(t);
  const preview = f.invoke('start');
  await f.scope([]);
  assert.match(f.run('start', ['--confirm', preview.confirm]).stderr, /explicit workspace/);
  await assert.rejects(lstat(f.state), { code: 'ENOENT' });
  await f.scope();
  await mkdir(join(preview.path, '..'), { recursive: true, mode: 0o700 });
  f.git('worktree', 'add', '-b', preview.branch, preview.path);
  assert.match(f.run('start', ['--confirm', preview.confirm]).stderr, /does not adopt/);
  assert.match(f.run('finish', finishFlags(preview.baseHead)).stderr, /No owned/);
  await lstat(preview.path);
  const created = f.start({ task: 'other' });
  const originalState = f.env.XDG_STATE_HOME;
  f.env.XDG_STATE_HOME = join(f.root, 'different-state');
  assert.match(f.run('finish', finishFlags(created.baseHead), { task: 'other' }).stderr, /No owned/);
  f.env.XDG_STATE_HOME = originalState;
  assert.ok(f.invoke('finish', finishFlags(created.baseHead), { task: 'other' }).confirm);
});

test('a completed removal with interrupted bookkeeping can be recorded without Git removal', async t => {
  const f = await fixture(t);
  const created = f.start();
  const flags = finishFlags(created.baseHead);
  const plan = f.invoke('finish', flags);
  const bin = join(f.root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!/bin/sh
PATH=\${PATH#*:}
export PATH
case " $* " in
  *' worktree remove '*) git "$@" && exit 9; exit 8 ;;
  *) exec git "$@" ;;
esac
`, { mode: 0o700 });
  const originalPath = f.env.PATH;
  f.env.PATH = `${bin}:${originalPath}`;
  assert.match(f.run('apply', [...flags, '--confirm', plan.confirm]).stderr, /interrupted/);
  await assert.rejects(lstat(created.path), { code: 'ENOENT' });
  const recovered = f.invoke('finish', flags);
  assert.equal(recovered.action, 'record-removed');
  assert.notEqual(recovered.confirm, plan.confirm);
  assert.equal(f.invoke('apply', [...flags, '--confirm', recovered.confirm]).applied, true);
  assert.equal(f.git('rev-parse', `refs/heads/${created.branch}`), created.baseHead);
  f.env.PATH = originalPath;
});

test('unknown index state or a replacement checkout never authorizes removal', async t => {
  const f = await fixture(t);
  const created = f.start();
  const flags = finishFlags(created.baseHead);
  const preview = f.invoke('finish', flags);
  f.git('-C', created.path, 'update-index', '--split-index');
  assert.ok(f.invoke('finish', flags).blockers.includes('index-probe-skipped'));
  assert.notEqual(f.run('apply', [...flags, '--confirm', preview.confirm]).status, 0);
  f.git('worktree', 'remove', created.path);
  f.git('worktree', 'add', created.path, created.branch);
  assert.match(f.run('finish', flags).stderr, /ownership marker is missing|identity has changed/);
  assert.notEqual(f.run('apply', [...flags, '--confirm', preview.confirm]).status, 0);
  await lstat(created.path);
});

test('checkout does not execute filters activated only for linked Git directories', async t => {
  const f = await fixture(t);
  const config = join(f.root, 'linked-config'), marker = join(f.root, 'filter-ran');
  await writeFile(config, `[filter "local"]\n\tsmudge = touch '${marker}'\n`);
  f.git('config', '--add', `includeIf.gitdir:${f.repo}/.git/worktrees/**.path`, config);
  await writeFile(join(f.repo, '.gitattributes'), 'tracked filter=local\n');
  f.git('add', '.gitattributes'); f.git('commit', '-m', 'Configure attributes');
  const plan = f.invoke('start');
  assert.match(f.run('start', ['--confirm', plan.confirm]).stderr, /filters in the new checkout/);
  await assert.rejects(lstat(marker), { code: 'ENOENT' });
  await assert.rejects(lstat(join(plan.path, 'tracked')), { code: 'ENOENT' });
  assert.match(f.run('start').stderr, /does not adopt/);
});

async function cacheOldStat(f, checkout, path, setTime) {
  // Minimal stat checks ignore ctime and inode, and the old mtime avoids racily-clean handling.
  f.git('config', 'core.trustctime', 'false');
  f.git('config', 'core.checkStat', 'minimal');
  const time = 1000000000;
  await setTime(path, time, time);
  f.git('-C', checkout, 'update-index', '--refresh');
  return () => setTime(path, time, time);
}

test('same-size cached-stat edits cannot receive or use a removal token', async t => {
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

test('a cached-stat symlink edit is checked as object bytes, not as the target file', async t => {
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

test('Git filemode settings cannot hide a checkout mode mismatch', async t => {
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

test('removal refuses active conversion or filters even if checkout bytes match', async t => {
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

test('an unreadable tracked file cannot be approved even with a clean index cache', async t => {
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
  } finally { await chmod(path, 0o644); }
  assert.equal(await readFile(path, 'utf8'), 'base\n');
});

test('clean SHA-256 blobs are verified as raw bytes, including binary files', async t => {
  const f = await fixture(t, 'sha256');
  const name = 'binary\tfile\n';
  const bytes = Buffer.from([0, 255, 10, 13]);
  await writeFile(join(f.repo, name), bytes);
  f.git('add', '--', name); f.git('commit', '-m', 'Add binary blob');
  const created = f.start();
  assert.equal(created.baseHead.length, 64);
  assert.deepEqual(await readFile(join(created.path, name)), bytes);
  const flags = finishFlags(created.baseHead);
  const clean = f.invoke('finish', flags);
  assert.ok(clean.confirm);
  assert.equal(f.invoke('apply', [...flags, '--confirm', clean.confirm]).applied, true);
  assert.equal(f.git('rev-parse', `refs/heads/${created.branch}`), created.baseHead);
});
