import assert from 'node:assert/strict';
import { lstat, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { fixture } from './helpers/worktree-fixture.ts';

test('start is read-only until confirmation and reuses the same local task checkout', async (t) => {
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
  assert.equal(
    f
      .git('worktree', 'list', '--porcelain')
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    2,
  );
});

test('next-start hints are repository-local counts and never treat host events as handoff', async (t) => {
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
  assert.equal(
    f.invoke('finish', ['--quiescent', '--delivered', claimed.baseHead], {
      task: 'claimed-task',
      session: 'private-parent-session',
    }).confirm,
    null,
  );
  const other = await fixture(t);
  assert.deepEqual(other.invoke('start').handoffHints, { otherClaimed: 0, otherUnclaimed: 0, otherInterrupted: 0, incomplete: false });
});

test('lifecycle ledger hints mark unknown rows and never read a symlink target', async (t) => {
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
