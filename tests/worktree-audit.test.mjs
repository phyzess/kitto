import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/kitto.mjs', import.meta.url));
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'kitto-audit-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'), ws = join(root, 'workspace'), repo = join(ws, 'example');
  await mkdir(home); await mkdir(repo, { recursive: true });
  const env = { GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, KITTO_HOME: join(root, 'not-created') };
  function run(cmd, args, cwd = repo, extra = {}) {
    return spawnSync(cmd, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
  }
  function git(...args) {
    const r = run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.org', ...args]);
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  }
  function audit(cwd, args = [], extra) {
    const r = run(process.execPath, [cli, 'worktree', 'audit', '--json', ...args], cwd, extra);
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
  }
  git('init', '-b', 'main');
  await writeFile(join(repo, 'tracked'), 'base\n'); await writeFile(join(repo, '.gitignore'), '*.ignored\n');
  git('add', '.'); git('commit', '-m', 'Base');
  return { root, ws, repo, git, run, audit };
}

async function snapshot(root) {
  const files = {};
  async function visit(path) {
    const stat = await lstat(path, { bigint: true });
    files[path] = [stat.mode, stat.mtimeNs];
    if (stat.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
    else if (stat.isFile()) files[path].push(createHash('sha256').update(await readFile(path)).digest('hex'));
  }
  await visit(root); return files;
}

test('inventory is ordered, lossless for unusual paths, read-only, and never a deletion decision', async t => {
  const { root, ws, repo, git, audit } = await fixture(t);
  const linked = join(ws, 'ticket 雪\t"\n'), gone = join(root, 'missing tree');
  git('worktree', 'add', '-b', 'feature', linked);
  git('worktree', 'add', '--detach', gone);
  assert.equal(dirname(gone), root); await rename(gone, join(root, 'relocated'));
  git('-C', linked, 'commit', '--allow-empty', '-m', 'Only local');
  git('worktree', 'lock', '--reason', 'Active', linked);
  await writeFile(join(linked, 'tracked'), 'edited'); await writeFile(join(linked, 'local.ignored'), 'private');
  await writeFile(join(linked, 'large'), Buffer.alloc(2e6, 42));
  await mkdir(join(repo, 'sub')); await utimes(join(repo, 'tracked'), 1, 1);
  const before = await snapshot(root);
  const rows = audit(join(repo, 'sub'), [], { GIT_DIR: '/wrong-repo', GIT_TRACE: join(root, 'unexpected') });
  assert.deepEqual(rows, audit(root, ['--workspace', ws]));
  assert.deepEqual(await snapshot(root), before);
  assert.equal(rows.length, 3);
  const [large, primary, missing] = rows;
  assert.equal(large.path, linked); assert.ok(large.estimatedBytes > primary.estimatedBytes);
  assert.deepEqual(large.changes, { tracked: true, untracked: true, ignored: true });
  assert.equal(large.locked, true); assert.equal(large.mergedIntoLocalBase, false);
  assert.equal(primary.primary, true); assert.equal(primary.mergedIntoLocalBase, true);
  assert.equal(missing.path, gone); assert.equal(missing.estimatedBytes, null); assert.equal(missing.prunable, true);
  assert.equal(missing.detached, true); assert.ok(missing.blockers.includes('identity-unknown'));
  for (const row of rows) {
    assert.equal(row.ownership, 'unmanaged'); assert.equal(row.occupancy, 'unknown');
    assert.ok(row.blockers.includes('occupancy-unknown'));
  }
});

test('a linked checkout cannot borrow another registration’s Git directory at the same HEAD', async t => {
  const { root, repo, git, audit } = await fixture(t);
  const first = join(root, 'first'), second = join(root, 'second');
  git('worktree', 'add', '-b', 'first', first);
  git('worktree', 'add', '-b', 'second', second);
  const original = audit(repo);
  const firstOriginal = original.find(row => row.path === first);
  const secondOriginal = original.find(row => row.path === second);
  assert.equal(firstOriginal.head, secondOriginal.head);
  assert.notEqual(firstOriginal.gitDir, secondOriginal.gitDir);
  assert.ok(firstOriginal.changes);
  git('branch', '--set-upstream-to=main', 'first');
  await writeFile(join(first, '.git'), await readFile(join(second, '.git')));
  await writeFile(join(secondOriginal.gitDir, 'MERGE_HEAD'), `${secondOriginal.head}\n`);

  const before = await snapshot(root);
  const rows = audit(repo);
  assert.deepEqual(audit(first), rows);
  const broken = rows.find(row => row.path === first);
  const intact = rows.find(row => row.path === second);
  assert.equal(broken.branch, 'refs/heads/first');
  assert.equal(broken.head, secondOriginal.head);
  assert.deepEqual(broken.blockers, ['unmanaged', 'occupancy-unknown', 'identity-unknown']);
  for (const key of ['gitDir', 'estimatedBytes', 'changes', 'upstream', 'mergedIntoLocalBase']) {
    assert.equal(broken[key], null, key);
  }
  assert.equal(intact.gitDir, secondOriginal.gitDir);
  assert.ok(intact.changes);
  assert.ok(intact.blockers.includes('git-operation:MERGE_HEAD'));
  assert.deepEqual(await snapshot(root), before);
});

test('duplicate registrations cannot supply checkout identity even when one backlink matches', async t => {
  const { root, repo, git, audit } = await fixture(t);
  const first = join(root, 'first'), second = join(root, 'second');
  git('worktree', 'add', '-b', 'first', first);
  git('worktree', 'add', '-b', 'second', second);
  const { gitDir } = audit(repo).find(row => row.path === second);
  await writeFile(join(gitDir, 'gitdir'), `${join(first, '.git')}\n`);

  const before = await snapshot(root);
  const duplicates = audit(repo).filter(row => row.path === first);
  assert.deepEqual(duplicates.map(row => row.branch).sort(), ['refs/heads/first', 'refs/heads/second']);
  for (const row of duplicates) {
    assert.ok(row.blockers.includes('identity-unknown'));
    assert.equal(row.gitDir, null);
    assert.equal(row.changes, null);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('masked index entries and configured filters cannot become evidence of clean status', async t => {
  const { root, repo, git, audit } = await fixture(t);
  git('update-index', '--assume-unchanged', 'tracked');
  await writeFile(join(repo, 'tracked'), 'hidden');
  assert.ok(audit(repo)[0].blockers.includes('masked-index-entries'));
  git('update-index', '--no-assume-unchanged', 'tracked'); git('update-index', '--skip-worktree', 'tracked');
  assert.ok(audit(repo)[0].blockers.includes('masked-index-entries'));
  git('config', 'filter.local.clean', 'exit 1');
  await writeFile(join(repo, '.gitattributes'), '* filter=local\n');
  const before = await snapshot(root);
  const [row] = audit(repo); assert.equal(row.changes, null); assert.ok(row.blockers.includes('changes-unknown'));
  assert.deepEqual(await snapshot(root), before);
});

test('an unreadable directory makes status unknown even when Git exits successfully', async t => {
  if (!process.getuid || process.getuid() === 0) return t.skip('Requires an unprivileged POSIX user');
  const { root, repo, run, audit } = await fixture(t);
  const hidden = join(repo, 'unreadable');
  await mkdir(hidden, { mode: 0o700 });
  await writeFile(join(hidden, 'local'), 'untracked');
  await writeFile(join(hidden, 'local.ignored'), 'ignored');
  const [visible] = audit(repo);
  assert.deepEqual(visible.changes, { tracked: false, untracked: true, ignored: true });
  const before = await snapshot(root);

  await chmod(hidden, 0);
  try {
    await assert.rejects(readdir(hidden), { code: 'EACCES' });
    const result = run('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--no-renames',
      '--ignored=matching', '--untracked-files=normal', '--ignore-submodules=all']);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.stderr, '');
    assert.equal(result.stdout, '');

    const [row] = audit(repo);
    assert.equal(row.gitDir, visible.gitDir);
    assert.equal(row.changes, null);
    assert.ok(row.blockers.includes('changes-unknown'));
  } finally {
    await chmod(hidden, 0o700);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('other probe diagnostics cannot become evidence just because the exit code matches', async t => {
  const { root, repo, audit } = await fixture(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!/bin/sh
PATH=\${PATH#*:}
export PATH
for arg do
  case "$arg" in
    config) printf 'incomplete\\n' >&2; exit 1 ;;
    ls-files|merge-base|for-each-ref) printf 'incomplete\\n' >&2; break ;;
  esac
done
exec git "$@"
`, { mode: 0o700 });
  await writeFile(join(bin, 'du'), `#!/bin/sh
printf '1\\t%s\\n' "$2"
printf 'incomplete\\n' >&2
`, { mode: 0o700 });
  const before = await snapshot(root);
  const [row] = audit(repo, [], { PATH: `${bin}:${process.env.PATH}` });
  for (const key of ['changes', 'estimatedBytes', 'upstream', 'mergedIntoLocalBase']) assert.equal(row[key], null, key);
  for (const blocker of ['changes-unknown', 'size-unknown', 'upstream-unknown', 'ancestry-unknown', 'index-flags-unknown']) {
    assert.ok(row.blockers.includes(blocker), blocker);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('split index timestamps are not refreshed by read-only probes', async t => {
  const { root, repo, git, audit } = await fixture(t);
  git('update-index', '--split-index');
  for (const name of await readdir(join(repo, '.git'))) {
    if (name.startsWith('sharedindex.')) await utimes(join(repo, '.git', name), 1, 1);
  }
  const before = await snapshot(root);
  assert.ok(audit(repo)[0].blockers.includes('index-probe-skipped'));
  assert.deepEqual(await snapshot(root), before);
});

test('workspace contains distinct clones; malformed or mutating requests fail without writes', async t => {
  const { ws, root, repo, git, run, audit } = await fixture(t);
  git('clone', repo, join(ws, 'another'));
  const before = await snapshot(root);
  assert.equal(new Set(audit(root, ['--workspace', ws]).map(row => row.commonDir)).size, 2);
  for (const args of [['remove'], ['audit', '--apply'], ['audit', '--workspace'], ['audit']]) {
    const result = run(process.execPath, [cli, 'worktree', ...args], root);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Kitto:/);
  }
  assert.deepEqual(await snapshot(root), before);
});
