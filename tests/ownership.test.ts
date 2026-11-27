import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  forgetPending,
  get,
  isOwnedWith,
  list,
  markKept,
  markPending,
  promote,
  record,
  recordedHash,
  release,
  replaceScope,
  scopes,
} from '../lib/ownership.ts';

test('record and release a skill', () => {
  const state = {};
  record(state, 'skill', 'shared', 'review', 'h1');
  assert.deepEqual(get(state, 'skill', 'shared', 'review'), { hash: 'h1', status: 'owned' });
  assert.deepEqual(list(state, 'skill', 'shared'), [{ name: 'review', hash: 'h1', status: 'owned' }]);
  assert.equal(release(state, 'skill', 'shared', 'review'), true);
  assert.equal(release(state, 'skill', 'shared', 'review'), false);
  assert.equal(get(state, 'skill', 'shared', 'review'), undefined);
});

test('reads never create state', () => {
  const state = {};
  assert.deepEqual(list(state, 'mcp', 'codex'), []);
  assert.equal(get(state, 'mcp', 'codex', 'x'), undefined);
  assert.equal(forgetPending(state, 'mcp', 'codex', 'x'), false);
  assert.deepEqual(state, {});
});

test('pending add is forgotten without a trace', () => {
  const state = {};
  markPending(state, 'mcp', 'codex', 'docs', 'h1');
  assert.deepEqual(get(state, 'mcp', 'codex', 'docs'), { hash: 'h1', status: 'pending' });
  assert.equal(forgetPending(state, 'mcp', 'codex', 'docs'), true);
  assert.equal(get(state, 'mcp', 'codex', 'docs'), undefined);
});

test('pending update keeps the confirmed hash and reverts on forget', () => {
  const state = {};
  record(state, 'mcp', 'codex', 'docs', 'old');
  markPending(state, 'mcp', 'codex', 'docs', 'new');
  markPending(state, 'mcp', 'codex', 'docs', 'newer');
  assert.deepEqual(get(state, 'mcp', 'codex', 'docs'), { hash: 'newer', status: 'pending', previous: 'old' });
  assert.equal(recordedHash(state, 'mcp', 'codex', 'docs'), 'old');
  assert.equal(isOwnedWith(state, 'mcp', 'codex', 'docs', 'old'), false);
  assert.equal(isOwnedWith(state, 'mcp', 'codex', 'docs', 'old', { includePending: true }), true);
  assert.equal(isOwnedWith(state, 'mcp', 'codex', 'docs', 'newer', { includePending: true }), true);
  forgetPending(state, 'mcp', 'codex', 'docs');
  assert.deepEqual(get(state, 'mcp', 'codex', 'docs'), { hash: 'old', status: 'owned' });
});

test('promote finishes a pending entry and can adopt with an explicit hash', () => {
  const state = {};
  record(state, 'mcp', 'codex', 'docs', 'old');
  markPending(state, 'mcp', 'codex', 'docs', 'new');
  promote(state, 'mcp', 'codex', 'docs');
  assert.deepEqual(get(state, 'mcp', 'codex', 'docs'), { hash: 'new', status: 'owned' });
  promote(state, 'mcp', 'codex', 'adopted', 'h');
  assert.equal(isOwnedWith(state, 'mcp', 'codex', 'adopted', 'h'), true);
  assert.throws(() => promote(state, 'mcp', 'codex', 'missing'), /hash/);
});

test('kept entries are not owned and cannot shadow owned ones', () => {
  const state = {};
  markKept(state, 'skill', 'pi', 'mine');
  assert.deepEqual(get(state, 'skill', 'pi', 'mine'), { hash: null, status: 'kept' });
  assert.equal(isOwnedWith(state, 'skill', 'pi', 'mine', 'anything'), false);
  assert.equal(recordedHash(state, 'skill', 'pi', 'mine'), undefined);
  record(state, 'skill', 'pi', 'ours', 'h');
  assert.throws(() => markKept(state, 'skill', 'pi', 'ours'), /already owns/);
});

test('isOwnedWith compares the live hash', () => {
  const state = {};
  record(state, 'instructions', 'codex', 'agents-md', 'block');
  assert.equal(isOwnedWith(state, 'instructions', 'codex', 'agents-md', 'block'), true);
  assert.equal(isOwnedWith(state, 'instructions', 'codex', 'agents-md', 'edited'), false);
  assert.equal(isOwnedWith(state, 'instructions', 'codex', 'agents-md', undefined), false);
});

test('replaceScope mirrors a deploy pass and lets owned win over kept', () => {
  const state = {};
  record(state, 'skill', 'shared', 'stale', 'x');
  replaceScope(state, 'skill', 'shared', { owned: { a: 'h1' }, kept: ['b', 'a'] });
  assert.deepEqual(list(state, 'skill', 'shared'), [
    { name: 'a', hash: 'h1', status: 'owned' },
    { name: 'b', hash: null, status: 'kept' },
  ]);
  assert.deepEqual(
    list(state, 'skill', 'shared', 'kept').map((entry) => entry.name),
    ['b'],
  );
  replaceScope(state, 'skill', 'pi');
  assert.deepEqual(scopes(state, 'skill'), ['shared', 'pi']);
});

test('invalid addresses are rejected', () => {
  const state = {};
  assert.throws(() => record(state, 'widget', 'shared', 'a', 'h'), /Unknown ownership kind/);
  assert.throws(() => record(state, 'skill', '', 'a', 'h'), /scope/);
  assert.throws(() => record(state, 'skill', 'shared', '__proto__', 'h'), /name/);
  assert.throws(() => record(state, 'skill', 'shared', 'a', ''), /hash/);
  assert.deepEqual(state, {});
});
