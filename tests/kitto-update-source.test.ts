import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  command,
  fixture,
  good,
  readJson,
  snapshot,
  bootstrapMarkerFor,
  withRemote,
  commitAll,
  mirrorOf,
} from './helpers/kitto-fixture.ts';
import { requireEnv } from './helpers/kitto-suite.ts';

test('update preview covers the app-managed DSH desktop branch without a dsh CLI', (t) => {
  const f = fixture(t);
  rmSync(join(f.temp, 'bin/dsh'));
  mkdirSync(join(f.source, 'config/dsh'), { recursive: true });
  writeFileSync(join(f.source, 'config/dsh/AGENTS.md'), 'Desktop portable rules');
  commitAll(f, 'desktop rules');
  good(f.cli('setup', '--agents', 'dsh', '--dsh-profile', 'desktop', '--source', f.source));
  withRemote(f);
  const home = requireEnv(f.env, 'KITTO_HOME');
  const logBefore = existsSync(f.log) ? readFileSync(f.log, 'utf8') : '';
  const before = snapshot(home);
  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /dsh: app-managed .*upgrade through DeepSeek Harness Desktop/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(existsSync(f.log) ? readFileSync(f.log, 'utf8') : '', logBefore);
});

test('kitto update restores a lost managed checkout from the recorded source URL', (t) => {
  const f = fixture(t),
    { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config');
  assert.equal(readJson(join(home, 'state.json')).sourceUrl, url);
  assert.equal(readJson(join(home, 'state.json')).sourceRef, 'main');
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'restored from source URL');
  commitAll(f, 'remote update');
  good(command('git', ['push', join(f.temp, 'remote.git'), 'main'], f.env, f.source));
  rmSync(managed, { recursive: true });

  const preview = f.cli('update', '--check');
  good(preview);
  assert(preview.stdout.includes(`Restore configuration checkout from ${url} (main): ${managed}`));
  assert.equal(existsSync(managed), false);

  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(join(home, 'state.json')).sourceUrl, url);
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), 'restored from source URL');
  assert.equal(
    command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'main'], f.env, join(f.temp, 'remote.git')).stdout.trim(),
  );
});

test('kitto update restores a lost checkout on its recorded non-default branch', (t) => {
  const f = fixture(t);
  const git = (...args: string[]) => command('git', args, f.env, f.source);
  good(git('checkout', '-b', 'alt'));
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'alt branch content');
  commitAll(f, 'alt config');
  good(git('checkout', 'main'));
  const { mirror, url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'alt'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config'),
    statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceRef, 'alt');
  assert.equal(command('git', ['symbolic-ref', '--short', 'HEAD'], f.env, managed).stdout.trim(), 'alt');
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), 'alt branch content');
  rmSync(managed, { recursive: true });

  const preview = f.cli('update', '--check');
  good(preview);
  assert(preview.stdout.includes(`Restore configuration checkout from ${url} (alt): ${managed}`));
  assert.equal(existsSync(managed), false);
  good(f.cli('update', '--apply'));
  assert.equal(command('git', ['symbolic-ref', '--short', 'HEAD'], f.env, managed).stdout.trim(), 'alt');
  assert.equal(
    command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'alt'], f.env, mirror).stdout.trim(),
  );
  assert.equal(readFileSync(join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md'), 'utf8'), 'alt branch content');
  assert.equal(readJson(statePath).sourceRef, 'alt');
});

test('kitto update refuses to guess a lost checkout pinned to a tag', (t) => {
  const f = fixture(t);
  const git = (...args: string[]) => command('git', args, f.env, f.source);
  good(git('tag', 'v1'));
  const { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'v1'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config'),
    statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceRef, 'v1');
  assert.equal(readJson(statePath).deployed.detached, true);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'default branch moved on');
  commitAll(f, 'main update');
  good(command('git', ['push', join(f.temp, 'remote.git'), 'main'], f.env, f.source));
  rmSync(managed, { recursive: true });

  const refused = f.cli('update', '--apply');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pinned to a detached revision \(v1\)/);
  assert.match(refused.stderr, /rerun kitto setup/);
  assert.match(refused.stderr, /new KITTO_HOME/);
  assert.equal(existsSync(managed), false);

  const state = readJson(statePath);
  delete state.deployed;
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  for (const args of [
    ['update', '--check'],
    ['update', '--apply'],
  ]) {
    const detected = f.cli(...args);
    assert.notEqual(detected.status, 0);
    assert.match(detected.stderr, /pinned to tag v1/);
    assert.match(detected.stderr, /git -C '.*' checkout 'v1'/);
    assert.doesNotMatch(detected.stdout, /Restore configuration checkout/);
    assert.equal(existsSync(managed), false);
  }
});

test('kitto update backfills a missing sourceUrl and sourceRef from the bootstrap marker', (t) => {
  const f = fixture(t),
    { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config'),
    statePath = join(home, 'state.json');
  const legacy = readJson(statePath);
  delete legacy.sourceUrl;
  delete legacy.sourceRef;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');

  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /Recovered the configuration source from the bootstrap marker/);
  assert.equal(readJson(statePath).sourceUrl, undefined);
  good(f.cli('update', '--apply'));
  assert.equal(readJson(statePath).sourceUrl, url);
  assert.equal(readJson(statePath).sourceRef, 'main');

  rmSync(managed, { recursive: true });
  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(statePath).sourceUrl, url);
});

test('kitto update refuses a lost checkout whose recorded ref is unknown or not a Git URL', (t) => {
  const f = fixture(t),
    { url } = mirrorOf(f);
  good(f.cli('setup', '--agents', 'codex', '--source', url, '--ref', 'main'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config'),
    statePath = join(home, 'state.json');
  const legacy = readJson(statePath);
  delete legacy.sourceRef;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');
  rmSync(managed, { recursive: true });

  const unknown = f.cli('update', '--apply');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /does not record its branch or tag/);
  assert.match(unknown.stderr, /new KITTO_HOME/);
  assert.equal(existsSync(managed), false);

  const state = readJson(statePath);
  state.sourceRef = 'main';
  state.sourceUrl = '/tmp/local-config';
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const scheme = f.cli('update', '--apply');
  assert.notEqual(scheme.status, 0);
  assert.match(scheme.stderr, /not an HTTPS\/SSH Git URL/);
  assert.equal(existsSync(managed), false);
});

test('kitto update follows a changed origin and redacts credentials in messages', (t) => {
  const f = fixture(t),
    first = 'https://kitto.invalid/config.git',
    second = 'https://user:secret@kitto.invalid/config2.git';
  const { mirror } = mirrorOf(f, first, second);
  good(f.cli('setup', '--agents', 'codex', '--source', first, '--ref', 'main'));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    managed = join(home, 'config'),
    statePath = join(home, 'state.json');
  assert.equal(readJson(statePath).sourceUrl, first);
  good(command('git', ['remote', 'set-url', 'origin', second], f.env, managed));

  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(
    preview.stdout,
    /source URL changed: https:\/\/kitto\.invalid\/config\.git -> https:\/\/\*\*\*@kitto\.invalid\/config2\.git/,
  );
  assert.doesNotMatch(preview.stdout, /secret/);
  assert.equal(readJson(statePath).sourceUrl, first);

  good(f.cli('update', '--apply'));
  assert.equal(readJson(statePath).sourceUrl, second);
  assert.equal(readJson(bootstrapMarkerFor(managed)).url, second);

  rmSync(managed, { recursive: true });
  good(f.cli('update', '--apply'));
  assert.equal(existsSync(join(managed, '.git')), true);
  assert.equal(readJson(statePath).sourceUrl, second);
  assert.equal(
    command('git', ['rev-parse', 'HEAD'], f.env, managed).stdout.trim(),
    command('git', ['rev-parse', 'main'], f.env, mirror).stdout.trim(),
  );
});

test('kitto update explains a missing upstream and refuses a diverged remote', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'),
    stateBefore = readFileSync(statePath, 'utf8');
  for (const args of [['update'], ['update', '--apply']]) {
    const result = f.cli(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has no upstream/);
    assert.match(result.stderr, /--set-upstream-to/);
  }
  assert.equal(readFileSync(statePath, 'utf8'), stateBefore);

  withRemote(f);
  writeFileSync(join(f.source, 'local-only.txt'), 'local');
  commitAll(f, 'local commit');
  const other = join(f.temp, 'other');
  good(command('git', ['clone', join(f.temp, 'remote.git'), other], f.env));
  for (const args of [
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Test'],
  ])
    good(command('git', args, f.env, other));
  writeFileSync(join(other, 'remote-only.txt'), 'remote');
  for (const args of [
    ['add', '.'],
    ['commit', '-m', 'remote commit'],
    ['push', 'origin', 'main'],
  ])
    good(command('git', args, f.env, other));
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;
  const diverged = f.cli('update', '--apply');
  assert.notEqual(diverged.status, 0);
  assert.match(diverged.stderr, /have diverged/);
  assert.match(diverged.stderr, /neither is an ancestor/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, head);
});

test('kitto update allows a clean local branch that is ahead of its remote', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  writeFileSync(join(f.source, 'local-note.txt'), 'local work');
  commitAll(f, 'local ahead');
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout.trim();
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');

  const preview = f.cli('update', '--check');
  good(preview);
  assert.doesNotMatch(preview.stdout + preview.stderr, /diverged/);
  const applied = f.cli('update', '--apply');
  good(applied);
  assert.doesNotMatch(applied.stdout + applied.stderr, /diverged/);
  assert.match(applied.stdout, /is already at/);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout.trim(), head);
  assert.equal(readJson(statePath).deployed.commit, head);
});

test('kitto update preview writes neither the home, the source nor the deployment', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  withRemote(f);
  writeFileSync(join(f.source, 'skills/example/SKILL.md'), 'new remote skill');
  commitAll(f, 'remote update');
  good(command('git', ['push', 'origin', 'main'], f.env, f.source));
  const home = requireEnv(f.env, 'KITTO_HOME'),
    skill = join(requireEnv(f.env, 'PI_AGENTS_DIR'), 'skills/example/SKILL.md');
  const before = snapshot(home),
    skillBefore = readFileSync(skill, 'utf8');
  const head = command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout;

  const preview = f.cli('update');
  good(preview);
  assert.match(preview.stdout, /Configuration main: local/);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(snapshot(home), before);
  assert.equal(readFileSync(skill, 'utf8'), skillBefore);
  assert.equal(command('git', ['rev-parse', 'HEAD'], f.env, f.source).stdout, head);
  assert.equal(existsSync(join(home, '.lock')), false);
});

test('kitto update tolerates state from an older version and explains a missing local checkout', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json');
  assert.equal(readJson(statePath).sourceUrl, undefined);
  assert.equal(readJson(statePath).sourceRef, null);
  withRemote(f);
  const legacy = readJson(statePath);
  delete legacy.sourceUrl;
  delete legacy.sourceRef;
  delete legacy.pendingRuntime;
  writeFileSync(statePath, JSON.stringify(legacy, null, 2) + '\n');
  const preview = f.cli('update', '--check');
  good(preview);
  assert.match(preview.stdout, /update preview \(no writes\)/);
  good(f.cli('update', '--apply'));
  rmSync(f.source, { recursive: true });
  const lost = f.cli('update', '--apply');
  assert.notEqual(lost.status, 0);
  assert.match(lost.stderr, /no source URL was recorded/);
  assert.match(lost.stderr, /or use a new KITTO_HOME/);
  assert.equal(existsSync(join(requireEnv(f.env, 'KITTO_HOME'), 'config')), false);
});

test('kitto update refuses dirty worktrees and pinned tag checkouts before writing', (t) => {
  const f = fixture(t);
  good(f.cli('setup', '--agents', 'codex', '--source', f.source));
  const statePath = join(requireEnv(f.env, 'KITTO_HOME'), 'state.json'),
    before = readFileSync(statePath, 'utf8');
  writeFileSync(join(f.source, 'uncommitted.txt'), 'work');
  const dirty = f.cli('update', '--apply');
  assert.notEqual(dirty.status, 0);
  assert.match(dirty.stderr, /local changes/);
  assert.equal(readFileSync(join(f.source, 'uncommitted.txt'), 'utf8'), 'work');
  assert.equal(readFileSync(statePath, 'utf8'), before);
  rmSync(join(f.source, 'uncommitted.txt'));
  good(command('git', ['tag', 'v1'], f.env, f.source));
  good(command('git', ['checkout', '--detach', 'v1'], f.env, f.source));
  assert.match(f.cli('update', '--apply').stderr, /pinned to a detached revision/);
  assert.match(f.cli('update', '--check').stderr, /pinned to a detached revision/);
  assert.equal(readFileSync(statePath, 'utf8'), before);
});
